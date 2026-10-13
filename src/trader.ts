import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { PumpCollector } from './collector.js';
import type { SolPriceFeed } from './price.js';
import { LiveExecutor, PaperExecutor, type Executor } from './executor.js';
import { computeSignals, rankTokens } from './scoring.js';
import { loadState, saveState, today } from './store.js';
import { sendTelegram } from './alerts.js';
import type { ExitRules, PersistedState, Position, TradeRecord } from './types.js';
import { now as nowMs } from './clock.js';

const log = (...a: unknown[]) => console.error('[trader]', ...a);
const r = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export class Trader {
  readonly state: PersistedState;
  readonly executor: Executor;
  private busy = new Set<string>();
  private retryAt = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private collector: PumpCollector,
    private price: SolPriceFeed,
  ) {
    this.state = loadState();
    if (!config.autoTradeAllowed) this.state.autoEnabled = false;
    this.executor =
      config.tradingMode === 'live' ? new LiveExecutor() : new PaperExecutor(() => this.state.paperBalanceSol);
    // positions may have been "selling" when we crashed — reopen them so exits resume
    for (const p of this.state.positions) if (p.status === 'selling') p.status = 'open';
    for (const p of this.openPositions()) this.collector.pin(p.mint, 'position');
    log(`mode=${this.executor.mode} open=${this.openPositions().length} kill=${this.state.killSwitch} auto=${this.state.autoEnabled}`);
  }

  start(): void {
    this.timers.push(setInterval(() => void this.exitLoop(), 2000));
    this.timers.push(setInterval(() => void this.autoLoop(), 10_000));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    saveState(this.state, true);
  }

  // ---------------------------------------------------------------- views

  defaultRules(): ExitRules {
    return (
      this.state.defaultRules ?? {
        takeProfitPct: config.takeProfitPct,
        takeProfitSellPct: config.takeProfitSellPct,
        stopLossPct: config.stopLossPct,
        trailingStopPct: config.trailingStopPct,
        maxHoldMinutes: config.maxHoldMinutes,
        exitOnCreatorSell: config.exitOnCreatorSell,
      }
    );
  }

  openPositions(): Position[] {
    return this.state.positions.filter((p) => p.status !== 'closed');
  }

  priceOf(mint: string): number {
    const tok = this.collector.tokens.get(mint);
    return tok && tok.mcapSol > 0 ? tok.mcapSol / config.totalSupply : 0;
  }

  private rollDay(): void {
    if (this.state.dailySpend.date !== today()) this.state.dailySpend = { date: today(), sol: 0 };
  }

  async status() {
    this.rollDay();
    let balance: number | null = null;
    let balanceError: string | undefined;
    try {
      balance = r(await this.executor.getSolBalance(), 4);
    } catch (e) {
      balanceError = (e as Error).message;
    }
    const closedToday = this.state.positions.filter((p) => p.status === 'closed' && p.closedAt && new Date(p.closedAt).toISOString().slice(0, 10) === today());
    return {
      mode: this.executor.mode,
      wallet: this.executor.publicKey,
      solBalance: balance,
      balanceError,
      killSwitch: this.state.killSwitch,
      autoTrading: {
        allowedByServer: config.autoTradeAllowed,
        enabled: this.state.autoEnabled,
        strategy: config.autoStrategy,
        minScore: config.autoStrategy === 'early_gainer' ? config.eg.minScore : config.autoMinScore,
        buySol: Math.min(config.autoBuySol, config.maxSolPerTrade),
      },
      limits: {
        maxSolPerTrade: config.maxSolPerTrade,
        maxDailySol: config.maxDailySol,
        spentToday: r(this.state.dailySpend.sol),
        remainingToday: r(Math.max(0, config.maxDailySol - this.state.dailySpend.sol)),
        maxOpenPositions: config.maxOpenPositions,
        minWalletReserveSol: config.minWalletReserveSol,
        maxSlippagePct: config.maxSlippagePct,
      },
      openPositions: this.openPositions().length,
      realizedPnlTodaySol: r(closedToday.reduce((a, p) => a + p.solReceived - p.solSpent, 0)),
      defaultExitRules: this.defaultRules(),
    };
  }

  positionsView() {
    return this.openPositions().map((p) => {
      const price = this.priceOf(p.mint);
      const pnlPct = price > 0 && p.entryPrice > 0 ? (price / p.entryPrice - 1) * 100 : null;
      return {
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        status: p.status,
        source: p.source,
        ageMinutes: r((nowMs() - p.openedAt) / 60_000, 1),
        solSpent: r(p.solSpent),
        solReceivedSoFar: r(p.solReceived),
        tokensHeld: Math.round(p.tokensHeld),
        estValueSol: price > 0 ? r(p.tokensHeld * price) : null,
        pnlPct: pnlPct === null ? null : r(pnlPct, 1),
        peakPnlPct: p.entryPrice > 0 ? r((p.peakPrice / p.entryPrice - 1) * 100, 1) : null,
        takeProfitHit: p.takeProfitHit,
        rules: p.rules,
        pumpfun: `https://pump.fun/coin/${p.mint}`,
      };
    });
  }

  history(limit: number): TradeRecord[] {
    return this.state.history.slice(-limit).reverse();
  }

  // ---------------------------------------------------------------- controls

  setKillSwitch(on: boolean): void {
    this.state.killSwitch = on;
    if (on) this.state.autoEnabled = false;
    saveState(this.state, true);
    void sendTelegram(on ? '🛑 Kill switch ON — no new buys.' : '✅ Kill switch OFF.');
  }

  setAuto(on: boolean): Result<{ enabled: boolean }> {
    if (on && !config.autoTradeAllowed) return { ok: false, error: 'Auto-trading is disabled on the server (AUTO_TRADE_ALLOWED=false).' };
    if (on && this.state.killSwitch) return { ok: false, error: 'Kill switch is on — turn it off first.' };
    this.state.autoEnabled = on;
    saveState(this.state, true);
    void sendTelegram(on ? `🤖 Auto-trading ON (${this.executor.mode}).` : '🤖 Auto-trading OFF.');
    return { ok: true, data: { enabled: on } };
  }

  setRules(patch: Partial<ExitRules>, mint?: string): Result<ExitRules> {
    const apply = (base: ExitRules): ExitRules => ({ ...base, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
    if (mint) {
      const p = this.openPositions().find((x) => x.mint === mint);
      if (!p) return { ok: false, error: `No open position for ${mint}` };
      p.rules = apply(p.rules);
      saveState(this.state);
      return { ok: true, data: p.rules };
    }
    this.state.defaultRules = apply(this.defaultRules());
    saveState(this.state);
    return { ok: true, data: this.state.defaultRules };
  }

  // ---------------------------------------------------------------- buy

  async buy(opts: { mint: string; sol: number; slippagePct?: number; source: 'manual' | 'auto'; score?: number }): Promise<Result<Position>> {
    const { mint, source } = opts;
    const sol = r(opts.sol, 6);
    const slippage = opts.slippagePct ?? config.defaultSlippagePct;
    this.rollDay();

    // ---- hard risk checks (env limits, cannot be bypassed via MCP)
    if (this.state.killSwitch) return { ok: false, error: 'Kill switch is ON — buys blocked.' };
    if (!(sol > 0)) return { ok: false, error: 'SOL amount must be > 0' };
    if (sol > config.maxSolPerTrade) return { ok: false, error: `Exceeds MAX_SOL_PER_TRADE (${config.maxSolPerTrade} SOL)` };
    if (this.state.dailySpend.sol + sol > config.maxDailySol + 1e-9)
      return { ok: false, error: `Exceeds MAX_DAILY_SOL — ${r(config.maxDailySol - this.state.dailySpend.sol)} SOL left today` };
    if (slippage > config.maxSlippagePct) return { ok: false, error: `Slippage above MAX_SLIPPAGE_PCT (${config.maxSlippagePct}%)` };
    if (this.openPositions().some((p) => p.mint === mint)) return { ok: false, error: 'Already holding an open position in this token' };
    if (this.openPositions().length >= config.maxOpenPositions) return { ok: false, error: `MAX_OPEN_POSITIONS (${config.maxOpenPositions}) reached` };
    const last = this.state.lastBuyAt[mint] ?? 0;
    if (nowMs() - last < config.rebuyCooldownMinutes * 60_000) return { ok: false, error: `Re-buy cooldown (${config.rebuyCooldownMinutes} min) active for this token` };
    if (this.busy.has(mint)) return { ok: false, error: 'A trade for this token is already in progress' };

    let balance: number;
    try {
      balance = await this.executor.getSolBalance();
    } catch (e) {
      return { ok: false, error: `Could not read wallet balance: ${(e as Error).message}` };
    }
    const feeBuffer = config.priorityFeeSol + 0.003; // priority fee + rent/ATA creation headroom
    if (balance - sol - feeBuffer < config.minWalletReserveSol)
      return { ok: false, error: `Would leave less than MIN_WALLET_RESERVE_SOL (${config.minWalletReserveSol}). Balance ${r(balance)} SOL.` };

    // make sure we have a price feed for exits
    const tok = this.collector.pin(mint, 'position');
    const price = this.priceOf(mint);
    const signals = tok.trades.length ? computeSignals(tok, nowMs(), this.price.price) : null;

    this.busy.add(mint);
    this.state.lastBuyAt[mint] = nowMs();
    try {
      const fill = await this.executor.buy(mint, sol, slippage, price);
      if (!(fill.tokens > 0)) throw new Error('Fill returned 0 tokens');
      const entryPrice = fill.sol / fill.tokens;
      const pos: Position = {
        id: randomUUID(),
        mint,
        symbol: tok.symbol || '?',
        name: tok.name || '',
        mode: this.executor.mode,
        status: 'open',
        openedAt: nowMs(),
        solSpent: fill.sol,
        tokensBought: fill.tokens,
        tokensHeld: fill.tokens,
        entryPrice,
        peakPrice: entryPrice,
        solReceived: 0,
        takeProfitHit: false,
        rules: { ...this.defaultRules() },
        source,
        entryScore: opts.score ?? signals?.score,
      };
      this.state.positions.push(pos);
      this.state.dailySpend.sol += fill.sol;
      if (this.executor.mode === 'paper') this.state.paperBalanceSol -= fill.sol;
      this.record({ t: nowMs(), mint, symbol: pos.symbol, side: 'buy', mode: pos.mode, sol: fill.sol, tokens: fill.tokens, reason: source, signature: fill.signature, ok: true });
      this.trimClosed();
      saveState(this.state, true);
      void sendTelegram(
        `🟢 BUY ${pos.mode.toUpperCase()} $${pos.symbol} — ${r(fill.sol)} SOL (${source}${pos.entryScore !== undefined ? `, score ${pos.entryScore}` : ''})\n` +
          `TP +${pos.rules.takeProfitPct}% / SL -${pos.rules.stopLossPct}% / trail ${pos.rules.trailingStopPct}%\n` +
          `https://pump.fun/coin/${mint}${fill.signature ? `\nhttps://solscan.io/tx/${fill.signature}` : ''}`,
      );
      return { ok: true, data: pos };
    } catch (e) {
      const error = (e as Error).message;
      this.collector.unpin(mint, 'position');
      this.record({ t: nowMs(), mint, symbol: tok.symbol || '?', side: 'buy', mode: this.executor.mode, sol, tokens: 0, reason: source, ok: false, error });
      saveState(this.state);
      return { ok: false, error };
    } finally {
      this.busy.delete(mint);
    }
  }

  // ---------------------------------------------------------------- sell

  async sell(mint: string, percent: number, reason: string, slippagePct?: number): Promise<Result<Position>> {
    const pos = this.openPositions().find((p) => p.mint === mint);
    if (!pos) return { ok: false, error: `No open position for ${mint}` };
    if (pos.status === 'selling' || this.busy.has(mint)) return { ok: false, error: 'A sell for this token is already in progress' };
    const pct = Math.min(100, Math.max(1, percent));
    const slippage = Math.min(config.maxSlippagePct, slippagePct ?? config.defaultSlippagePct);

    pos.status = 'selling';
    this.busy.add(mint);
    try {
      const fill = await this.executor.sell(mint, pct, slippage, this.priceOf(mint), pos.tokensHeld);
      pos.solReceived += fill.sol;
      pos.tokensHeld = Math.max(0, pos.tokensHeld - fill.tokens);
      if (this.executor.mode === 'paper') this.state.paperBalanceSol += fill.sol;
      const closes = pct >= 100 || pos.tokensHeld < pos.tokensBought * 0.001;
      pos.status = closes ? 'closed' : 'open';
      if (closes) {
        pos.closedAt = nowMs();
        pos.closeReason = reason;
        pos.tokensHeld = 0;
        this.collector.unpin(mint, 'position');
      }
      this.retryAt.delete(mint);
      this.record({ t: nowMs(), mint, symbol: pos.symbol, side: 'sell', mode: pos.mode, sol: fill.sol, tokens: fill.tokens, percent: pct, reason, signature: fill.signature, ok: true });
      saveState(this.state, true);
      const pnl = pos.solReceived - pos.solSpent;
      void sendTelegram(
        `${closes ? (pnl >= 0 ? '✅' : '🔴') : '🟡'} SELL ${pct}% ${pos.mode.toUpperCase()} $${pos.symbol} — ${r(fill.sol)} SOL (${reason})\n` +
          (closes ? `Closed. P&L ${pnl >= 0 ? '+' : ''}${r(pnl)} SOL (${r((pos.solReceived / pos.solSpent - 1) * 100, 1)}%)` : `Holding ${Math.round(pos.tokensHeld)} tokens`) +
          (fill.signature ? `\nhttps://solscan.io/tx/${fill.signature}` : ''),
      );
      return { ok: true, data: pos };
    } catch (e) {
      pos.status = 'open';
      const error = (e as Error).message;
      this.retryAt.set(mint, nowMs() + 15_000);
      this.record({ t: nowMs(), mint, symbol: pos.symbol, side: 'sell', mode: pos.mode, sol: 0, tokens: 0, percent: pct, reason, ok: false, error });
      saveState(this.state);
      log('sell failed', mint, error);
      return { ok: false, error };
    } finally {
      this.busy.delete(mint);
    }
  }

  async sellAll(reason: string) {
    const results = [];
    for (const p of this.openPositions()) {
      const res = await this.sell(p.mint, 100, reason);
      results.push({ mint: p.mint, symbol: p.symbol, ok: res.ok, error: res.ok ? undefined : res.error });
    }
    return results;
  }

  // ---------------------------------------------------------------- loops

  async exitLoop(): Promise<void> {
    const now = nowMs();
    for (const pos of this.openPositions()) {
      if (pos.status !== 'open' || this.busy.has(pos.mint)) continue;
      if ((this.retryAt.get(pos.mint) ?? 0) > now) continue;
      const price = this.priceOf(pos.mint);
      const tok = this.collector.tokens.get(pos.mint);
      const ageMin = (now - pos.openedAt) / 60_000;

      if (ageMin >= pos.rules.maxHoldMinutes) {
        await this.sell(pos.mint, 100, `max hold ${pos.rules.maxHoldMinutes}m`);
        continue;
      }
      if (pos.rules.exitOnCreatorSell && tok?.creatorSold) {
        await this.sell(pos.mint, 100, 'creator sold');
        continue;
      }
      if (price <= 0) continue;
      if (price > pos.peakPrice) {
        pos.peakPrice = price;
        saveState(this.state);
      }
      const pnlPct = (price / pos.entryPrice - 1) * 100;
      const peakGainPct = (pos.peakPrice / pos.entryPrice - 1) * 100;
      const fromPeakPct = (1 - price / pos.peakPrice) * 100;

      if (pnlPct <= -pos.rules.stopLossPct) {
        await this.sell(pos.mint, 100, `stop loss ${r(pnlPct, 1)}%`);
      } else if (!pos.takeProfitHit && pnlPct >= pos.rules.takeProfitPct) {
        const res = await this.sell(pos.mint, pos.rules.takeProfitSellPct, `take profit +${r(pnlPct, 1)}%`);
        if (res.ok) {
          res.data.takeProfitHit = true;
          saveState(this.state);
        }
      } else if (peakGainPct >= pos.rules.trailingStopPct && fromPeakPct >= pos.rules.trailingStopPct && pnlPct > 0) {
        await this.sell(pos.mint, 100, `trailing stop (${r(fromPeakPct, 1)}% off peak)`);
      }
    }
  }

  async autoLoop(): Promise<void> {
    if (config.autoStrategy !== 'score') return;
    if (!config.autoTradeAllowed || !this.state.autoEnabled || this.state.killSwitch) return;
    if (this.openPositions().length >= config.maxOpenPositions) return;
    const candidates = rankTokens(
      this.collector.tokens.values(),
      {
        limit: 10,
        minScore: config.autoMinScore,
        minAgeSeconds: config.autoMinAgeMinutes * 60,
        maxAgeMinutes: config.autoMaxAgeMinutes,
        excludeRisky: true,
        includeMigrated: false,
      },
      this.price.price,
    );
    const held = new Set(this.openPositions().map((p) => p.mint));
    const pick = candidates.find(
      (s) =>
        s.confidence !== 'low' &&
        !s.creatorSold &&
        s.curveProgressPct >= config.autoMinCurvePct &&
        s.curveProgressPct <= config.autoMaxCurvePct &&
        !held.has(s.mint) &&
        nowMs() - (this.state.lastBuyAt[s.mint] ?? 0) > config.rebuyCooldownMinutes * 60_000,
    );
    if (!pick) return;
    const sol = Math.min(config.autoBuySol, config.maxSolPerTrade);
    const res = await this.buy({ mint: pick.mint, sol, source: 'auto', score: pick.score });
    if (!res.ok) log('auto-buy skipped', pick.symbol, res.error);
  }

  /** Called by the early-gainer strategy when it fires. Buys only if auto-trading is on. */
  async onStrategySignal(sig: { mint: string; symbol: string; score: number }): Promise<Result<Position> | null> {
    if (config.autoStrategy !== 'early_gainer') return null;
    if (!config.autoTradeAllowed || !this.state.autoEnabled || this.state.killSwitch) return null;
    const sol = Math.min(config.autoBuySol, config.maxSolPerTrade);
    const res = await this.buy({ mint: sig.mint, sol, source: 'auto', score: sig.score });
    if (!res.ok) log('auto-buy skipped', sig.symbol, res.error);
    return res;
  }

  // ---------------------------------------------------------------- misc

  private record(t: TradeRecord): void {
    this.state.history.push(t);
    if (this.state.history.length > 1000) this.state.history.splice(0, this.state.history.length - 1000);
  }

  private trimClosed(): void {
    const closed = this.state.positions.filter((p) => p.status === 'closed');
    if (closed.length > 300) {
      const drop = new Set(closed.slice(0, closed.length - 300).map((p) => p.id));
      this.state.positions = this.state.positions.filter((p) => !drop.has(p.id));
    }
  }
}
