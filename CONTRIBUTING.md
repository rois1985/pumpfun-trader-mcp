# Contributing

1. Fork and create a branch: `git checkout -b feature/my-change`
2. `npm install && npm run build`
3. Make sure the backtester still runs:
   ```bash
   node scripts/make-synthetic-recording.mjs 1 data/synthetic
   node dist/backtest.js --data data/synthetic
   ```
4. Update the docs that your change affects (`README.md`, `docs/*.md`, `CHANGELOG.md`).
5. Open a pull request describing what changed and why.

## Guidelines

- TypeScript strict mode. stdout is reserved for the MCP stdio transport, so log with `console.error`.
- Engine code must take time from `src/clock.ts` (`now()`), never `Date.now()`, so the backtester
  can replay on a simulated clock.
- Anything that can move funds must go through `Trader` so the hard limits apply.
- Strategy changes should come with a backtest comparison on **real** recordings, not only synthetic data.
- Keep `@solana/web3.js` on v1 (`^1.98.4`). Don't run `npm audit fix --force`.
