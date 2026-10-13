const log = (...a: unknown[]) => console.error('[price]', ...a);

/** Best-effort SOL/USD price for USD market caps. Never throws. */
export class SolPriceFeed {
  price: number | null = null;
  updatedAt = 0;
  private timer?: NodeJS.Timeout;

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { solana?: { usd?: number } };
      if (typeof data.solana?.usd === 'number') {
        this.price = data.solana.usd;
        this.updatedAt = Date.now();
      }
    } catch (e) {
      log('refresh failed:', (e as Error).message);
    }
  }
}
