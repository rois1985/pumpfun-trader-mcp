import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { createGzip, type Gzip } from 'node:zlib';
import { config } from './config.js';

const log = (...a: unknown[]) => console.error('[recorder]', ...a);

/**
 * Writes the raw PumpPortal stream to hourly gzip files:
 *   data/recordings/2026-10-13T14.jsonl.gz   one line per message: {"ts":<ms>,"m":<raw json>}
 * These files are the input for `npm run backtest`. Roughly 0.3–1 GB/day compressed.
 */
export class StreamRecorder {
  private gz?: Gzip;
  private file?: WriteStream;
  private hourKey = '';
  readonly dir = join(config.dataDir, 'recordings');
  lines = 0;

  constructor() {
    mkdirSync(this.dir, { recursive: true });
    log(`recording to ${this.dir} (keeping ${config.recordKeepDays} days)`);
    this.cleanup();
    setInterval(() => this.cleanup(), 3600_000).unref();
  }

  write(ts: number, raw: string): void {
    const key = new Date(ts).toISOString().slice(0, 13);
    if (key !== this.hourKey) this.rotate(key);
    this.gz!.write(`{"ts":${ts},"m":${raw}}\n`);
    this.lines++;
  }

  close(): void {
    this.gz?.end();
  }

  private rotate(key: string): void {
    this.gz?.end();
    this.hourKey = key;
    this.file = createWriteStream(join(this.dir, `${key}.jsonl.gz`), { flags: 'a' });
    this.gz = createGzip({ level: 6 });
    this.gz.pipe(this.file);
  }

  private cleanup(): void {
    const cutoff = Date.now() - config.recordKeepDays * 86_400_000;
    try {
      for (const f of readdirSync(this.dir)) {
        const p = join(this.dir, f);
        if (f.endsWith('.jsonl.gz') && statSync(p).mtimeMs < cutoff) unlinkSync(p);
      }
    } catch (e) {
      log('cleanup failed:', (e as Error).message);
    }
  }
}
