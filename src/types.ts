export type Side = 'buy' | 'sell';

/** Raw message shape from the PumpPortal data websocket. */
export interface PumpEvent {
  signature?: string;
  mint?: string;
  traderPublicKey?: string;
  txType?: 'create' | 'buy' | 'sell' | 'migrate' | string;
  tokenAmount?: number;
  solAmount?: number;
  newTokenBalance?: number;
  initialBuy?: number;
  bondingCurveKey?: string;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  marketCapSol?: number;
  name?: string;
  symbol?: string;
  uri?: string;
  pool?: string;
  message?: string;
  errors?: unknown;
}

export interface Trade {
  t: number;
  trader: string;
  side: Side;
  sol: number;
  tokens: number;
  mcapSol: number;
  sig: string;
}

export interface TokenState {
  mint: string;
  name: string;
  symbol: string;
  uri?: string;
  creator: string;
  createdAt: number;
  /** true when we saw the create event (full history); false for tokens added via watch_token */
  seenCreate: boolean;
  trades: Trade[];
  /** wallet -> current token balance (estimated from trade stream) */
  balances: Map<string, number>;
  /** unique non-creator buyers ever observed */
  buyers: Set<string>;
  /** wallets that bought within EARLY_WINDOW_SECONDS of creation (excluding creator) */
  earlyBuyers: Set<string>;
  creatorInitialTokens: number;
  creatorSold: boolean;
  creatorSoldSol: number;
  vSol: number;
  mcapSol: number;
  peakMcapSol: number;
  lastTradeAt: number;
  migrated: boolean;
  migratedAt?: number;
  pool?: string;
  /** owners keeping this token from being pruned: 'user' | 'position' | 'journal' */
  pins: Set<string>;
  subscribed: boolean;
}

export interface MigrationRecord {
  mint: string;
  t: number;
  signature?: string;
  pool?: string;
  name?: string;
  symbol?: string;
}

// ---------------------------------------------------------------- trading

export interface ExitRules {
  takeProfitPct: number;
  takeProfitSellPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  maxHoldMinutes: number;
  exitOnCreatorSell: boolean;
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  mode: 'paper' | 'live';
  status: 'open' | 'selling' | 'closed';
  openedAt: number;
  closedAt?: number;
  solSpent: number;
  tokensBought: number;
  tokensHeld: number;
  /** SOL per token at entry (solSpent / tokensBought) */
  entryPrice: number;
  /** highest observed price since entry, for trailing stop */
  peakPrice: number;
  solReceived: number;
  takeProfitHit: boolean;
  rules: ExitRules;
  source: 'manual' | 'auto';
  entryScore?: number;
  closeReason?: string;
}

export interface TradeRecord {
  t: number;
  mint: string;
  symbol: string;
  side: 'buy' | 'sell';
  mode: 'paper' | 'live';
  sol: number;
  tokens: number;
  percent?: number;
  reason: string;
  signature?: string;
  ok: boolean;
  error?: string;
}

export interface PersistedState {
  positions: Position[];
  history: TradeRecord[];
  dailySpend: { date: string; sol: number };
  killSwitch: boolean;
  autoEnabled: boolean;
  defaultRules?: ExitRules;
  paperBalanceSol: number;
  lastBuyAt: Record<string, number>;
}
