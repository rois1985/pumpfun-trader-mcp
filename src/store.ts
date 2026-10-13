import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { PersistedState } from './types.js';
import { isBacktest, now as nowMs } from './clock.js';

const log = (...a: unknown[]) => console.error('[store]', ...a);
const FILE = () => join(config.dataDir, `state-${config.tradingMode}.json`);

export function today(): string {
  return new Date(nowMs()).toISOString().slice(0, 10);
}

export function loadState(): PersistedState {
  const fresh: PersistedState = {
    positions: [],
    history: [],
    dailySpend: { date: today(), sol: 0 },
    killSwitch: false,
    autoEnabled: false,
    paperBalanceSol: config.paperStartingSol,
    lastBuyAt: {},
  };
  try {
    if (isBacktest()) return fresh;
    const raw = JSON.parse(readFileSync(FILE(), 'utf8')) as Partial<PersistedState>;
    return { ...fresh, ...raw };
  } catch {
    return fresh;
  }
}

let pending: NodeJS.Timeout | undefined;

/** Debounced atomic write (tmp + rename) so a crash never leaves a half-written file. */
export function saveState(state: PersistedState, immediate = false): void {
  if (isBacktest()) return;
  const write = () => {
    pending = undefined;
    try {
      mkdirSync(config.dataDir, { recursive: true });
      const tmp = FILE() + '.tmp';
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(tmp, FILE());
    } catch (e) {
      log('save failed:', (e as Error).message);
    }
  };
  if (immediate) {
    if (pending) clearTimeout(pending);
    write();
    return;
  }
  if (!pending) pending = setTimeout(write, 500);
}
