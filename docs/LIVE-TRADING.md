# Going live

> Live mode signs real Solana transactions. There is no undo. Most pump.fun tokens go to zero.
> Only fund the bot wallet with an amount you're prepared to lose entirely.

## Gate: only go live if…

- [ ] You have **≥ 48–72 h of real recordings** and a backtest with clearly positive average trade %
      **after** fees, run with `--entry-delay` of at least 3000 ms.
- [ ] The result holds on a **different time window** than the one you tuned on.
- [ ] `get_strategy_performance` shows **≥ 50 completed signals** with positive
      `simulatedAvgTradeAfterCostsPct`.
- [ ] You ran paper mode for several days and the paper P&L roughly matches the backtest.

If any box is unchecked, stay in paper mode.

## Steps

1. **Dedicated wallet.** Create a new Phantom account used only by the bot. Fund it with
   `MAX_DAILY_SOL` + `MIN_WALLET_RESERVE_SOL` + ~0.05 SOL for fees.
2. **Export the key.** In Phantom: Settings → Manage accounts → the account → Show private key. This gives a base58 string.
3. **RPC:** a Helius or QuickNode endpoint. The public RPC drops transactions under load.
4. **Edit `.env`:**
   ```env
   TRADING_MODE=live
   WALLET_PRIVATE_KEY=<base58>
   SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
   ```
   Then run `chmod 600 .env`.
5. **Preflight.** It never signs or sends anything:
   ```bash
   npm run build
   npm run preflight -- <a currently active pump.fun mint>
   ```
   It checks the key, RPC latency, balance vs limits, and that PumpPortal builds a transaction.
6. **Restart:** `pm2 restart pumpfun-mcp`, or restart Claude Desktop.
7. **Verify:** ask Claude for `trading_status`. It must show `mode: live` and your bot wallet.
8. **One manual trade** at minimum size. Check it on Solscan, then check `get_positions` (entry, tokens).
   Let an exit fire, or sell manually, and confirm the SOL returned.
9. **Auto-trading:** set `AUTO_TRADE_ALLOWED=true` in `.env`, restart, then ask Claude *"Turn auto-trading on"*.

## While live

- Keep limits small for the first week and compare live P&L with the backtest weekly.
- Re-run backtests on fresh recordings. Market regimes change, and a strategy that worked last month may not now.
- **Emergency:** ask Claude *"Kill switch on and sell everything"*, or on the server run:
  ```bash
  pm2 stop pumpfun-mcp     # stops new buys AND exits — positions are left open
  ```
  Prefer the kill switch with `sellAll`, because stopping the process also stops the stop-losses.

## Costs per round trip (approx.)

| Item | Cost |
|---|---|
| pump.fun bonding-curve fee | ~1% per side |
| PumpPortal fee | 0.5% per trade |
| Priority fee | `PRIORITY_FEE_SOL` per transaction |
| Slippage / price impact | Varies; often several % on small caps |

At 0.02 SOL per trade, fixed priority fees are a meaningful percentage. Factor them in.
