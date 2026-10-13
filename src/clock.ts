/**
 * Single time source for all engine code. Live: wall clock. Backtest: the replay sets
 * simulated time so every window, cooldown and hold timer behaves exactly as it would live.
 */
let simulated: number | null = null;

export const now = (): number => simulated ?? Date.now();

export function setSimulatedTime(t: number | null): void {
  simulated = t;
}

export const isBacktest = (): boolean => process.env.BACKTEST === '1';
