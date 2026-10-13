# Security

This server can sign Solana transactions with a real wallet. Treat it accordingly.

## Secrets

| Secret | Where | Never |
|---|---|---|
| `WALLET_PRIVATE_KEY` | `.env` on the server only (`chmod 600 .env`) | committed, pasted in chats, screenshots or issues |
| `MCP_SECRET` | `.env`, plus your Claude connector URL | shared; anyone with it can trade within your limits |
| `TELEGRAM_BOT_TOKEN` | `.env` | committed |

`.env` is in `.gitignore`. Before every push, check with `git status` that it isn't staged.

## Design guarantees

- The private key never leaves the process and is never returned by any MCP tool. PumpPortal
  only builds an unsigned transaction; signing happens locally.
- Hard risk limits (`MAX_SOL_PER_TRADE`, `MAX_DAILY_SOL`, `MAX_OPEN_POSITIONS`,
  `MIN_WALLET_RESERVE_SOL`, `MAX_SLIPPAGE_PCT`) are read from env at startup and can't be raised
  through MCP.
- `run_backtest` only accepts an allow-list of strategy/exit overrides. Secrets, paths and `NODE_*`
  variables are rejected.
- The MCP endpoint needs the secret (URL path or `Authorization: Bearer`) and is rate-limited per
  IP. Nginx config disables access logs so the secret path isn't written to disk.

## Recommendations

- Use a **dedicated wallet** holding only what the bot may spend.
- Rotate `MCP_SECRET` if you think the URL leaked: edit `.env`, restart, update the connector.
- Keep the VPS patched (`apt upgrade`), with SSH key login and `ufw` enabled. The setup script
  opens only SSH and Nginx.
- Use the kill switch (`kill_switch` with `sellAll: true`) if anything looks wrong.

## Reporting a vulnerability

Please don't open a public issue. Contact the maintainer privately through GitHub with the
details and steps to reproduce.
