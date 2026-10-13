import { config } from './config.js';
import type { TokenState } from './types.js';
import { now as nowMs } from './clock.js';

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
/** saturating curve: 0 -> 0, k -> ~0.63, 3k -> ~0.95 */
const sat = (x: number, k: number) => (x <= 0 ? 0 : 1 - Math.exp(-x / k));
const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export interface WindowStats {
  trades: number;
  buys: number;
  sells: number;
  buySol: number;
  sellSol: number;
  uniqueBuyers: number;
  uniqueTraders: number;
}

export type Label = 'hot' | 'warming' | 'neutral' | 'cold' | 'avoid';

export interface TokenSignals {
  mint: string;
  name: string;
  symbol: string;
  ageSeconds: number;
  mcapSol: number;
  mcapUsd: number | null;
  peakMcapSol: number;
  drawdownFromPeakPct: number;
  mcapChange5mPct: number;
  curveProgressPct: number;
  migrated: boolean;
  last1m: WindowStats;
  last5m: WindowStats;
  netFlowSol5m: number;
  buyPressure5m: number;
  tradeAcceleration: number;
  uniqueBuyersTotal: number;
  holdersEst: number;
  top1HolderPct: number;
  top10HoldersPct: number;
  creator: string;
  creatorHoldsPct: number;
  creatorSold: boolean;
  creatorSoldSol: number;
  earlyBuyersStillHoldPct: number;
  tradesPerTrader5m: number;
  observedTrades: number;
  score: number;
  label: Label;
  confidence: 'low' | 'medium' | 'high';
  components: { momentum: number; participation: number; health: number; curve: number; penalties: number };
  flags: string[];
  links: { pumpfun: string; dexscreener: string; solscan: string };
}

function windowStats(tok: TokenState, from: number, to: number): WindowStats {
  const s: WindowStats = { trades: 0, buys: 0, sells: 0, buySol: 0, sellSol: 0, uniqueBuyers: 0, uniqueTraders: 0 };
  const buyers = new Set<string>();
  const traders = new Set<string>();
  for (let i = tok.trades.length - 1; i >= 0; i--) {
    const tr = tok.trades[i];
    if (tr.t < from) break;
    if (tr.t > to) continue;
    s.trades++;
    traders.add(tr.trader);
    if (tr.side === 'buy') {
      s.buys++;
      s.buySol += tr.sol;
      if (tr.trader !== tok.creator) buyers.add(tr.trader);
    } else {
      s.sells++;
      s.sellSol += tr.sol;
    }
  }
  s.uniqueBuyers = buyers.size;
  s.uniqueTraders = traders.size;
  s.buySol = r(s.buySol, 3);
  s.sellSol = r(s.sellSol, 3);
  return s;
}

/** market cap of the last trade at or before time t (falls back to first observed) */
function mcapAt(tok: TokenState, t: number): number {
  for (let i = tok.trades.length - 1; i >= 0; i--) {
    if (tok.trades[i].t <= t && tok.trades[i].mcapSol > 0) return tok.trades[i].mcapSol;
  }
  const first = tok.trades.find((x) => x.mcapSol > 0);
  return first?.mcapSol ?? 0;
}

export function computeSignals(tok: TokenState, now: number, solUsd: number | null): TokenSignals {
  const supply = config.totalSupply;
  const ageSeconds = Math.max(0, (now - tok.createdAt) / 1000);

  const m1 = windowStats(tok, now - 60_000, now);
  const m5 = windowStats(tok, now - 300_000, now);
  const prev4 = windowStats(tok, now - 300_000, now - 60_000);

  const netFlow = m5.buySol - m5.sellSol;
  const vol5 = m5.buySol + m5.sellSol;
  const buyPressure = vol5 > 0 ? m5.buySol / vol5 : 0.5;
  const prevRate = prev4.trades / 4;
  const accel = (m1.trades + 1) / (prevRate + 1);

  const mcapThen = mcapAt(tok, now - 300_000);
  const mcapChange = mcapThen > 0 ? (tok.mcapSol / mcapThen - 1) * 100 : 0;
  const drawdown = tok.peakMcapSol > 0 ? (1 - tok.mcapSol / tok.peakMcapSol) * 100 : 0;

  const realSol = Math.max(0, tok.vSol - config.initialVirtualSol);
  const progress = tok.migrated ? 100 : clamp(realSol / config.graduationRealSol, 0, 1) * 100;

  const balances = [...tok.balances.values()].sort((a, b) => b - a);
  const top1 = ((balances[0] ?? 0) / supply) * 100;
  const top10 = (balances.slice(0, 10).reduce((a, b) => a + b, 0) / supply) * 100;
  const creatorHolds = ((tok.balances.get(tok.creator) ?? 0) / supply) * 100;
  let topNonCreator = 0;
  for (const [w, b] of tok.balances) if (w !== tok.creator && b > topNonCreator) topNonCreator = b;
  const topNonCreatorPct = (topNonCreator / supply) * 100;
  let earlyHold = 0;
  for (const w of tok.earlyBuyers) earlyHold += tok.balances.get(w) ?? 0;
  const earlyHoldPct = (earlyHold / supply) * 100;
  const tradesPerTrader = m5.trades / Math.max(1, m5.uniqueTraders);

  // ----- component scores
  const momentum =
    sat(Math.max(0, netFlow), 5) * 15 +
    clamp((accel - 1) / 2) * 10 +
    clamp(mcapChange / 100) * 10;

  const participation = sat(m5.uniqueBuyers, 25) * 15 + sat(tok.buyers.size, 150) * 10;

  const health =
    clamp((buyPressure - 0.5) / 0.3) * 10 +
    (1 - clamp((top10 - 15) / 35)) * 10 +
    (tok.creatorSold ? 0 : creatorHolds > 10 ? 2 : 5);

  const curve = tok.migrated
    ? 6
    : progress <= 60
      ? (progress / 60) * 15
      : Math.max(5, 15 - ((progress - 60) / 40) * 10);

  // ----- risk flags
  const flags: string[] = [];
  let penalties = 0;
  const flag = (name: string, pen = 0) => {
    flags.push(name);
    penalties += pen;
  };

  if (tok.creatorSold) flag('CREATOR_SOLD', 15);
  if (topNonCreatorPct > 10) flag('WHALE_CONCENTRATION', 10);
  if (creatorHolds > 15) flag('CREATOR_HEAVY_BAG', 5);
  if (earlyHoldPct > 25) flag('SNIPERS_STILL_HOLDING', 10);
  if (m5.trades > 30 && tradesPerTrader > 6) flag('POSSIBLE_WASH_TRADING', 10);
  if (drawdown > 50) flag('DUMPED_FROM_PEAK', 10);
  if (m5.trades === 0) flag('NO_RECENT_ACTIVITY', 20);
  if (buyPressure < 0.4 && vol5 > 1) flag('SELL_PRESSURE', 5);
  if (ageSeconds < 30) flag('TOO_NEW');
  if (!tok.seenCreate) flag('PARTIAL_HISTORY');
  if (tok.migrated) flag('MIGRATED');

  const raw = momentum + participation + health + curve - penalties;
  const score = Math.round(clamp(raw, 0, 100));

  let label: Label = score >= 75 ? 'hot' : score >= 60 ? 'warming' : score >= 40 ? 'neutral' : 'cold';
  if (penalties >= 20) label = 'avoid';

  const n = tok.trades.length;
  const confidence: TokenSignals['confidence'] = !tok.seenCreate || n < 20 ? 'low' : n < 100 ? 'medium' : 'high';

  return {
    mint: tok.mint,
    name: tok.name,
    symbol: tok.symbol,
    ageSeconds: Math.round(ageSeconds),
    mcapSol: r(tok.mcapSol),
    mcapUsd: solUsd ? Math.round(tok.mcapSol * solUsd) : null,
    peakMcapSol: r(tok.peakMcapSol),
    drawdownFromPeakPct: r(drawdown, 1),
    mcapChange5mPct: r(mcapChange, 1),
    curveProgressPct: r(progress, 1),
    migrated: tok.migrated,
    last1m: m1,
    last5m: m5,
    netFlowSol5m: r(netFlow, 3),
    buyPressure5m: r(buyPressure, 3),
    tradeAcceleration: r(accel, 2),
    uniqueBuyersTotal: tok.buyers.size,
    holdersEst: tok.balances.size,
    top1HolderPct: r(top1, 2),
    top10HoldersPct: r(top10, 2),
    creator: tok.creator,
    creatorHoldsPct: r(creatorHolds, 2),
    creatorSold: tok.creatorSold,
    creatorSoldSol: r(tok.creatorSoldSol, 3),
    earlyBuyersStillHoldPct: r(earlyHoldPct, 2),
    tradesPerTrader5m: r(tradesPerTrader, 2),
    observedTrades: n,
    score,
    label,
    confidence,
    components: {
      momentum: r(momentum, 1),
      participation: r(participation, 1),
      health: r(health, 1),
      curve: r(curve, 1),
      penalties,
    },
    flags,
    links: {
      pumpfun: `https://pump.fun/coin/${tok.mint}`,
      dexscreener: `https://dexscreener.com/solana/${tok.mint}`,
      solscan: `https://solscan.io/token/${tok.mint}`,
    },
  };
}

export interface LeaderFilter {
  limit: number;
  minScore: number;
  minAgeSeconds: number;
  maxAgeMinutes: number;
  excludeRisky: boolean;
  includeMigrated: boolean;
}

const SEVERE = new Set(['CREATOR_SOLD', 'SNIPERS_STILL_HOLDING', 'POSSIBLE_WASH_TRADING', 'DUMPED_FROM_PEAK', 'WHALE_CONCENTRATION']);

export function rankTokens(tokens: Iterable<TokenState>, f: LeaderFilter, solUsd: number | null): TokenSignals[] {
  const now = nowMs();
  const out: TokenSignals[] = [];
  for (const tok of tokens) {
    const age = (now - tok.createdAt) / 1000;
    if (age < f.minAgeSeconds || age > f.maxAgeMinutes * 60) continue;
    if (!f.includeMigrated && tok.migrated) continue;
    const s = computeSignals(tok, now, solUsd);
    if (s.score < f.minScore) continue;
    if (f.excludeRisky && s.flags.some((x) => SEVERE.has(x))) continue;
    out.push(s);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, f.limit);
}

/** Compact one-line-per-token view to keep MCP responses small */
export function summarize(s: TokenSignals) {
  return {
    mint: s.mint,
    symbol: s.symbol,
    name: s.name,
    score: s.score,
    label: s.label,
    confidence: s.confidence,
    ageMin: r(s.ageSeconds / 60, 1),
    mcapSol: s.mcapSol,
    mcapUsd: s.mcapUsd,
    mcapChange5mPct: s.mcapChange5mPct,
    curveProgressPct: s.curveProgressPct,
    netFlowSol5m: s.netFlowSol5m,
    buyPressure5m: s.buyPressure5m,
    uniqueBuyers5m: s.last5m.uniqueBuyers,
    top10HoldersPct: s.top10HoldersPct,
    flags: s.flags,
    pumpfun: s.links.pumpfun,
  };
}
