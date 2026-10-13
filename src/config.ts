const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  const n = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const bool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key]?.toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
};
const str = (key: string, fallback = ''): string => process.env[key] || fallback;

export const config = {
  // ---------- server
  port: num('PORT', 8787),
  host: str('HOST', '127.0.0.1'),
  mcpSecret: str('MCP_SECRET'),
  dataDir: str('DATA_DIR', './data'),

  // ---------- scanner
  wsUrl: str('PUMPPORTAL_WS_URL', 'wss://pumpportal.fun/api/data'),
  maxTracked: num('MAX_TRACKED_TOKENS', 1500),
  maxTradesPerToken: num('MAX_TRADES_PER_TOKEN', 3000),
  trackMaxMinutes: num('TRACK_MAX_MINUTES', 180),
  deadAfterSeconds: num('DEAD_AFTER_SECONDS', 600),
  initialVirtualSol: num('INITIAL_VIRTUAL_SOL', 30),
  graduationRealSol: num('GRADUATION_REAL_SOL', 85),
  totalSupply: num('TOKEN_TOTAL_SUPPLY', 1_000_000_000),
  earlyWindowSeconds: num('EARLY_WINDOW_SECONDS', 5),
  rugcheckBaseUrl: str('RUGCHECK_BASE_URL', 'https://api.rugcheck.xyz/v1'),
  recordStream: bool('RECORD_STREAM', true),
  recordKeepDays: num('RECORD_KEEP_DAYS', 7),

  // ---------- alerts
  telegramBotToken: str('TELEGRAM_BOT_TOKEN'),
  telegramChatId: str('TELEGRAM_CHAT_ID'),
  alertMinScore: num('ALERT_MIN_SCORE', 75),
  alertCooldownMinutes: num('ALERT_COOLDOWN_MINUTES', 30),

  // ---------- trading (hard limits — env only, NOT changeable through MCP)
  tradingMode: (str('TRADING_MODE', 'paper') === 'live' ? 'live' : 'paper') as 'paper' | 'live',
  walletPrivateKey: str('WALLET_PRIVATE_KEY'),
  rpcUrl: str('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  tradeEndpoint: str('PUMPPORTAL_TRADE_URL', 'https://pumpportal.fun/api/trade-local'),
  tradePool: str('TRADE_POOL', 'auto'),
  maxSolPerTrade: num('MAX_SOL_PER_TRADE', 0.05),
  maxDailySol: num('MAX_DAILY_SOL', 0.25),
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 3),
  minWalletReserveSol: num('MIN_WALLET_RESERVE_SOL', 0.05),
  maxSlippagePct: num('MAX_SLIPPAGE_PCT', 25),
  defaultSlippagePct: num('DEFAULT_SLIPPAGE_PCT', 15),
  priorityFeeSol: num('PRIORITY_FEE_SOL', 0.0005),
  rebuyCooldownMinutes: num('REBUY_COOLDOWN_MINUTES', 60),
  paperStartingSol: num('PAPER_STARTING_SOL', 1),
  paperFeePct: num('PAPER_FEE_PCT', 1.5),
  paperImpactPct: num('PAPER_IMPACT_PCT', 3),

  // ---------- default exit rules (changeable at runtime within bounds)
  takeProfitPct: num('TAKE_PROFIT_PCT', 100),
  takeProfitSellPct: num('TAKE_PROFIT_SELL_PCT', 50),
  stopLossPct: num('STOP_LOSS_PCT', 30),
  trailingStopPct: num('TRAILING_STOP_PCT', 25),
  maxHoldMinutes: num('MAX_HOLD_MINUTES', 60),
  exitOnCreatorSell: bool('EXIT_ON_CREATOR_SELL', true),

  // ---------- auto trading
  autoTradeAllowed: bool('AUTO_TRADE_ALLOWED', false),
  autoMinScore: num('AUTO_MIN_SCORE', 80),
  autoBuySol: num('AUTO_BUY_SOL', 0.02),
  autoMinAgeMinutes: num('AUTO_MIN_AGE_MINUTES', 2),
  autoMaxAgeMinutes: num('AUTO_MAX_AGE_MINUTES', 30),
  autoMinCurvePct: num('AUTO_MIN_CURVE_PCT', 10),
  autoMaxCurvePct: num('AUTO_MAX_CURVE_PCT', 80),
  /** which signal drives auto-buys: early_gainer (volume-surge strategy) | score (generic momentum score) */
  autoStrategy: (str('AUTO_STRATEGY', 'early_gainer') === 'score' ? 'score' : 'early_gainer') as 'early_gainer' | 'score',

  // ---------- early-gainer strategy (volume surge detection)
  eg: {
    minAgeMinutes: num('EG_MIN_AGE_MINUTES', 3),
    maxAgeMinutes: num('EG_MAX_AGE_MINUTES', 240),
    minMcapSol: num('EG_MIN_MCAP_SOL', 35),
    maxMcapSol: num('EG_MAX_MCAP_SOL', 400),
    minVol2mSol: num('EG_MIN_VOL_2M_SOL', 3),
    minRelVol: num('EG_MIN_REL_VOL', 3),
    youngTokenMinutes: num('EG_YOUNG_TOKEN_MINUTES', 6),
    youngMinVol2mSol: num('EG_YOUNG_MIN_VOL_2M_SOL', 6),
    minBuyers2m: num('EG_MIN_BUYERS_2M', 8),
    minNewBuyers2m: num('EG_MIN_NEW_BUYERS_2M', 5),
    minBuyPressure: num('EG_MIN_BUY_PRESSURE', 0.6),
    maxTop10Pct: num('EG_MAX_TOP10_PCT', 35),
    maxTradesPerTrader: num('EG_MAX_TRADES_PER_TRADER', 5),
    bigBuySol: num('EG_BIG_BUY_SOL', 1),
    minScore: num('EG_MIN_SCORE', 65),
    retriggerMinutes: num('EG_RETRIGGER_MINUTES', 60),
    outcomeMinutes: num('EG_OUTCOME_MINUTES', 60),
    requireSocials: bool('EG_REQUIRE_SOCIALS', false),
  },
} as const;

export type Config = typeof config;
