import { EventEmitter } from 'node:events';
import { config } from './config.js';
import type { PumpCollector } from './collector.js';
import type { SolPriceFeed } from './price.js';
import { computeSignals } from './scoring.js';
import type { TokenState } from './types.js';
import { now as nowMs } from './clock.js';

const log = (...a: unknown[]) => console.error('[strategy]', ...a);
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const sat = (x: number, k: number) => (x <= 0 ? 0 : 1 - Math.exp(-x / k));
const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

const SEVERE = ['CREATOR_SOLD', 'SNIPERS_STILL_HOLDING', 'POSSIBLE_WASH_TRADING', 'DUMPED_FROM_PEAK', 'WHALE_CONCENTRATION'];

interface Snapshot {
  t: number;
  holders: number;
  mcapSol: number;
}

export interface EarlyGainerEval {
  mint: string;
  symbol: string;
  name: string;
  ageMinutes: number;
  mcapSol: number;
  mcapUsd: number | null;
  score: number;
  passes: boolean;
  failedGates: string[];
  metrics: {
    vol2mSol: number;
    buyVol2mSol: number;
    baselineVol2mSol: number | null;
    relVol: number | null;
    netFlow2mSol: number;
    buyPressure2m: number;
    buyers2m: number;
    newBuyers2m: number;
    buyerGrowth: number;
    breakout: boolean;
    priorHigh10mSol: number;
    holderGrowth5m: number | null;
    bigBuyers5m: number;
    hasSocials: boolean | null;
    top10HoldersPct: number;
    curveProgressPct: number;
    tradesPerTrader5m: number;
  };
  components: Record<string, number>;
  flags: string[];
  pumpfun: string;
}

/**
 * EARLY GAINER: looks for a token whose trading suddenly accelerates — volume well above its own
 * recent baseline, a burst of NEW wallets buying, buyers outweighing sellers, and price breaking its
 * recent high — while passing distribution/rug filters. Emits 'signal' once per token per window.
 */
export class EarlyGainerStrategy extends EventEmitter {
  private snaps = new Map<string, Snapshot[]>();
  private lastTrigger = new Map<string, number>();
  private socials = new Map<string, boolean>();
  private socialsPending = new Set<string>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private collector: PumpCollector,
    private price: SolPriceFeed,
  ) {
    super();
  }

  start(): void {
    this.timers.push(setInterval(() => this.sample(), 15_000));
    this.timers.push(setInterval(() => this.scan(), 5_000));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
  }

  // ---------------------------------------------------------------- public

  /** Evaluate all tracked tokens now. */
  candidates(opts: { limit: number; includeNearMisses: boolean }): EarlyGainerEval[] {
    const now = nowMs();
    const out: EarlyGainerEval[] = [];
    for (const tok of this.collector.tokens.values()) {
      const ev = this.evaluate(tok, now);
      if (!ev) continue;
      if (ev.passes || (opts.includeNearMisses && ev.failedGates.length <= 2 && ev.score >= config.eg.minScore - 15)) out.push(ev);
    }
    return out.sort((a, b) => Number(b.passes) - Number(a.passes) || b.score - a.score).slice(0, opts.limit);
  }

  evaluateMint(mint: string): EarlyGainerEval | null {
    const tok = this.collector.tokens.get(mint);
    return tok ? this.evaluate(tok, nowMs()) : null;
  }

  // ---------------------------------------------------------------- loops

  sample(): void {
    const now = nowMs();
    for (const tok of this.collector.tokens.values()) {
      const arr = this.snaps.get(tok.mint) ?? [];
      arr.push({ t: now, holders: tok.balances.size, mcapSol: tok.mcapSol });
      if (arr.length > 48) arr.splice(0, arr.length - 48); // ~12 min
      this.snaps.set(tok.mint, arr);
    }
    for (const mint of this.snaps.keys()) if (!this.collector.tokens.has(mint)) this.snaps.delete(mint);
    for (const [mint, t] of this.lastTrigger) if (now - t > 6 * 3600_000) this.lastTrigger.delete(mint);
    if (this.socials.size > 5000) this.socials.clear();
  }

  scan(): void {
    const now = nowMs();
    for (const tok of this.collector.tokens.values()) {
      const ev = this.evaluate(tok, now);
      if (!ev) continue;
      // fetch socials lazily for anything close to triggering
      if (ev.failedGates.length <= 1 && !this.socials.has(tok.mint)) void this.fetchSocials(tok);
      if (!ev.passes) continue;
      if (now - (this.lastTrigger.get(tok.mint) ?? 0) < config.eg.retriggerMinutes * 60_000) continue;
      this.lastTrigger.set(tok.mint, now);
      log(`SIGNAL $${ev.symbol} score ${ev.score} relVol ${ev.metrics.relVol} vol2m ${ev.metrics.vol2mSol}`);
      this.emit('signal', ev);
    }
  }

  // ---------------------------------------------------------------- core

  private evaluate(tok: TokenState, now: number): EarlyGainerEval | null {
    const eg = config.eg;
    if (!tok.trades.length || tok.mcapSol <= 0) return null;
    if (now - tok.lastTradeAt > 120_000) return null; // no trades in the 2-min window → cannot signal
    const ageMin = (now - tok.createdAt) / 60_000;

    // ---- trade windows
    const t2 = now - 120_000;
    const t4 = now - 240_000;
    const t5 = now - 300_000;
    const t12 = now - 720_000;
    let vol2 = 0, buyVol2 = 0, sellVol2 = 0, volBase = 0, priorHigh = 0;
    let trades5 = 0;
    const buyers2 = new Set<string>();
    const buyersPrev = new Set<string>();
    const seenBefore = new Set<string>();
    const traders5 = new Set<string>();
    const bigBuyers5 = new Set<string>();

    for (const tr of tok.trades) {
      if (tr.t < t2) seenBefore.add(tr.trader);
      if (tr.t >= t12 && tr.t < t2) volBase += tr.sol;
      if (tr.t >= t12 && tr.t < now - 60_000 && tr.mcapSol > priorHigh) priorHigh = tr.mcapSol;
      if (tr.t >= t5) {
        trades5++;
        traders5.add(tr.trader);
        if (tr.side === 'buy' && tr.sol >= eg.bigBuySol && tr.trader !== tok.creator) bigBuyers5.add(tr.trader);
      }
      if (tr.t >= t4 && tr.t < t2 && tr.side === 'buy' && tr.trader !== tok.creator) buyersPrev.add(tr.trader);
      if (tr.t >= t2) {
        vol2 += tr.sol;
        if (tr.side === 'buy') {
          buyVol2 += tr.sol;
          if (tr.trader !== tok.creator) buyers2.add(tr.trader);
        } else sellVol2 += tr.sol;
      }
    }
    let newBuyers2 = 0;
    for (const b of buyers2) if (!seenBefore.has(b)) newBuyers2++;

    // baseline: average 2-min volume across the 10 minutes before the current window
    const observedBaseMin = Math.min(10, Math.max(0, ageMin - 2));
    const young = ageMin < eg.youngTokenMinutes || observedBaseMin < 4;
    const baseline = young ? null : volBase / (observedBaseMin / 2);
    const relVol = baseline === null ? null : vol2 / Math.max(baseline, 0.5);
    const buyPressure = vol2 > 0 ? buyVol2 / vol2 : 0;
    const netFlow = buyVol2 - sellVol2;
    const buyerGrowth = (buyers2.size + 1) / (buyersPrev.size + 1);
    const breakout = priorHigh > 0 && tok.mcapSol > priorHigh * 1.05;

    // holder growth over ~5 minutes from snapshots
    const snaps = this.snaps.get(tok.mint) ?? [];
    const old = snaps.find((s) => s.t >= t5 - 15_000 && s.t <= t5 + 30_000);
    const holderGrowth = old ? tok.balances.size - old.holders : null;

    const sig = computeSignals(tok, now, this.price.price);
    const hasSocials = this.socials.has(tok.mint) ? this.socials.get(tok.mint)! : null;
    const tradesPerTrader = trades5 / Math.max(1, traders5.size);

    // ---- hard gates
    const failed: string[] = [];
    const gate = (ok: boolean, name: string) => {
      if (!ok) failed.push(name);
    };
    gate(ageMin >= eg.minAgeMinutes && ageMin <= eg.maxAgeMinutes, 'age');
    gate(tok.mcapSol >= eg.minMcapSol && tok.mcapSol <= eg.maxMcapSol, 'mcap_range');
    gate(vol2 >= (young ? eg.youngMinVol2mSol : eg.minVol2mSol), 'volume_2m');
    if (!young) gate((relVol ?? 0) >= eg.minRelVol, 'relative_volume');
    gate(buyers2.size >= eg.minBuyers2m, 'buyers_2m');
    gate(newBuyers2 >= eg.minNewBuyers2m, 'new_buyers_2m');
    gate(buyPressure >= eg.minBuyPressure && netFlow > 0, 'buy_pressure');
    gate(sig.top10HoldersPct <= eg.maxTop10Pct, 'top10_concentration');
    gate(tradesPerTrader <= eg.maxTradesPerTrader, 'wash_trading');
    gate(!tok.creatorSold, 'creator_sold');
    gate(!sig.flags.some((f) => SEVERE.includes(f)), 'severe_flags');
    if (eg.requireSocials) gate(hasSocials === true, 'socials');

    // ---- score (0-100)
    const c = {
      relativeVolume: young ? sat(vol2, 10) * 25 : clamp(((relVol ?? 0) - 1) / 7) * 25,
      absoluteVolume: sat(vol2, 8) * 15,
      newWallets: sat(newBuyers2, 15) * 12 + clamp((buyerGrowth - 1) / 3) * 8,
      breakout: breakout ? 10 : 0,
      holderGrowth: holderGrowth === null ? 3 : sat(Math.max(0, holderGrowth), 20) * 10,
      buyPressure: clamp((buyPressure - 0.5) / 0.35) * 10,
      bigBuyers: sat(bigBuyers5.size, 2) * 5,
      socials: hasSocials ? 5 : 0,
    };
    let score = Object.values(c).reduce((a, b) => a + b, 0);
    if (sig.curveProgressPct > 90 && !tok.migrated) score -= 5; // graduation dumps are common
    score = Math.round(clamp(score, 0, 100));

    return {
      mint: tok.mint,
      symbol: tok.symbol,
      name: tok.name,
      ageMinutes: r(ageMin, 1),
      mcapSol: r(tok.mcapSol),
      mcapUsd: this.price.price ? Math.round(tok.mcapSol * this.price.price) : null,
      score,
      passes: failed.length === 0 && score >= eg.minScore,
      failedGates: score < eg.minScore ? [...failed, 'score'] : failed,
      metrics: {
        vol2mSol: r(vol2, 3),
        buyVol2mSol: r(buyVol2, 3),
        baselineVol2mSol: baseline === null ? null : r(baseline, 3),
        relVol: relVol === null ? null : r(relVol, 2),
        netFlow2mSol: r(netFlow, 3),
        buyPressure2m: r(buyPressure, 3),
        buyers2m: buyers2.size,
        newBuyers2m: newBuyers2,
        buyerGrowth: r(buyerGrowth, 2),
        breakout,
        priorHigh10mSol: r(priorHigh),
        holderGrowth5m: holderGrowth,
        bigBuyers5m: bigBuyers5.size,
        hasSocials,
        top10HoldersPct: sig.top10HoldersPct,
        curveProgressPct: sig.curveProgressPct,
        tradesPerTrader5m: r(tradesPerTrader, 2),
      },
      components: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, r(v, 1)])),
      flags: sig.flags,
      pumpfun: `https://pump.fun/coin/${tok.mint}`,
    };
  }

  private async fetchSocials(tok: TokenState): Promise<void> {
    if (!tok.uri || this.socialsPending.has(tok.mint) || this.socialsPending.size > 10) return;
    this.socialsPending.add(tok.mint);
    try {
      const res = await fetch(tok.uri, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const m = (await res.json()) as Record<string, unknown>;
        this.socials.set(tok.mint, Boolean(m.twitter || m.telegram || m.website));
      } else this.socials.set(tok.mint, false);
    } catch {
      this.socials.set(tok.mint, false);
    } finally {
      this.socialsPending.delete(tok.mint);
    }
  }
}
