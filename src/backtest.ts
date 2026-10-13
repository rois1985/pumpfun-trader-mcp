#!/usr/bin/env node
/**
 * Replay backtester. Feeds recorded PumpPortal stream files through the SAME collector,
 * early-gainer strategy, journal, risk checks and exit logic used live, on a simulated clock.
 *
 *   npm run backtest -- --data data/recordings
 *   npm run backtest -- --set EG_MIN_REL_VOL=4 --set STOP_LOSS_PCT=20
 *   npm run backtest -- --sweep EG_MIN_REL_VOL=2,3,5 --sweep STOP_LOSS_PCT=20,30,40
 *
 * See docs/BACKTESTING.md.
 */
import { fork } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

// ---------------------------------------------------------------- args

interface Args {
  data: string;
  from?: number;
  to?: number;
  set: Record<string, string>;
  sweep: Record<string, string[]>;
  entryDelayMs: number;
  out: string;
  child: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { data: 'data/recordings', set: {}, sweep: {}, entryDelayMs: 3000, out: 'backtest-results', child: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const val = argv[++i];
      if (val === undefined) throw new Error(`Missing value for ${k}`);
      return val;
    };
    if (k === '--data') a.data = v();
    else if (k === '--from') a.from = Date.parse(v());
    else if (k === '--to') a.to = Date.parse(v());
    else if (k === '--entry-delay') a.entryDelayMs = Number(v());
    else if (k === '--out') a.out = v();
    else if (k === '--child') a.child = true;
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--set') {
      const [key, ...rest] = v().split('=');
      a.set[key] = rest.join('=');
    } else if (k === '--sweep') {
      const [key, vals] = v().split('=');
      a.sweep[key] = vals.split(',').map((x) => x.trim()).filter(Boolean);
    } else if (k === '--help' || k === '-h') {
      console.log(
        'Usage: npm run backtest -- [--data dir|file] [--from ISO] [--to ISO] [--set KEY=VAL]... [--sweep KEY=v1,v2]... [--entry-delay ms] [--out dir]',
      );
      process.exit(0);
    } else throw new Error(`Unknown argument ${k}`);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

function isSynthetic(path: string): boolean {
  const p = resolve(path);
  return existsSync(join(statSync(p).isFile() ? resolve(p, '..') : p, 'SYNTHETIC'));
}

function listFiles(path: string): string[] {
  const p = resolve(path);
  if (!existsSync(p)) throw new Error(`No recordings at ${p}. Run the server with RECORD_STREAM=true first.`);
  if (statSync(p).isFile()) return [p];
  return readdirSync(p)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'))
    .sort()
    .map((f) => join(p, f));
}

// ---------------------------------------------------------------- sweep (parent)

if (Object.keys(args.sweep).length && !args.child) {
  const keys = Object.keys(args.sweep);
  let combos: Record<string, string>[] = [{}];
  for (const k of keys) combos = combos.flatMap((c) => args.sweep[k].map((v) => ({ ...c, [k]: v })));
  if (combos.length > 300) throw new Error(`${combos.length} combinations — keep sweeps under 300.`);
  console.error(`Sweep: ${combos.length} combinations over ${keys.join(', ')}`);

  const self = fileURLToPath(import.meta.url);
  const results: { params: Record<string, string>; summary: Summary }[] = [];
  const parallel = Math.max(1, Math.min(combos.length, cpus().length - 1));
  let next = 0;
  let done = 0;

  const runOne = (params: Record<string, string>) =>
    new Promise<void>((res) => {
      const childArgs = ['--child', '--quiet', '--data', args.data, '--entry-delay', String(args.entryDelayMs)];
      if (args.from) childArgs.push('--from', new Date(args.from).toISOString());
      if (args.to) childArgs.push('--to', new Date(args.to).toISOString());
      for (const [k, v] of Object.entries({ ...args.set, ...params })) childArgs.push('--set', `${k}=${v}`);
      const child = fork(self, childArgs, { stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
      let out = '';
      child.stdout!.on('data', (d) => (out += d));
      child.on('exit', () => {
        try {
          const summary = JSON.parse(out.trim().split('\n').pop()!) as Summary;
          results.push({ params, summary });
        } catch {
          console.error('combination failed:', params);
        }
        done++;
        console.error(`  ${done}/${combos.length} ${JSON.stringify(params)}`);
        res();
      });
    });

  const workers = Array.from({ length: parallel }, async () => {
    while (next < combos.length) await runOne(combos[next++]);
  });
  await Promise.all(workers);

  results.sort((a, b) => b.summary.totalPnlSol - a.summary.totalPnlSol);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(args.out, { recursive: true });
  const md = [
    `# Backtest sweep — ${stamp}`,
    '',
    isSynthetic(args.data) ? '> ⚠️ **SYNTHETIC DATA** — proves the sweep works; numbers are meaningless for real markets.\n' : '',
    `Data: \`${args.data}\` · entry delay ${args.entryDelayMs} ms · ${results.length} combinations · base overrides: ${JSON.stringify(args.set)}`,
    '',
    `| Rank | ${keys.join(' | ')} | Trades | Win % | P&L SOL | Avg trade % | Profit factor | Max DD SOL | Signals |`,
    `|---|${keys.map(() => '---').join('|')}|---|---|---|---|---|---|---|`,
    ...results.map(
      (r, i) =>
        `| ${i + 1} | ${keys.map((k) => r.params[k]).join(' | ')} | ${r.summary.trades} | ${r.summary.winRatePct} | ${r.summary.totalPnlSol} | ${r.summary.avgTradePct} | ${r.summary.profitFactor ?? '—'} | ${r.summary.maxDrawdownSol} | ${r.summary.signals} |`,
    ),
    '',
    '> Beware overfitting: the best row on one dataset is often average on the next. Confirm on a different date range before using it.',
  ].join('\n');
  writeFileSync(join(args.out, `sweep-${stamp}.md`), md);
  writeFileSync(join(args.out, `sweep-${stamp}.json`), JSON.stringify(results, null, 2));
  console.log(md);
  console.error(`\nSaved to ${args.out}/sweep-${stamp}.md`);
  process.exit(0);
}

// ---------------------------------------------------------------- single run

process.env.BACKTEST = '1';
process.env.TRADING_MODE = 'paper';
process.env.AUTO_TRADE_ALLOWED = 'true';
process.env.RECORD_STREAM = 'false';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';
for (const [k, v] of Object.entries(args.set)) process.env[k] = v;
// engine modules log via console.error; keep the report output clean (progress uses process.stderr.write)
if (args.quiet || !process.env.BACKTEST_VERBOSE) console.error = () => {};

const { config } = await import('./config.js');
const { setSimulatedTime } = await import('./clock.js');
const { PumpCollector } = await import('./collector.js');
const { Trader } = await import('./trader.js');
const { EarlyGainerStrategy } = await import('./strategy.js');
const { SignalJournal } = await import('./journal.js');
type EarlyGainerEval = import('./strategy.js').EarlyGainerEval;
type SolPriceFeed = import('./price.js').SolPriceFeed;

interface Summary {
  synthetic: boolean;
  dataset: { files: number; events: number; from: string | null; to: string | null; hours: number };
  signals: number;
  trades: number;
  wins: number;
  winRatePct: number;
  totalPnlSol: number;
  totalSpentSol: number;
  returnOnDeployedPct: number;
  avgTradePct: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number | null;
  bestTradePct: number;
  worstTradePct: number;
  avgHoldMinutes: number;
  maxDrawdownSol: number;
  exitReasons: Record<string, number>;
  rejectedBuys: Record<string, number>;
  journal: unknown;
  settings: Record<string, unknown>;
}

const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

async function run(): Promise<Summary> {
  const files = listFiles(args.data);
  if (!files.length) throw new Error('No .jsonl / .jsonl.gz files found');

  const collector = new PumpCollector();
  const price = { price: null } as unknown as SolPriceFeed;
  const trader = new Trader(collector, price);
  const strategy = new EarlyGainerStrategy(collector, price);
  const journal = new SignalJournal(collector);
  trader.setAuto(true);

  const pendingBuys: { due: number; ev: EarlyGainerEval }[] = [];
  const notTraded: Record<string, number> = {};
  let signals = 0;
  strategy.on('signal', (ev: EarlyGainerEval) => {
    signals++;
    journal.record(ev);
    pendingBuys.push({ due: tickTime + args.entryDelayMs, ev });
  });

  // simulated scheduler — same cadences as live
  const cadence = { exits: 2000, auto: 10_000, scan: 5000, sample: 15_000, journal: 10_000, prune: 30_000 };
  const nextAt: Record<keyof typeof cadence, number> = { exits: 0, auto: 0, scan: 0, sample: 0, journal: 0, prune: 0 };
  let tickTime = 0;

  async function advanceTo(t: number) {
    for (;;) {
      const [key, at] = (Object.entries(nextAt) as [keyof typeof cadence, number][]).reduce((m, e) => (e[1] < m[1] ? e : m));
      const buyDue = pendingBuys.length ? Math.min(...pendingBuys.map((p) => p.due)) : Infinity;
      if (Math.min(at, buyDue) > t) break;
      if (buyDue <= at) {
        tickTime = buyDue;
        setSimulatedTime(tickTime);
        const ready = pendingBuys.filter((p) => p.due <= tickTime);
        for (const p of ready) {
          pendingBuys.splice(pendingBuys.indexOf(p), 1);
          const res = await trader.onStrategySignal(p.ev);
          if (res?.ok) journal.markTraded(p.ev.mint);
          else if (res && !res.ok) {
            const k = res.error.split(/[—(]/)[0].trim().slice(0, 60);
            notTraded[k] = (notTraded[k] ?? 0) + 1;
          }
        }
        continue;
      }
      tickTime = at;
      setSimulatedTime(tickTime);
      nextAt[key] = at + cadence[key];
      if (key === 'exits') await trader.exitLoop();
      else if (key === 'auto') await trader.autoLoop();
      else if (key === 'scan') strategy.scan();
      else if (key === 'sample') strategy.sample();
      else if (key === 'journal') journal.track();
      else if (key === 'prune') collector.prune();
    }
    tickTime = t;
    setSimulatedTime(t);
  }

  let events = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const file of files) {
    const input = file.endsWith('.gz') ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
    const rl = createInterface({ input, crlfDelay: Infinity });
    if (!args.quiet) process.stderr.write(`replaying ${basename(file)}\n`);
    for await (const line of rl) {
      if (!line) continue;
      let rec: { ts: number; m: unknown };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (args.from && rec.ts < args.from) continue;
      if (args.to && rec.ts > args.to) break;
      if (first === null) {
        first = rec.ts;
        for (const k of Object.keys(nextAt) as (keyof typeof cadence)[]) nextAt[k] = rec.ts + cadence[k];
      }
      await advanceTo(rec.ts);
      collector.ingestEvent(rec.m as never);
      last = rec.ts;
      events++;
    }
  }
  if (first === null || last === null) throw new Error('No events in the selected range');

  // let open trades and journal entries run out to the end of data, then close what is left
  await advanceTo(last + 1);
  for (const p of trader.openPositions()) await trader.sell(p.mint, 100, 'end of data');
  journal.track();

  // ---- stats
  const closed = trader.state.positions.filter((p) => p.status === 'closed').sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const pnls = closed.map((p) => p.solReceived - p.solSpent);
  const pcts = closed.map((p) => (p.solReceived / p.solSpent - 1) * 100);
  const wins = pnls.filter((x) => x > 0);
  const losses = pnls.filter((x) => x <= 0);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const x of pnls) {
    equity += x;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const exitReasons: Record<string, number> = {};
  for (const p of closed) {
    const reason = p.closeReason ?? 'unknown';
    const label = ['max hold', 'trailing stop', 'stop loss', 'take profit', 'creator sold', 'end of data'].find((x) => reason.startsWith(x)) ?? reason;
    exitReasons[label] = (exitReasons[label] ?? 0) + 1;
  }
  // partial take-profits close via a later reason; count TP hits separately
  const tpHits = closed.filter((p) => p.takeProfitHit).length;
  if (tpHits) exitReasons['(take profit partial hit)'] = tpHits;
  const rejectedBuys: Record<string, number> = { ...notTraded };
  for (const h of trader.state.history.filter((h) => h.side === 'buy' && !h.ok)) {
    const k = (h.error ?? 'unknown').split(/[—(]/)[0].trim().slice(0, 60);
    rejectedBuys[k] = (rejectedBuys[k] ?? 0) + 1;
  }
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const spent = sum(closed.map((p) => p.solSpent));
  const rules = trader.defaultRules();

  return {
    synthetic: isSynthetic(args.data),
    dataset: {
      files: files.length,
      events,
      from: new Date(first).toISOString(),
      to: new Date(last).toISOString(),
      hours: r((last - first) / 3600_000, 1),
    },
    signals,
    trades: closed.length,
    wins: wins.length,
    winRatePct: closed.length ? r((wins.length / closed.length) * 100, 1) : 0,
    totalPnlSol: r(sum(pnls), 4),
    totalSpentSol: r(spent, 4),
    returnOnDeployedPct: spent ? r((sum(pnls) / spent) * 100, 1) : 0,
    avgTradePct: pcts.length ? r(sum(pcts) / pcts.length, 1) : 0,
    avgWinPct: wins.length ? r(sum(pcts.filter((x) => x > 0)) / wins.length, 1) : 0,
    avgLossPct: losses.length ? r(sum(pcts.filter((x) => x <= 0)) / losses.length, 1) : 0,
    profitFactor: losses.length && sum(losses) !== 0 ? r(sum(wins) / Math.abs(sum(losses)), 2) : null,
    bestTradePct: pcts.length ? r(Math.max(...pcts), 1) : 0,
    worstTradePct: pcts.length ? r(Math.min(...pcts), 1) : 0,
    avgHoldMinutes: closed.length ? r(sum(closed.map((p) => ((p.closedAt ?? 0) - p.openedAt) / 60_000)) / closed.length, 1) : 0,
    maxDrawdownSol: r(maxDd, 4),
    exitReasons,
    rejectedBuys,
    journal: journal.performance(100_000, { takeProfitPct: rules.takeProfitPct, stopLossPct: rules.stopLossPct }),
    settings: {
      entryDelayMs: args.entryDelayMs,
      paperFeePct: config.paperFeePct,
      paperImpactPct: config.paperImpactPct,
      autoBuySol: Math.min(config.autoBuySol, config.maxSolPerTrade),
      maxDailySol: config.maxDailySol,
      maxOpenPositions: config.maxOpenPositions,
      exits: rules,
      earlyGainer: config.eg,
      overrides: args.set,
    },
  };
}

function toMarkdown(s: Summary): string {
  const j = s.journal as Record<string, unknown> & { peakGain?: Record<string, number> };
  return [
    `# Backtest report`,
    '',
    s.synthetic ? '> ⚠️ **SYNTHETIC DATA** — this run only proves the backtester works. The numbers below say nothing about real pump.fun markets.\n' : '',
    `**Data:** ${s.dataset.files} file(s), ${s.dataset.events.toLocaleString()} events, ${s.dataset.from} → ${s.dataset.to} (${s.dataset.hours} h)  `,
    `**Entry delay:** ${s.settings.entryDelayMs} ms · **Fees:** ${s.settings.paperFeePct}% · **Impact/slippage:** ${s.settings.paperImpactPct}% per side · **Size:** ${s.settings.autoBuySol} SOL`,
    Object.keys(s.settings.overrides as object).length ? `**Overrides:** \`${JSON.stringify(s.settings.overrides)}\`` : '',
    '',
    '## Trading results',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Signals | ${s.signals} |`,
    `| Trades | ${s.trades} |`,
    `| Win rate | ${s.winRatePct}% |`,
    `| Total P&L | **${s.totalPnlSol} SOL** |`,
    `| Return on SOL deployed | ${s.returnOnDeployedPct}% |`,
    `| Average trade | ${s.avgTradePct}% |`,
    `| Average win / loss | ${s.avgWinPct}% / ${s.avgLossPct}% |`,
    `| Profit factor | ${s.profitFactor ?? '—'} |`,
    `| Best / worst trade | ${s.bestTradePct}% / ${s.worstTradePct}% |`,
    `| Average hold | ${s.avgHoldMinutes} min |`,
    `| Max drawdown | ${s.maxDrawdownSol} SOL |`,
    '',
    '## Exit reasons',
    '',
    ...Object.entries(s.exitReasons).map(([k, v]) => `- ${k}: ${v}`),
    '',
    Object.keys(s.rejectedBuys).length ? '## Signals not traded (risk limits)\n\n' + Object.entries(s.rejectedBuys).map(([k, v]) => `- ${k}: ${v}`).join('\n') + '\n' : '',
    '## Signal quality (journal, independent of trading)',
    '',
    j.peakGain
      ? [
          `- Completed signals: ${j.signals}`,
          `- Median peak gain: ${j.peakGain.median}%`,
          `- Reached +50% / +100% / +300%: ${j.peakGain.hitPlus50Pct}% / ${j.peakGain.hitPlus100Pct}% / ${j.peakGain.hitPlus300Pct}%`,
          `- Never went above entry: ${j.peakGain.neverAboveEntryPct}%`,
          `- Stop loss would hit before peak: ${j.stopLossHitBeforePeakPct}%`,
        ].join('\n')
      : `- ${JSON.stringify(j)}`,
    '',
    '> Backtests on recorded data are optimistic: real fills on thin bonding curves, failed transactions and RPC delays are worse than simulated. Treat a marginal result as negative.',
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const summary = await run();
if (args.child) {
  process.stdout.write(JSON.stringify(summary) + '\n');
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(args.out, { recursive: true });
  const md = toMarkdown(summary);
  writeFileSync(join(args.out, `backtest-${stamp}.md`), md);
  writeFileSync(join(args.out, `backtest-${stamp}.json`), JSON.stringify(summary, null, 2));
  console.log(md);
  process.stderr.write(`\nSaved to ${args.out}/backtest-${stamp}.md\n`);
}
process.exit(0);
