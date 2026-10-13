# Changelog

## 3.1.0 — 2026-10-13
- **Replay backtester** (`npm run backtest`, `src/backtest.ts`): replays recorded stream data through
  the same collector, strategy, journal, risk limits and exits on a simulated clock. Models entry delay,
  fees and price impact. `--set` overrides, `--sweep` grid search (parallel), Markdown and JSON reports.
- **Stream recorder** (`src/recorder.ts`): raw PumpPortal messages to hourly `data/recordings/*.jsonl.gz`.
  Controlled by `RECORD_STREAM` / `RECORD_KEEP_DAYS`.
- **`run_backtest` MCP tool**: backtest the server's own recordings from chat, with allow-listed overrides.
- `src/clock.ts`: all engine time goes through one clock, so replays are faithful.
- `PAPER_FEE_PCT` / `PAPER_IMPACT_PCT` are now configurable (paper mode and backtests).
- Synthetic data generator for smoke tests (`npm run backtest:synthetic`). Reports on synthetic data
  are clearly bannered.
- GitHub-ready docs: new README, `docs/` (STRATEGY, BACKTESTING, DEPLOYMENT, LIVE-TRADING,
  CONFIGURATION), SECURITY, CONTRIBUTING, LICENSE, CI workflow.
- Strategy skips tokens with no trades in the last 2 minutes (large speed-up, same signals).

## 3.0.0 — 2026-10-13
- **Early-gainer strategy** (`src/strategy.ts`): volume-surge detection. Hard gates cover relative
  volume vs the token's own baseline, absolute volume, unique and new buyer wallets, buy pressure,
  concentration, wash-trading and rug filters. A 0–100 score adds breakout, holder growth, big
  buyers and socials. Every threshold is configurable through `EG_*` env vars.
- **Signal journal** (`src/journal.ts`): every signal is tracked for 60 min (peak, low before peak,
  mcap at +5/+15/+60). `get_strategy_performance` reports hit rates and a simulated P&L for the
  current exit rules.
- New tools: `get_early_gainers`, `evaluate_early_gainer`, `get_strategy_performance`,
  `get_signal_journal`, `get_strategy_config`.
- Auto-trading is now driven by strategy signals (`AUTO_STRATEGY=early_gainer`, the default), or
  by the legacy score (`AUTO_STRATEGY=score`).
- Telegram alert on every strategy signal.
- `npm run preflight`: live-mode checks for key, RPC, balance vs limits and a PumpPortal test build.
  It never signs or sends.
- Tagged token pins (`user` / `position` / `journal`), so one owner releasing a token can't drop
  another's tracking. A failed buy no longer leaves the token pinned.
- `@solana/web3.js` pinned to `^1.98.4`; README warns against `npm audit fix --force`.

## 2.0.0 — 2026-10-12
- **Hosted mode**: Streamable HTTP transport (`dist/http.js`) with secret-path or Bearer auth,
  per-IP rate limiting, `/health` probe. Stdio mode kept as `dist/stdio.js`.
- **Trading** via PumpPortal Local Transaction API (sign locally, send via own RPC):
  `buy_token`, `sell_token`, `get_positions`, `get_trade_history`, `trading_status`.
- Paper mode (default) with simulated fees/impact and persistent paper balance.
- Server-side hard limits (per-trade, per-day, open positions, wallet reserve, slippage cap,
  re-buy cooldown) — env only, not changeable through MCP.
- Automatic exits: take profit (partial), stop loss, trailing stop, max hold time, exit on creator sell.
- Optional auto-trading (double-gated: `AUTO_TRADE_ALLOWED` env + `set_auto_trading` tool).
- Kill switch with optional sell-all.
- Persistent state (`data/state-<mode>.json`, atomic writes), positions resume after restart.
- Telegram notifications for buys/sells/kill switch in addition to scanner alerts.
- Deploy kit: PM2 ecosystem file, Nginx config (SSE-safe), one-shot Hostinger VPS setup script.

## 1.0.0 — 2026-10-10
- Stdio MCP scanner: PumpPortal stream, momentum/rug-risk scoring, scanner tools.
