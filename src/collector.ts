import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import type { MigrationRecord, PumpEvent, Side, TokenState } from './types.js';
import { StreamRecorder } from './recorder.js';
import { now as nowMs } from './clock.js';

const log = (...args: unknown[]) => console.error('[collector]', ...args);
const SUB_BATCH = 50;

/**
 * Maintains ONE websocket to PumpPortal (they ask clients not to open multiple),
 * auto-subscribes to every new launch's trades, and keeps per-token state in memory.
 */
export class PumpCollector extends EventEmitter {
  readonly tokens = new Map<string, TokenState>();
  readonly migrations: MigrationRecord[] = [];

  private ws?: WebSocket;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pendingSub = new Set<string>();
  private pendingUnsub = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private pingTimer?: NodeJS.Timeout;
  private stopped = false;
  private unknownLogged = 0;
  private recorder?: StreamRecorder;

  readonly stats = {
    startedAt: nowMs(),
    connected: false,
    connectedAt: 0,
    reconnects: 0,
    messages: 0,
    creates: 0,
    trades: 0,
    migrations: 0,
    lastMessageAt: 0,
  };

  start(): void {
    if (config.recordStream) this.recorder = new StreamRecorder();
    this.connect();
    this.timers.push(setInterval(() => this.flushSubscriptions(), 750));
    this.timers.push(setInterval(() => this.prune(), 30_000));
  }

  stop(): void {
    this.stopped = true;
    this.recorder?.close();
    this.timers.forEach(clearInterval);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  /**
   * Pin a token so it is never pruned. Tags let several owners pin the same token
   * independently ('user', 'position', 'journal'); it is unpinned only when all release it.
   */
  pin(mint: string, tag: string): TokenState {
    let tok = this.tokens.get(mint);
    if (!tok) {
      tok = this.newToken(mint, nowMs());
      this.tokens.set(mint, tok);
    }
    tok.pins.add(tag);
    this.subscribe(tok);
    return tok;
  }

  unpin(mint: string, tag: string): boolean {
    const tok = this.tokens.get(mint);
    if (!tok) return false;
    tok.pins.delete(tag);
    return true;
  }

  /** Track a token that launched before the server started (history will be partial). */
  watch(mint: string): TokenState {
    return this.pin(mint, 'user');
  }

  unwatch(mint: string): boolean {
    return this.unpin(mint, 'user');
  }

  // ---------------------------------------------------------------- websocket

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(config.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.stats.connected = true;
      this.stats.connectedAt = nowMs();
      this.stats.lastMessageAt = nowMs();
      log('connected to', config.wsUrl);

      this.send({ method: 'subscribeNewToken' });
      this.send({ method: 'subscribeMigration' });
      for (const tok of this.tokens.values()) if (tok.subscribed) this.pendingSub.add(tok.mint);

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (nowMs() - this.stats.lastMessageAt > 90_000) {
          log('stream stale for 90s, reconnecting');
          ws.terminate();
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 20_000);
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      this.recorder?.write(Date.now(), text);
      this.ingest(text);
    });
    ws.on('error', (err) => log('ws error:', err.message));
    ws.on('close', (code) => {
      log('ws closed', code);
      this.stats.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt) + Math.random() * 500;
    this.reconnectAttempt++;
    this.stats.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private send(payload: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  private flushSubscriptions(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const flush = (set: Set<string>, method: string) => {
      const keys = [...set];
      for (let i = 0; i < keys.length; i += SUB_BATCH) {
        const batch = keys.slice(i, i + SUB_BATCH);
        if (this.send({ method, keys: batch })) batch.forEach((k) => set.delete(k));
      }
    };
    flush(this.pendingUnsub, 'unsubscribeTokenTrade');
    flush(this.pendingSub, 'subscribeTokenTrade');
  }

  private subscribe(tok: TokenState): void {
    tok.subscribed = true;
    this.pendingUnsub.delete(tok.mint);
    this.pendingSub.add(tok.mint);
  }

  // ---------------------------------------------------------------- events

  /** Process one raw stream message. Public so the backtester can replay recordings. */
  ingest(raw: string): void {
    let ev: PumpEvent;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    this.ingestEvent(ev);
  }

  /** Process one already-parsed stream event. */
  ingestEvent(ev: PumpEvent): void {
    this.stats.messages++;
    this.stats.lastMessageAt = nowMs();
    if (!ev || typeof ev !== 'object' || !ev.mint) return; // subscription acks etc.

    switch (ev.txType) {
      case 'create':
        return this.onCreate(ev);
      case 'buy':
      case 'sell':
        return this.onTrade(ev, ev.txType);
      case 'migrate':
        return this.onMigrate(ev);
      default:
        if (this.unknownLogged < 5) {
          this.unknownLogged++;
          log('unrecognised event shape (logged for debugging):', JSON.stringify(ev).slice(0, 300));
        }
        if (ev.pool && !ev.txType) this.onMigrate(ev);
    }
  }

  private onCreate(ev: PumpEvent): void {
    const now = nowMs();
    const mint = ev.mint!;
    let tok = this.tokens.get(mint);
    if (!tok) {
      tok = this.newToken(mint, now);
      this.tokens.set(mint, tok);
    }
    tok.name = ev.name ?? tok.name;
    tok.symbol = ev.symbol ?? tok.symbol;
    tok.uri = ev.uri ?? tok.uri;
    tok.creator = ev.traderPublicKey ?? tok.creator;
    tok.createdAt = now;
    tok.seenCreate = true;

    const initialTokens = ev.initialBuy ?? ev.tokenAmount ?? 0;
    tok.creatorInitialTokens = initialTokens;
    if (initialTokens > 0 && tok.creator) {
      tok.balances.set(tok.creator, initialTokens);
      tok.trades.push({
        t: now,
        trader: tok.creator,
        side: 'buy',
        sol: ev.solAmount ?? 0,
        tokens: initialTokens,
        mcapSol: ev.marketCapSol ?? 0,
        sig: ev.signature ?? '',
      });
    }
    this.updateCurve(tok, ev);
    tok.lastTradeAt = now;
    this.subscribe(tok);
    this.stats.creates++;
    this.enforceCap();
    this.emit('create', tok);
  }

  private onTrade(ev: PumpEvent, side: Side): void {
    const now = nowMs();
    const mint = ev.mint!;
    let tok = this.tokens.get(mint);
    if (!tok) {
      // Trade for a token we unsubscribed from but the server still sent — ignore.
      return;
    }
    const trader = ev.traderPublicKey ?? 'unknown';
    const sol = ev.solAmount ?? 0;
    const tokens = ev.tokenAmount ?? 0;

    tok.trades.push({ t: now, trader, side, sol, tokens, mcapSol: ev.marketCapSol ?? tok.mcapSol, sig: ev.signature ?? '' });
    if (tok.trades.length > config.maxTradesPerToken) {
      tok.trades.splice(0, tok.trades.length - config.maxTradesPerToken);
    }

    if (typeof ev.newTokenBalance === 'number') {
      if (ev.newTokenBalance > 0) tok.balances.set(trader, ev.newTokenBalance);
      else tok.balances.delete(trader);
    } else {
      const prev = tok.balances.get(trader) ?? 0;
      const next = side === 'buy' ? prev + tokens : Math.max(0, prev - tokens);
      if (next > 0) tok.balances.set(trader, next);
      else tok.balances.delete(trader);
    }

    const isCreator = trader === tok.creator;
    if (side === 'buy' && !isCreator) {
      tok.buyers.add(trader);
      if (tok.seenCreate && now - tok.createdAt <= config.earlyWindowSeconds * 1000) {
        tok.earlyBuyers.add(trader);
      }
    }
    if (side === 'sell' && isCreator) {
      tok.creatorSold = true;
      tok.creatorSoldSol += sol;
    }
    if (ev.pool && ev.pool !== 'pump' && !tok.migrated) {
      // trades arriving from a post-graduation pool imply migration
      tok.migrated = true;
      tok.migratedAt = now;
      tok.pool = ev.pool;
    }

    this.updateCurve(tok, ev);
    tok.lastTradeAt = now;
    this.stats.trades++;
  }

  private onMigrate(ev: PumpEvent): void {
    const now = nowMs();
    const mint = ev.mint!;
    const tok = this.tokens.get(mint);
    if (tok) {
      tok.migrated = true;
      tok.migratedAt = now;
      tok.pool = ev.pool ?? tok.pool;
    }
    this.migrations.push({ mint, t: now, signature: ev.signature, pool: ev.pool, name: tok?.name, symbol: tok?.symbol });
    if (this.migrations.length > 500) this.migrations.splice(0, this.migrations.length - 500);
    this.stats.migrations++;
    this.emit('migrate', mint);
  }

  private updateCurve(tok: TokenState, ev: PumpEvent): void {
    if (typeof ev.vSolInBondingCurve === 'number') tok.vSol = ev.vSolInBondingCurve;
    if (typeof ev.marketCapSol === 'number' && ev.marketCapSol > 0) {
      tok.mcapSol = ev.marketCapSol;
      if (ev.marketCapSol > tok.peakMcapSol) tok.peakMcapSol = ev.marketCapSol;
    }
  }

  // ---------------------------------------------------------------- housekeeping

  private newToken(mint: string, now: number): TokenState {
    return {
      mint,
      name: '',
      symbol: '',
      creator: '',
      createdAt: now,
      seenCreate: false,
      trades: [],
      balances: new Map(),
      buyers: new Set(),
      earlyBuyers: new Set(),
      creatorInitialTokens: 0,
      creatorSold: false,
      creatorSoldSol: 0,
      vSol: 0,
      mcapSol: 0,
      peakMcapSol: 0,
      lastTradeAt: now,
      migrated: false,
      pins: new Set(),
      subscribed: false,
    };
  }

  private drop(tok: TokenState): void {
    this.tokens.delete(tok.mint);
    this.pendingSub.delete(tok.mint);
    if (tok.subscribed) this.pendingUnsub.add(tok.mint);
  }

  prune(): void {
    const now = nowMs();
    for (const tok of [...this.tokens.values()]) {
      if (tok.pins.size) continue;
      const ageMin = (now - tok.createdAt) / 60_000;
      const idleSec = (now - tok.lastTradeAt) / 1000;
      if (idleSec > config.deadAfterSeconds || ageMin > config.trackMaxMinutes) this.drop(tok);
    }
  }

  private enforceCap(): void {
    if (this.tokens.size <= config.maxTracked + 50) return;
    const target = Math.floor(config.maxTracked * 0.95);
    const candidates = [...this.tokens.values()]
      .filter((t) => !t.pins.size)
      .sort((a, b) => a.lastTradeAt - b.lastTradeAt);
    for (const tok of candidates) {
      if (this.tokens.size <= target) break;
      this.drop(tok);
    }
  }
}
