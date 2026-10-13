import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { PumpCollector } from './collector.js';
import type { EarlyGainerEval } from './strategy.js';
import { isBacktest, now as nowMs } from './clock.js';

const log = (...a: unknown[]) => console.error('[journal]', ...a);
const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const FILE = () => join(config.dataDir, 'signal-journal.json');

export interface JournalEntry {
  id: string;
  mint: string;
  symbol: string;
  t: number;
  score: number;
  entryMcapSol: number;
  metrics: EarlyGainerEval['metrics'];
  traded: boolean;
  outcome: {
    done: boolean;
    lastMcapSol: number;
    peakMcapSol: number;
    peakAtMin: number;
    /** lowest mcap seen BEFORE the peak — tells whether a stop loss would have fired first */
    lowBeforePeakSol: number;
    lowOverallSol: number;
    mcap5m?: number;
    mcap15m?: number;
    mcap60m?: number;
  };
}

/**
 * Records every strategy signal and tracks what the token did afterwards (peak, drawdown,
 * mcap at +5/+15/+60 min). This is how you find out whether the strategy actually works.
 */
export class SignalJournal {
  entries: JournalEntry[] = [];
  private timer?: NodeJS.Timeout;
  private dirty = false;

  constructor(private collector: PumpCollector) {
    try {
      if (isBacktest()) throw new Error('fresh');
      this.entries = JSON.parse(readFileSync(FILE(), 'utf8'));
    } catch {
      this.entries = [];
    }
    for (const e of this.entries) if (!e.outcome.done) this.collector.pin(e.mint, 'journal');
  }

  start(): void {
    this.timer = setInterval(() => this.track(), 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.save();
  }

  record(ev: EarlyGainerEval): JournalEntry {
    const e: JournalEntry = {
      id: `${ev.mint}-${nowMs()}`,
      mint: ev.mint,
      symbol: ev.symbol,
      t: nowMs(),
      score: ev.score,
      entryMcapSol: ev.mcapSol,
      metrics: ev.metrics,
      traded: false,
      outcome: {
        done: false,
        lastMcapSol: ev.mcapSol,
        peakMcapSol: ev.mcapSol,
        peakAtMin: 0,
        lowBeforePeakSol: ev.mcapSol,
        lowOverallSol: ev.mcapSol,
      },
    };
    this.entries.push(e);
    if (this.entries.length > 3000) this.entries.splice(0, this.entries.length - 3000);
    this.collector.pin(ev.mint, 'journal');
    this.dirty = true;
    return e;
  }

  markTraded(mint: string): void {
    const e = [...this.entries].reverse().find((x) => x.mint === mint && !x.outcome.done);
    if (e) {
      e.traded = true;
      this.dirty = true;
    }
  }

  track(): void {
    const now = nowMs();
    for (const e of this.entries) {
      if (e.outcome.done) continue;
      const o = e.outcome;
      const tok = this.collector.tokens.get(e.mint);
      const mcap = tok && tok.mcapSol > 0 ? tok.mcapSol : o.lastMcapSol;
      const elapsedMin = (now - e.t) / 60_000;
      o.lastMcapSol = mcap;
      if (mcap < o.lowOverallSol) o.lowOverallSol = mcap;
      if (mcap > o.peakMcapSol) {
        o.peakMcapSol = mcap;
        o.peakAtMin = r(elapsedMin, 1);
        o.lowBeforePeakSol = o.lowOverallSol; // lowest point reached before this new peak
      }
      if (o.mcap5m === undefined && elapsedMin >= 5) o.mcap5m = mcap;
      if (o.mcap15m === undefined && elapsedMin >= 15) o.mcap15m = mcap;
      if (o.mcap60m === undefined && elapsedMin >= 60) o.mcap60m = mcap;
      if (elapsedMin >= config.eg.outcomeMinutes) {
        o.done = true;
        o.mcap60m ??= mcap;
        this.collector.unpin(e.mint, 'journal');
      }
      this.dirty = true;
    }
    if (this.dirty) this.save();
  }

  private save(): void {
    this.dirty = false;
    if (isBacktest()) return;
    try {
      mkdirSync(config.dataDir, { recursive: true });
      const tmp = FILE() + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.entries));
      renameSync(tmp, FILE());
    } catch (err) {
      log('save failed:', (err as Error).message);
    }
  }

  /** Aggregate outcome stats + a rough simulation of the current exit rules. */
  performance(sinceHours: number, rules: { takeProfitPct: number; stopLossPct: number }) {
    const since = nowMs() - sinceHours * 3600_000;
    const done = this.entries.filter((e) => e.outcome.done && e.t >= since);
    const pending = this.entries.filter((e) => !e.outcome.done && e.t >= since).length;
    if (!done.length) return { signals: 0, pending, note: 'No completed signals yet — each signal needs EG_OUTCOME_MINUTES to resolve.' };

    const pct = (a: number, b: number) => (b > 0 ? (a / b - 1) * 100 : 0);
    const peak = done.map((e) => pct(e.outcome.peakMcapSol, e.entryMcapSol)).sort((a, b) => a - b);
    const ret60 = done.map((e) => pct(e.outcome.mcap60m ?? e.outcome.lastMcapSol, e.entryMcapSol));
    const ret15 = done.filter((e) => e.outcome.mcap15m).map((e) => pct(e.outcome.mcap15m!, e.entryMcapSol));
    const median = (a: number[]) => (a.length ? a[Math.floor(a.length / 2)] : 0);
    const share = (f: (x: number) => boolean) => r((peak.filter(f).length / peak.length) * 100, 1);

    // crude exit simulation: did the stop loss level come before the peak? then loss; else if peak reached TP, win at TP;
    // otherwise exit at the 60-min value. Ignores fees/slippage (~3-5% round trip on pump.fun) and partial exits.
    let stoppedFirst = 0;
    const sim = done.map((e) => {
      const pk = pct(e.outcome.peakMcapSol, e.entryMcapSol);
      // if TP was reachable, only lows before the peak matter; otherwise any low counts
      const low = pct(pk >= rules.takeProfitPct ? e.outcome.lowBeforePeakSol : e.outcome.lowOverallSol, e.entryMcapSol);
      if (low <= -rules.stopLossPct) {
        stoppedFirst++;
        return -rules.stopLossPct;
      }
      if (pk >= rules.takeProfitPct) return rules.takeProfitPct;
      return Math.max(-rules.stopLossPct, pct(e.outcome.mcap60m ?? e.outcome.lastMcapSol, e.entryMcapSol));
    });
    const simAvg = sim.reduce((a, b) => a + b, 0) / sim.length;

    return {
      signals: done.length,
      pending,
      windowHours: sinceHours,
      peakGain: {
        median: r(median(peak), 1),
        hitPlus50Pct: share((x) => x >= 50),
        hitPlus100Pct: share((x) => x >= 100),
        hitPlus300Pct: share((x) => x >= 300),
        neverAboveEntryPct: share((x) => x <= 1),
      },
      returnAfter15mAvgPct: ret15.length ? r(ret15.reduce((a, b) => a + b, 0) / ret15.length, 1) : null,
      returnAfter60mAvgPct: r(ret60.reduce((a, b) => a + b, 0) / ret60.length, 1),
      stopLossHitBeforePeakPct: r((stoppedFirst / done.length) * 100, 1),
      simulatedAvgTradePct: r(simAvg, 1),
      simulatedAvgTradeAfterCostsPct: r(simAvg - 5, 1),
      simulatedRules: rules,
      verdict:
        done.length < 30
          ? 'Too few signals to judge — collect at least 30-50.'
          : simAvg - 5 > 0
            ? 'Positive expectancy in this sample (before real slippage). Consider small live size and keep monitoring.'
            : 'Negative expectancy in this sample — tune thresholds/exits before risking real money.',
    };
  }
}
