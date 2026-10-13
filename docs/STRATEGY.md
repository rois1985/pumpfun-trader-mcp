# Early-gainer strategy

**Goal:** catch a token at the *start* of its run, when attention suddenly arrives, rather than
after it has already pumped.

**Hypothesis:** the day's big gainers usually start with a burst of volume well above the token's
own normal level, driven by many *new* wallets, with buyers clearly outweighing sellers. Rugs and
pump-and-dumps look similar at first, so a set of distribution and behaviour filters tries to
exclude them.

This is a hypothesis, not a fact. [`BACKTESTING.md`](BACKTESTING.md) explains how to test it on
real data.

Source: [`src/strategy.ts`](../src/strategy.ts). Every tracked token is evaluated every 5 seconds.

## 1. Hard gates (all must pass)

| Gate | Env | Default | Rationale |
|---|---|---|---|
| Age | `EG_MIN_AGE_MINUTES` / `EG_MAX_AGE_MINUTES` | 3–240 min | Skip launch-bot chaos; still early |
| Market cap | `EG_MIN_MCAP_SOL` / `EG_MAX_MCAP_SOL` | 35–400 SOL | "Early" = before it's big (pump.fun starts ≈ 28 SOL) |
| Volume, last 2 min | `EG_MIN_VOL_2M_SOL` | ≥ 3 SOL | Real money arriving |
| Volume for young tokens (< `EG_YOUNG_TOKEN_MINUTES`) | `EG_YOUNG_MIN_VOL_2M_SOL` | ≥ 6 SOL | No baseline yet, so demand more absolute volume |
| Relative volume | `EG_MIN_REL_VOL` | ≥ 3× | Last-2-min volume vs the token's own average 2-min volume over the previous ~10 min |
| Unique buyers, 2 min | `EG_MIN_BUYERS_2M` | ≥ 8 | Many participants, not one wallet |
| New buyer wallets, 2 min | `EG_MIN_NEW_BUYERS_2M` | ≥ 5 | Wallets never seen on this token, which suggests fresh discovery |
| Buy pressure | `EG_MIN_BUY_PRESSURE` | ≥ 0.6, net flow > 0 | Buy SOL / total SOL |
| Top-10 holders | `EG_MAX_TOP10_PCT` | ≤ 35% | Not controlled by a few wallets |
| Trades per trader, 5 min | `EG_MAX_TRADES_PER_TRADER` | ≤ 5 | Wash-trading filter |
| Creator sold | — | must be false | Rug filter |
| Severe flags | — | none | `CREATOR_SOLD`, `SNIPERS_STILL_HOLDING`, `POSSIBLE_WASH_TRADING`, `DUMPED_FROM_PEAK`, `WHALE_CONCENTRATION` |
| Socials (optional) | `EG_REQUIRE_SOCIALS` | off | Twitter/Telegram/website in metadata |

## 2. Score (0–100, must be ≥ `EG_MIN_SCORE`, default 65)

| Component | Max | Calculation |
|---|---|---|
| Relative volume | 25 | Linear from 1× to 8× baseline (young tokens: saturating on absolute volume) |
| Absolute volume | 15 | Saturating on SOL traded in 2 min |
| New wallets and buyer growth | 20 | New buyers (12) plus 2-min buyers vs previous 2 min (8) |
| Breakout | 10 | Market cap > 105% of the high from the previous ~10 min |
| Holder growth | 10 | Holder count change over 5 min |
| Buy pressure | 10 | Linear from 0.5 to 0.85 |
| Big buyers | 5 | Distinct wallets with a single buy ≥ `EG_BIG_BUY_SOL` |
| Socials | 5 | Present in metadata (fetched lazily for near-candidates) |
| Graduation adjustment | −5 | Bonding curve > 90% (dumps around migration are common) |

## 3. On signal

1. The signal is recorded in the **journal** and tracked for `EG_OUTCOME_MINUTES`.
2. A Telegram alert is sent, if configured.
3. If auto-trading is on, the bot buys `AUTO_BUY_SOL`, subject to every hard limit.
4. The same token can't signal again for `EG_RETRIGGER_MINUTES`.

## 4. Exits

These apply to every position, manual or auto. They're checked every 2 seconds against stream prices:

| Order | Rule | Env | Default |
|---|---|---|---|
| 1 | Max hold time | `MAX_HOLD_MINUTES` | 60 |
| 2 | Creator sells | `EXIT_ON_CREATOR_SELL` | true |
| 3 | Stop loss | `STOP_LOSS_PCT` | −30% |
| 4 | Take profit (partial, once) | `TAKE_PROFIT_PCT` / `TAKE_PROFIT_SELL_PCT` | +100%, sell 50% |
| 5 | Trailing stop | `TRAILING_STOP_PCT` | Armed after a 25% gain; fires on a 25% drop from the peak while still in profit |

## Known weaknesses

- **Latency.** By the time a 2-minute window shows a surge, faster bots may already be in. The
  backtester's `--entry-delay` models this; test 3 s, 6 s and 10 s.
- **Coordinated pumps** can fake "new wallets" with fresh wallets funded from one source. On-chain
  funding-source analysis isn't implemented.
- **Holder balances** are estimated from pump.fun trades only. Transfers aren't seen.
- **Thin curves:** at small market caps, your own buy moves the price. Paper and backtest fills
  model this only roughly (`PAPER_IMPACT_PCT`).
