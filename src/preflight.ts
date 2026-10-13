#!/usr/bin/env node
/**
 * Live-mode preflight. Checks key, RPC, balance and that PumpPortal will build a transaction.
 * NEVER signs or sends anything.
 *   node --env-file=.env dist/preflight.js [optional-mint-to-test]
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config.js';

const ok = (m: string) => console.log(`  ✅ ${m}`);
const bad = (m: string) => console.log(`  ❌ ${m}`);
const info = (m: string) => console.log(`  ℹ️  ${m}`);
let failures = 0;

console.log('\npumpfun-trader preflight\n');
console.log(`Mode: ${config.tradingMode}`);
if (config.tradingMode !== 'live') info('TRADING_MODE is paper — checks still run so you can prepare for live.');

// 1. key
let kp: Keypair | null = null;
if (!config.walletPrivateKey) {
  bad('WALLET_PRIVATE_KEY is empty');
  failures++;
} else {
  try {
    kp = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey.trim()));
    ok(`Wallet key valid → ${kp.publicKey.toBase58()}`);
  } catch {
    bad('WALLET_PRIVATE_KEY is not a valid base58 secret key (export it from Phantom: Settings → Manage accounts → Show private key)');
    failures++;
  }
}

// 2. RPC
const conn = new Connection(config.rpcUrl, 'confirmed');
if (config.rpcUrl.includes('api.mainnet-beta.solana.com')) info('Using the PUBLIC Solana RPC — fine for testing, unreliable for live trading. Use Helius/QuickNode.');
try {
  const t0 = Date.now();
  await conn.getLatestBlockhash();
  ok(`RPC reachable (${Date.now() - t0} ms)`);
} catch (e) {
  bad(`RPC failed: ${(e as Error).message}`);
  failures++;
}

// 3. balance vs limits
if (kp) {
  try {
    const bal = (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
    const needed = config.minWalletReserveSol + config.maxSolPerTrade + 0.01;
    (bal >= needed ? ok : bad)(`Balance ${bal.toFixed(4)} SOL (need ≥ ${needed.toFixed(3)} for one max-size trade + reserve + fees)`);
    if (bal < needed) failures++;
    if (bal > config.maxDailySol * 10) info(`Wallet holds a lot more than the daily limit — consider keeping only what the bot needs in it.`);
  } catch (e) {
    bad(`Balance check failed: ${(e as Error).message}`);
    failures++;
  }
}

// 4. PumpPortal builds a transaction (not signed, not sent)
const testMint = process.argv[2];
if (kp && testMint) {
  try {
    const res = await fetch(config.tradeEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: kp.publicKey.toBase58(),
        action: 'buy',
        mint: testMint,
        amount: 0.001,
        denominatedInSol: 'true',
        slippage: config.defaultSlippagePct,
        priorityFee: config.priorityFeeSol,
        pool: config.tradePool,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    ok(`PumpPortal built a test buy for ${testMint} (pool=${config.tradePool}) — NOT signed, NOT sent`);
  } catch (e) {
    bad(`PumpPortal test build failed: ${(e as Error).message} — try TRADE_POOL=pump`);
    failures++;
  }
} else if (kp) {
  info('Pass a live pump.fun mint to also test PumpPortal: node --env-file=.env dist/preflight.js <mint>');
}

// 5. limits summary
console.log('\nHard limits:');
console.log(`  per trade ${config.maxSolPerTrade} SOL | per day ${config.maxDailySol} SOL | open ${config.maxOpenPositions} | reserve ${config.minWalletReserveSol} SOL | slippage ≤ ${config.maxSlippagePct}%`);
console.log(`  auto-trading allowed: ${config.autoTradeAllowed} (strategy ${config.autoStrategy}, ${Math.min(config.autoBuySol, config.maxSolPerTrade)} SOL/trade)`);
console.log(failures ? `\n${failures} problem(s) — fix before going live.\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
