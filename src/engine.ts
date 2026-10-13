import { PumpCollector } from './collector.js';
import { SolPriceFeed } from './price.js';
import { sendTelegram, startAlerts } from './alerts.js';
import { Trader } from './trader.js';
import { EarlyGainerStrategy, type EarlyGainerEval } from './strategy.js';
import { SignalJournal } from './journal.js';

/** Long-lived singletons shared by every MCP session. */
export class Engine {
  readonly collector = new PumpCollector();
  readonly price = new SolPriceFeed();
  readonly trader: Trader;
  readonly strategy: EarlyGainerStrategy;
  readonly journal: SignalJournal;
  private alertTimer?: NodeJS.Timeout;

  constructor() {
    this.trader = new Trader(this.collector, this.price);
    this.strategy = new EarlyGainerStrategy(this.collector, this.price);
    this.journal = new SignalJournal(this.collector);
    this.strategy.on('signal', (ev: EarlyGainerEval) => void this.onSignal(ev));
  }

  private async onSignal(ev: EarlyGainerEval): Promise<void> {
    this.journal.record(ev);
    const m = ev.metrics;
    void sendTelegram(
      [
        `🚀 EARLY GAINER ${ev.score}/100 — $${ev.symbol} (${ev.name})`,
        `MC ${ev.mcapSol} SOL${ev.mcapUsd ? ` (~$${ev.mcapUsd.toLocaleString()})` : ''} | age ${ev.ageMinutes}m | curve ${m.curveProgressPct}%`,
        `Vol 2m ${m.vol2mSol} SOL${m.relVol !== null ? ` (${m.relVol}x baseline)` : ''} | buy pressure ${Math.round(m.buyPressure2m * 100)}%`,
        `Buyers 2m ${m.buyers2m} (${m.newBuyers2m} new) | big buyers ${m.bigBuyers5m} | top10 ${m.top10HoldersPct}%${m.breakout ? ' | BREAKOUT' : ''}`,
        ev.pumpfun,
      ].join('\n'),
    );
    const res = await this.trader.onStrategySignal(ev);
    if (res?.ok) this.journal.markTraded(ev.mint);
  }

  start(): void {
    this.collector.start();
    this.price.start();
    this.trader.start();
    this.strategy.start();
    this.journal.start();
    this.alertTimer = startAlerts(this.collector, this.price);
  }

  stop(): void {
    this.trader.stop();
    this.strategy.stop();
    this.journal.stop();
    this.collector.stop();
    this.price.stop();
    if (this.alertTimer) clearInterval(this.alertTimer);
  }
}
