import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import type { Engine } from './engine.js';
import { computeSignals, rankTokens, summarize } from './scoring.js';

const DISCLAIMER =
  'Scores describe CURRENT on-chain momentum and rug-risk signals. They do not predict future price; most pump.fun tokens go to zero.';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

const Mint = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Must be a base58 Solana mint address');

// Only strategy/exit knobs may be overridden from chat — never secrets, paths or NODE_* vars.
const BACKTEST_KEYS = /^(EG_[A-Z0-9_]+|TAKE_PROFIT_PCT|TAKE_PROFIT_SELL_PCT|STOP_LOSS_PCT|TRAILING_STOP_PCT|MAX_HOLD_MINUTES|EXIT_ON_CREATOR_SELL|AUTO_BUY_SOL|MAX_SOL_PER_TRADE|MAX_DAILY_SOL|MAX_OPEN_POSITIONS|REBUY_COOLDOWN_MINUTES|PAPER_FEE_PCT|PAPER_IMPACT_PCT|AUTO_STRATEGY|AUTO_MIN_SCORE)$/;
let backtestRunning = false;

function runBacktest(opts: { hours: number; overrides: Record<string, string>; entryDelayMs: number; ignoreLimits: boolean }): Promise<unknown> {
  const script = join(fileURLToPath(new URL('.', import.meta.url)), 'backtest.js');
  const data = join(config.dataDir, 'recordings');
  if (!existsSync(data)) return Promise.reject(new Error('No recordings yet. Keep RECORD_STREAM=true and let the server run for a few hours.'));
  const set: Record<string, string> = { ...opts.overrides };
  if (opts.ignoreLimits) Object.assign(set, { MAX_DAILY_SOL: '100000', MAX_OPEN_POSITIONS: '1000', PAPER_STARTING_SOL: '100000' });
  const args = ['--child', '--quiet', '--data', data, '--entry-delay', String(opts.entryDelayMs), '--from', new Date(Date.now() - opts.hours * 3600_000).toISOString()];
  for (const [k, v] of Object.entries(set)) args.push('--set', `${k}=${v}`);
  return new Promise((resolve, reject) => {
    const child = fork(script, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, DATA_DIR: join(config.dataDir, 'backtest-tmp') } });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()!));
      } catch {
        reject(new Error(`Backtest failed (exit ${code}): ${err.slice(-400) || 'no output'}`));
      }
    });
  });
}

export function buildServer(engine: Engine): McpServer {
  const { collector, price, trader, strategy, journal } = engine;
  const server = new McpServer({ name: 'pumpfun-trader', version: '3.0.0' });
  const live = config.tradingMode === 'live';
  const liveNote = live
    ? ' LIVE MODE: this spends real SOL from the server wallet — always confirm the exact token and amount with the user before calling.'
    : ' Paper mode: simulated fills, no real funds.';

  // =========================================================== scanner

  server.registerTool(
    'scanner_status',
    {
      title: 'Scanner status',
      description: 'Health of the live pump.fun stream: connection state, tokens tracked, events processed, uptime.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = collector.stats;
      return json({
        connected: s.connected,
        uptimeMinutes: Math.round((Date.now() - s.startedAt) / 60_000),
        secondsSinceLastMessage: s.lastMessageAt ? Math.round((Date.now() - s.lastMessageAt) / 1000) : null,
        tokensTracked: collector.tokens.size,
        creates: s.creates,
        trades: s.trades,
        migrations: s.migrations,
        reconnects: s.reconnects,
        solUsd: price.price,
        tradingMode: config.tradingMode,
      });
    },
  );

  server.registerTool(
    'get_momentum_leaders',
    {
      title: 'Momentum leaders',
      description:
        'Rank tracked pump.fun tokens by a 0-100 momentum/health score (net buy flow, acceleration, unique buyers, holder distribution, curve progress, minus rug-risk penalties). ' +
        DISCLAIMER,
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10),
        minScore: z.number().min(0).max(100).default(50),
        minAgeSeconds: z.number().min(0).default(60),
        maxAgeMinutes: z.number().min(1).default(120),
        excludeRisky: z.boolean().default(true),
        includeMigrated: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      json({
        generatedAt: new Date().toISOString(),
        tokensScanned: collector.tokens.size,
        results: rankTokens(collector.tokens.values(), args, price.price).map(summarize),
        disclaimer: DISCLAIMER,
      }),
  );

  server.registerTool(
    'get_token_signals',
    {
      title: 'Token signals',
      description: 'Full signal breakdown for one tracked token: windows, flow, holders, creator behaviour, score components and risk flags.',
      inputSchema: { mint: Mint },
      annotations: { readOnlyHint: true },
    },
    async ({ mint }) => {
      const tok = collector.tokens.get(mint);
      if (!tok) return fail(`Token ${mint} is not tracked. Use watch_token to start tracking it.`);
      return json({ ...computeSignals(tok, Date.now(), price.price), disclaimer: DISCLAIMER });
    },
  );

  server.registerTool(
    'get_new_tokens',
    {
      title: 'New launches',
      description: 'Most recent pump.fun launches seen on the stream, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      json(
        [...collector.tokens.values()]
          .filter((t) => t.seenCreate)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit)
          .map((t) => ({
            mint: t.mint,
            symbol: t.symbol,
            name: t.name,
            ageSeconds: Math.round((Date.now() - t.createdAt) / 1000),
            mcapSol: Math.round(t.mcapSol * 100) / 100,
            trades: t.trades.length,
            uniqueBuyers: t.buyers.size,
            creatorSold: t.creatorSold,
            pumpfun: `https://pump.fun/coin/${t.mint}`,
          })),
      ),
  );

  server.registerTool(
    'get_recent_migrations',
    {
      title: 'Recent graduations',
      description: 'Tokens that completed the bonding curve and migrated to an AMM pool, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      json(
        collector.migrations
          .slice(-limit)
          .reverse()
          .map((m) => ({ ...m, at: new Date(m.t).toISOString(), dexscreener: `https://dexscreener.com/solana/${m.mint}` })),
      ),
  );

  server.registerTool(
    'watch_token',
    {
      title: 'Watch token',
      description: 'Start (or pin) tracking a token by mint. Watched tokens are never pruned. History starts from now.',
      inputSchema: { mint: Mint },
    },
    async ({ mint }) => {
      const tok = collector.watch(mint);
      return json({ watching: mint, partialHistory: !tok.seenCreate });
    },
  );

  server.registerTool(
    'unwatch_token',
    {
      title: 'Unwatch token',
      description: 'Unpin a watched token so normal pruning applies again.',
      inputSchema: { mint: Mint },
    },
    async ({ mint }) => (collector.unwatch(mint) ? json({ unwatched: mint }) : fail(`Token ${mint} is not tracked.`)),
  );

  server.registerTool(
    'rugcheck_token',
    {
      title: 'RugCheck report',
      description: 'Fetch the RugCheck.xyz risk summary (mint/freeze authority, LP, top holders, known risks) for a Solana token.',
      inputSchema: { mint: Mint },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ mint }) => {
      try {
        const res = await fetch(`${config.rugcheckBaseUrl}/tokens/${mint}/report/summary`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return fail(`RugCheck returned HTTP ${res.status}`);
        return json(await res.json());
      } catch (e) {
        return fail(`RugCheck request failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'get_token_metadata',
    {
      title: 'Token metadata',
      description: 'Description, image and twitter/telegram/website from the token metadata URI (launches seen on the stream only).',
      inputSchema: { mint: Mint },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ mint }) => {
      const tok = collector.tokens.get(mint);
      if (!tok?.uri) return fail('No metadata URI known for this token.');
      try {
        const res = await fetch(tok.uri, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return fail(`Metadata fetch returned HTTP ${res.status}`);
        const m = (await res.json()) as Record<string, unknown>;
        return json({
          mint,
          name: m.name,
          symbol: m.symbol,
          description: m.description,
          image: m.image,
          twitter: m.twitter ?? null,
          telegram: m.telegram ?? null,
          website: m.website ?? null,
          hasSocials: Boolean(m.twitter || m.telegram || m.website),
        });
      } catch (e) {
        return fail(`Metadata fetch failed: ${(e as Error).message}`);
      }
    },
  );

  // =========================================================== early-gainer strategy

  server.registerTool(
    'get_early_gainers',
    {
      title: 'Early gainers (volume surge strategy)',
      description:
        'Tokens currently triggering the early-gainer strategy: volume well above their own baseline, a burst of new buyer wallets, buy pressure, breakout above the recent high, holder growth — after rug/distribution filters. ' +
        'Set includeNearMisses to also see tokens failing 1-2 gates (shown with failedGates). ' +
        DISCLAIMER,
      inputSchema: {
        limit: z.number().int().min(1).max(30).default(10),
        includeNearMisses: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, includeNearMisses }) =>
      json({ generatedAt: new Date().toISOString(), results: strategy.candidates({ limit, includeNearMisses }), disclaimer: DISCLAIMER }),
  );

  server.registerTool(
    'evaluate_early_gainer',
    {
      title: 'Evaluate one token (early-gainer)',
      description: 'Run the early-gainer strategy on one tracked token and show every metric, score component and failed gate.',
      inputSchema: { mint: Mint },
      annotations: { readOnlyHint: true },
    },
    async ({ mint }) => {
      const ev = strategy.evaluateMint(mint);
      return ev ? json(ev) : fail('Token not tracked or has no trades yet. Use watch_token first.');
    },
  );

  server.registerTool(
    'get_strategy_performance',
    {
      title: 'Strategy performance',
      description:
        'How past early-gainer signals actually played out: hit rates (+50/+100/+300%), median peak, average return after 15/60 min, how often the stop loss would have hit first, and a rough simulated P&L per trade using the current exit rules. Use this before going live.',
      inputSchema: { sinceHours: z.number().min(1).max(24 * 30).default(72) },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceHours }) => {
      const rules = trader.defaultRules();
      return json(journal.performance(sinceHours, { takeProfitPct: rules.takeProfitPct, stopLossPct: rules.stopLossPct }));
    },
  );

  server.registerTool(
    'get_signal_journal',
    {
      title: 'Signal journal',
      description: 'Recent early-gainer signals with entry market cap, score, whether a trade was taken, and the outcome (peak, low, mcap at +5/+15/+60 min).',
      inputSchema: { limit: z.number().int().min(1).max(200).default(20) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      json(
        journal.entries
          .slice(-limit)
          .reverse()
          .map((e) => ({
            symbol: e.symbol,
            mint: e.mint,
            at: new Date(e.t).toISOString(),
            score: e.score,
            entryMcapSol: e.entryMcapSol,
            traded: e.traded,
            done: e.outcome.done,
            peakGainPct: Math.round((e.outcome.peakMcapSol / e.entryMcapSol - 1) * 1000) / 10,
            peakAtMin: e.outcome.peakAtMin,
            worstPct: Math.round((e.outcome.lowOverallSol / e.entryMcapSol - 1) * 1000) / 10,
            after15mPct: e.outcome.mcap15m ? Math.round((e.outcome.mcap15m / e.entryMcapSol - 1) * 1000) / 10 : null,
            after60mPct: e.outcome.mcap60m ? Math.round((e.outcome.mcap60m / e.entryMcapSol - 1) * 1000) / 10 : null,
          })),
      ),
  );

  server.registerTool(
    'get_strategy_config',
    {
      title: 'Strategy config',
      description: 'Current early-gainer thresholds (set in .env, EG_* variables) and which strategy drives auto-trading.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json({ autoStrategy: config.autoStrategy, earlyGainer: config.eg }),
  );

  server.registerTool(
    'run_backtest',
    {
      title: 'Run backtest',
      description:
        'Replay the server\'s own recorded pump.fun stream (data/recordings) through the same strategy, risk limits and exits, with entry delay, fees and slippage. ' +
        'Optionally override strategy/exit settings (EG_*, TAKE_PROFIT_PCT, STOP_LOSS_PCT, TRAILING_STOP_PCT, MAX_HOLD_MINUTES, …) to compare variants. ' +
        'Set ignoreLimits to measure the strategy on every signal instead of only the ones the daily/open-position limits allow. Can take several minutes for long windows.',
      inputSchema: {
        hours: z.number().min(1).max(24 * 14).default(24),
        overrides: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
        entryDelayMs: z.number().min(0).max(60_000).default(3000),
        ignoreLimits: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ hours, overrides, entryDelayMs, ignoreLimits }) => {
      const bad = Object.keys(overrides).filter((k) => !BACKTEST_KEYS.test(k));
      if (bad.length) return fail(`Not allowed to override: ${bad.join(', ')}`);
      if (backtestRunning) return fail('A backtest is already running — wait for it to finish.');
      backtestRunning = true;
      try {
        const str = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, String(v)]));
        const summary = await runBacktest({ hours, overrides: str, entryDelayMs, ignoreLimits });
        return json({
          summary,
          caution: 'Backtests on recorded data are optimistic (real fills, failed txs and RPC delays are worse). Confirm improvements on a different time window before changing live settings.',
        });
      } catch (e) {
        return fail((e as Error).message);
      } finally {
        backtestRunning = false;
      }
    },
  );

  // =========================================================== trading

  server.registerTool(
    'trading_status',
    {
      title: 'Trading status',
      description: 'Mode (paper/live), wallet address and SOL balance, kill switch, auto-trading state, hard limits, spend today, realized P&L today.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await trader.status()),
  );

  server.registerTool(
    'buy_token',
    {
      title: 'Buy token',
      description:
        `Buy a pump.fun token with SOL. Server-side hard limits apply (max per trade ${config.maxSolPerTrade} SOL, max per day ${config.maxDailySol} SOL, max ${config.maxOpenPositions} open positions, wallet reserve, re-buy cooldown). ` +
        'Default exit rules (take profit, stop loss, trailing stop, max hold) are attached automatically.' +
        liveNote,
      inputSchema: {
        mint: Mint,
        solAmount: z.number().positive().max(config.maxSolPerTrade),
        slippagePct: z.number().min(0.5).max(config.maxSlippagePct).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ mint, solAmount, slippagePct }) => {
      const res = await trader.buy({ mint, sol: solAmount, slippagePct, source: 'manual' });
      return res.ok ? json({ bought: true, position: res.data }) : fail(`Buy rejected: ${res.error}`);
    },
  );

  server.registerTool(
    'sell_token',
    {
      title: 'Sell token',
      description: 'Sell a percentage (1-100) of an open position.' + liveNote,
      inputSchema: {
        mint: Mint,
        percent: z.number().min(1).max(100).default(100),
        slippagePct: z.number().min(0.5).max(config.maxSlippagePct).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ mint, percent, slippagePct }) => {
      const res = await trader.sell(mint, percent, 'manual', slippagePct);
      return res.ok ? json({ sold: true, position: res.data }) : fail(`Sell failed: ${res.error}`);
    },
  );

  server.registerTool(
    'get_positions',
    {
      title: 'Open positions',
      description: 'Open positions with live P&L %, estimated value, peak gain and attached exit rules.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(trader.positionsView()),
  );

  server.registerTool(
    'get_trade_history',
    {
      title: 'Trade history',
      description: 'Recent buys and sells (including failed attempts), newest first.',
      inputSchema: { limit: z.number().int().min(1).max(200).default(25) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => json(trader.history(limit)),
  );

  server.registerTool(
    'set_exit_rules',
    {
      title: 'Set exit rules',
      description:
        'Change exit rules for one open position (pass mint) or the defaults for future positions (omit mint). Percentages are relative to entry price.',
      inputSchema: {
        mint: Mint.optional(),
        takeProfitPct: z.number().min(5).max(10_000).optional(),
        takeProfitSellPct: z.number().min(1).max(100).optional(),
        stopLossPct: z.number().min(1).max(95).optional(),
        trailingStopPct: z.number().min(1).max(95).optional(),
        maxHoldMinutes: z.number().min(1).max(7 * 24 * 60).optional(),
        exitOnCreatorSell: z.boolean().optional(),
      },
    },
    async ({ mint, ...patch }) => {
      const res = trader.setRules(patch, mint);
      return res.ok ? json({ scope: mint ?? 'defaults', rules: res.data }) : fail(res.error);
    },
  );

  server.registerTool(
    'set_auto_trading',
    {
      title: 'Auto-trading on/off',
      description:
        (config.autoStrategy === 'early_gainer'
          ? `Enable or disable automatic buying on every early-gainer signal (score ≥ ${config.eg.minScore}, ${Math.min(config.autoBuySol, config.maxSolPerTrade)} SOL each).`
          : `Enable or disable automatic buying of top-scoring tokens (score ≥ ${config.autoMinScore}, ${Math.min(config.autoBuySol, config.maxSolPerTrade)} SOL each).`) +
        ' All hard limits still apply. Only works if the server has AUTO_TRADE_ALLOWED=true.' +
        liveNote,
      inputSchema: { enabled: z.boolean() },
      annotations: { destructiveHint: true },
    },
    async ({ enabled }) => {
      const res = trader.setAuto(enabled);
      return res.ok ? json(res.data) : fail(res.error);
    },
  );

  server.registerTool(
    'kill_switch',
    {
      title: 'Kill switch',
      description: 'Turn the kill switch on (blocks ALL new buys, disables auto-trading) or off. Optionally market-sell every open position.',
      inputSchema: { enabled: z.boolean(), sellAll: z.boolean().default(false) },
      annotations: { destructiveHint: true },
    },
    async ({ enabled, sellAll }) => {
      trader.setKillSwitch(enabled);
      const sold = sellAll ? await trader.sellAll('kill switch') : [];
      return json({ killSwitch: enabled, sold });
    },
  );

  return server;
}
