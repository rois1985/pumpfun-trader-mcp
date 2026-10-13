# Configuration

All settings are environment variables, read from `.env` at startup. Copy `.env.example` to `.env`
and restart after changes. **Hard limits can only be changed here, never through MCP.**

## Server

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` |  |
| `HOST` | `127.0.0.1` | keep on localhost; Nginx exposes it over HTTPS |
| `MCP_SECRET` | — | REQUIRED, 32+ chars:  npm run gen-secret |
| `DATA_DIR` | `./data` |  |

## Trading

| Variable | Default | Notes |
|---|---|---|
| `TRADING_MODE` | `paper` | paper \| live   (start with paper!) |
| `WALLET_PRIVATE_KEY` | — | base58 secret key of a DEDICATED burner wallet (live only) |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | use Helius/QuickNode/Triton for live |
| `TRADE_POOL` | `auto` | PumpPortal pool param: auto \| pump \| pump-amm \| raydium ... |
| `PRIORITY_FEE_SOL` | `0.0005` |  |
| `PAPER_STARTING_SOL` | `1` |  |
| `PAPER_FEE_PCT` | `1.5` | simulated fees per side (paper mode + backtests) |
| `PAPER_IMPACT_PCT` | `3` | simulated slippage/price impact per side |
|  |  | *Hard limits — env only, cannot be raised through MCP* |
| `MAX_SOL_PER_TRADE` | `0.05` |  |
| `MAX_DAILY_SOL` | `0.25` |  |
| `MAX_OPEN_POSITIONS` | `3` |  |
| `MIN_WALLET_RESERVE_SOL` | `0.05` |  |
| `MAX_SLIPPAGE_PCT` | `25` |  |
| `DEFAULT_SLIPPAGE_PCT` | `15` |  |
| `REBUY_COOLDOWN_MINUTES` | `60` |  |
|  |  | *Default exit rules (adjustable at runtime via set_exit_rules)* |
| `TAKE_PROFIT_PCT` | `100` |  |
| `TAKE_PROFIT_SELL_PCT` | `50` |  |
| `STOP_LOSS_PCT` | `30` |  |
| `TRAILING_STOP_PCT` | `25` |  |
| `MAX_HOLD_MINUTES` | `60` |  |
| `EXIT_ON_CREATOR_SELL` | `true` |  |
|  |  | *Auto-trading (off unless explicitly allowed here AND enabled via MCP)* |
| `AUTO_TRADE_ALLOWED` | `false` |  |
| `AUTO_STRATEGY` | `early_gainer` | early_gainer (volume-surge signals) \| score (generic momentum score) |
| `AUTO_MIN_SCORE` | `80` |  |
| `AUTO_BUY_SOL` | `0.02` |  |
| `AUTO_MIN_AGE_MINUTES` | `2` |  |
| `AUTO_MAX_AGE_MINUTES` | `30` |  |
| `AUTO_MIN_CURVE_PCT` | `10` |  |
| `AUTO_MAX_CURVE_PCT` | `80` |  |

## Early-Gainer Strategy

| Variable | Default | Notes |
|---|---|---|
|  |  | *A signal fires when ALL gates pass and the strategy score >= EG_MIN_SCORE.* |
| `EG_MIN_AGE_MINUTES` | `3` |  |
| `EG_MAX_AGE_MINUTES` | `240` |  |
| `EG_MIN_MCAP_SOL` | `35` | pump.fun tokens start around ~28 SOL |
| `EG_MAX_MCAP_SOL` | `400` | "early" = before it's already big |
| `EG_MIN_VOL_2M_SOL` | `3` | SOL traded in the last 2 minutes |
| `EG_MIN_REL_VOL` | `3` | last-2-min volume vs the token's own 2-min baseline |
| `EG_YOUNG_TOKEN_MINUTES` | `6` | younger tokens have no baseline → stricter absolute volume |
| `EG_YOUNG_MIN_VOL_2M_SOL` | `6` |  |
| `EG_MIN_BUYERS_2M` | `8` | unique (non-dev) buyers in last 2 min |
| `EG_MIN_NEW_BUYERS_2M` | `5` | of those, wallets never seen on this token before |
| `EG_MIN_BUY_PRESSURE` | `0.6` | buy SOL / total SOL in last 2 min |
| `EG_MAX_TOP10_PCT` | `35` |  |
| `EG_MAX_TRADES_PER_TRADER` | `5` | anti wash-trading |
| `EG_BIG_BUY_SOL` | `1` | a single buy this size counts as a "big buyer" |
| `EG_MIN_SCORE` | `65` |  |
| `EG_RETRIGGER_MINUTES` | `60` | one signal per token per window |
| `EG_OUTCOME_MINUTES` | `60` | how long the journal tracks each signal's outcome |
| `EG_REQUIRE_SOCIALS` | `false` |  |

## Recording (For Backtests)

| Variable | Default | Notes |
|---|---|---|
| `RECORD_STREAM` | `true` | save the raw stream to data/recordings/*.jsonl.gz (~0.3-1 GB/day) |
| `RECORD_KEEP_DAYS` | `7` |  |

## Scanner

| Variable | Default | Notes |
|---|---|---|
| `PUMPPORTAL_WS_URL` | `wss://pumpportal.fun/api/data` |  |
| `MAX_TRACKED_TOKENS` | `1500` |  |
| `MAX_TRADES_PER_TOKEN` | `3000` |  |
| `TRACK_MAX_MINUTES` | `180` |  |
| `DEAD_AFTER_SECONDS` | `600` |  |
| `INITIAL_VIRTUAL_SOL` | `30` |  |
| `GRADUATION_REAL_SOL` | `85` |  |
| `TOKEN_TOTAL_SUPPLY` | `1000000000` |  |
| `EARLY_WINDOW_SECONDS` | `5` |  |

## Alerts (Optional)

| Variable | Default | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — |  |
| `TELEGRAM_CHAT_ID` | — |  |
| `ALERT_MIN_SCORE` | `75` |  |
| `ALERT_COOLDOWN_MINUTES` | `30` |  |

## Notes

- `MCP_SECRET` must be 32+ characters. Generate one with `npm run gen-secret`.
- `DATA_DIR` should be an **absolute path** when running under Claude Desktop.
- `TRADE_POOL`: `auto` lets PumpPortal route bonding-curve and graduated tokens. If it is rejected, try `pump`.
- `INITIAL_VIRTUAL_SOL` / `GRADUATION_REAL_SOL` are pump.fun curve constants used for curve progress %. Adjust them if pump.fun changes its curve.
- Any variable can be overridden for a single backtest with `--set KEY=VAL`. See [BACKTESTING.md](BACKTESTING.md).
