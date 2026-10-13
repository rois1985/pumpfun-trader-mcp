import { Connection, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config.js';

const log = (...a: unknown[]) => console.error('[executor]', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Fill {
  signature?: string;
  sol: number; // SOL spent (buy) or received (sell), always positive
  tokens: number; // tokens received (buy) or sold (sell), always positive
}

export interface Executor {
  readonly mode: 'paper' | 'live';
  readonly publicKey: string | null;
  getSolBalance(): Promise<number>;
  /** price = current SOL per token from the stream (may be 0 if unknown) */
  buy(mint: string, sol: number, slippagePct: number, price: number): Promise<Fill>;
  sell(mint: string, percent: number, slippagePct: number, price: number, tokensHeld: number): Promise<Fill>;
}

// ---------------------------------------------------------------- live

export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;
  readonly publicKey: string;
  private kp: Keypair;
  private conn: Connection;

  constructor() {
    if (!config.walletPrivateKey) throw new Error('TRADING_MODE=live requires WALLET_PRIVATE_KEY');
    try {
      this.kp = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey.trim()));
    } catch {
      throw new Error('WALLET_PRIVATE_KEY is not a valid base58 secret key');
    }
    this.publicKey = this.kp.publicKey.toBase58();
    this.conn = new Connection(config.rpcUrl, 'confirmed');
    log('live wallet', this.publicKey);
  }

  async getSolBalance(): Promise<number> {
    return (await this.conn.getBalance(this.kp.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
  }

  async buy(mint: string, sol: number, slippagePct: number, price: number): Promise<Fill> {
    const signature = await this.send({ action: 'buy', mint, amount: sol, denominatedInSol: 'true', slippage: slippagePct });
    const d = await this.analyze(signature, mint);
    return {
      signature,
      sol: d ? Math.max(0, -d.solDelta) : sol,
      tokens: d && d.tokenDelta > 0 ? d.tokenDelta : price > 0 ? sol / price : 0,
    };
  }

  async sell(mint: string, percent: number, slippagePct: number, price: number, tokensHeld: number): Promise<Fill> {
    const signature = await this.send({
      action: 'sell',
      mint,
      amount: `${Math.round(percent)}%`,
      denominatedInSol: 'false',
      slippage: slippagePct,
    });
    const d = await this.analyze(signature, mint);
    const estTokens = (tokensHeld * percent) / 100;
    return {
      signature,
      sol: d ? Math.max(0, d.solDelta) : estTokens * price,
      tokens: d && d.tokenDelta < 0 ? -d.tokenDelta : estTokens,
    };
  }

  /** Ask PumpPortal for an unsigned tx, sign locally, send through our own RPC, wait for confirmation. */
  private async send(params: Record<string, unknown>): Promise<string> {
    const res = await fetch(config.tradeEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: this.publicKey,
        priorityFee: config.priorityFeeSol,
        pool: config.tradePool,
        ...params,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) {
      const text = await res.text().catch(() => '');
      throw new Error(`PumpPortal ${res.status} ${res.statusText} ${text.slice(0, 200)}`.trim());
    }
    const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    tx.sign([this.kp]);
    const signature = await this.conn.sendTransaction(tx, { maxRetries: 3 });
    await this.waitConfirmed(signature);
    return signature;
  }

  private async waitConfirmed(signature: string, timeoutMs = 60_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { value } = await this.conn.getSignatureStatuses([signature]);
      const st = value[0];
      if (st?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(st.err)} (${signature})`);
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return;
      await sleep(1500);
    }
    throw new Error(`Not confirmed within ${timeoutMs / 1000}s — check https://solscan.io/tx/${signature}`);
  }

  /** Real SOL and token deltas for our wallet from the confirmed transaction. */
  private async analyze(signature: string, mint: string): Promise<{ solDelta: number; tokenDelta: number } | null> {
    for (let i = 0; i < 6; i++) {
      try {
        const tx = await this.conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (tx?.meta) {
          const solDelta = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / LAMPORTS_PER_SOL; // index 0 = fee payer = us
          const sum = (arr: typeof tx.meta.postTokenBalances) =>
            (arr ?? [])
              .filter((b) => b.mint === mint && b.owner === this.publicKey)
              .reduce((a, b) => a + (b.uiTokenAmount.uiAmount ?? 0), 0);
          return { solDelta, tokenDelta: sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances) };
        }
      } catch (e) {
        log('getTransaction failed:', (e as Error).message);
      }
      await sleep(1500);
    }
    log('could not analyze', signature, '— using estimates');
    return null;
  }
}

// ---------------------------------------------------------------- paper

/** Simulated fills at stream price with fee + slippage haircut. Balance lives in persisted state. */
export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const;
  readonly publicKey = null;
  static readonly FEE = config.paperFeePct / 100; // ~pump.fun fee + PumpPortal fee
  static readonly IMPACT = config.paperImpactPct / 100; // assumed slippage / price impact

  constructor(private getBalance: () => number) {}

  async getSolBalance(): Promise<number> {
    return this.getBalance();
  }

  async buy(_mint: string, sol: number, _slip: number, price: number): Promise<Fill> {
    if (price <= 0) throw new Error('No live price for this token yet — wait for a trade on the stream');
    const effective = sol * (1 - PaperExecutor.FEE);
    return { sol, tokens: effective / (price * (1 + PaperExecutor.IMPACT)) };
  }

  async sell(_mint: string, percent: number, _slip: number, price: number, tokensHeld: number): Promise<Fill> {
    if (price <= 0) throw new Error('No live price for this token yet');
    const tokens = (tokensHeld * percent) / 100;
    const gross = tokens * price * (1 - PaperExecutor.IMPACT);
    return { sol: gross * (1 - PaperExecutor.FEE), tokens };
  }
}
