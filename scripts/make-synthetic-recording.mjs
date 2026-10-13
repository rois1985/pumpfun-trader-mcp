#!/usr/bin/env node
/**
 * Generates a SYNTHETIC recording in the same format as the live recorder, for smoke-testing
 * the backtester (CI, first-time setup). Results on this data say NOTHING about real markets.
 *
 *   node scripts/make-synthetic-recording.mjs [hours=6] [outDir=data/synthetic] [seed=42]
 *
 * Token archetypes and their (made-up) frequencies:
 *   dud 80%   — a handful of trades, dies
 *   pnd 10%   — volume surge, then coordinated dump within ~1 minute
 *   rug 5%    — surge, then creator sells everything within ~1 minute
 *   slow 3%   — steady organic grind, no surge
 *   runner 2% — surge from new wallets, sustained climb with pullbacks
 */
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';

const hours = Number(process.argv[2] ?? 6);
const outDir = process.argv[3] ?? 'data/synthetic';
let seed = Number(process.argv[4] ?? 42);
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rand() * a.length)];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const id = (n = 44) => Array.from({ length: n }, () => pick(B58)).join('');

const K = 30 * 1_073_000_000; // pump.fun virtual reserves constant product (SOL * tokens)
const start = Date.parse('2026-10-01T00:00:00Z');
const end = start + hours * 3600_000;
const events = [];

function token(t0, kind) {
  const mint = id();
  const creator = id();
  let vSol = 30;
  let vTok = K / vSol;
  const bal = new Map();
  const mcap = () => (vSol * vSol) / (K / 1e9);
  const emit = (t, trader, type, sol, tokens) =>
    events.push({
      ts: Math.round(t),
      m: {
        signature: id(88), mint, traderPublicKey: trader, txType: type,
        tokenAmount: tokens, solAmount: sol, newTokenBalance: bal.get(trader) ?? 0,
        bondingCurveKey: 'curve', vTokensInBondingCurve: vTok, vSolInBondingCurve: vSol,
        marketCapSol: mcap(), pool: 'pump',
      },
    });
  const buy = (t, w, sol) => {
    const nv = vSol + sol * 0.99;
    const out = vTok - K / nv;
    vSol = nv; vTok = K / nv;
    bal.set(w, (bal.get(w) ?? 0) + out);
    emit(t, w, 'buy', sol, out);
  };
  const sell = (t, w, frac) => {
    const held = bal.get(w) ?? 0;
    if (held <= 0) return;
    const tk = held * frac;
    const nt = vTok + tk;
    const nv = K / nt;
    const out = (vSol - nv) * 0.99;
    vSol = nv; vTok = nt;
    bal.set(w, held - tk);
    emit(t, w, 'sell', out, tk);
  };

  // create (dev initial buy)
  const initSol = 0.5 + rand() * 1.5;
  const nv = 30 + initSol;
  const initTok = vTok - K / nv;
  vSol = nv; vTok = K / nv; bal.set(creator, initTok);
  events.push({ ts: t0, m: { signature: id(88), mint, traderPublicKey: creator, txType: 'create', initialBuy: initTok, solAmount: initSol,
    bondingCurveKey: 'curve', vTokensInBondingCurve: vTok, vSolInBondingCurve: vSol, marketCapSol: mcap(),
    name: `Synth ${kind}`, symbol: (kind.slice(0, 3) + id(3)).toUpperCase(), uri: '' } });

  const holders = [];
  let t = t0 + 2000;
  // quiet phase
  const quiet = kind === 'dud' ? 2 + rand() * 6 : 4 + rand() * 20; // minutes
  while (t < t0 + quiet * 60_000) {
    const w = rand() < 0.5 && holders.length ? pick(holders) : id();
    if (rand() < 0.65) { buy(t, w, 0.05 + rand() * 0.4); holders.push(w); } else sell(t, w, 0.5 + rand() * 0.5);
    t += 8000 + rand() * 40000;
  }
  if (kind === 'dud') return;

  if (kind === 'slow') {
    for (let i = 0; i < 300 && t < end; i++) {
      const w = rand() < 0.4 && holders.length ? pick(holders) : id();
      if (rand() < 0.58) { buy(t, w, 0.1 + rand() * 0.5); holders.push(w); } else sell(t, w, 0.3 + rand() * 0.7);
      t += 6000 + rand() * 20000;
    }
    return;
  }

  // surge phase (all non-dud fast types look similar here — that's the point)
  const surgeLen = 40 + rand() * 140; // seconds
  const surgeEnd = t + surgeLen * 1000;
  while (t < surgeEnd) {
    const w = id();
    buy(t, w, 0.2 + rand() * (rand() < 0.15 ? 2 : 0.8));
    holders.push(w);
    if (rand() < 0.15 && holders.length > 3) sell(t + 500, pick(holders), 0.5 + rand() * 0.5);
    t += 1500 + rand() * 3000;
  }

  if (kind === 'rug') {
    t += 5_000 + rand() * 55_000;
    sell(t, creator, 1);
    for (let i = 0; i < 25; i++) { sell(t + 1000 + i * 2000, pick(holders), 1); }
    return;
  }
  if (kind === 'pnd') {
    t += rand() * 60_000;
    for (let i = 0; i < 60; i++) { sell(t, pick(holders), 0.6 + rand() * 0.4); t += 1000 + rand() * 3000; }
    return;
  }
  // runner: sustained climb with pullbacks, eventually fades
  const runMin = 20 + rand() * 60;
  const runEnd = t + runMin * 60_000;
  while (t < runEnd && t < end) {
    const w = rand() < 0.3 && holders.length ? pick(holders) : id();
    if (rand() < 0.62) { buy(t, w, 0.2 + rand() * 1.2); holders.push(w); } else sell(t, w, 0.3 + rand() * 0.7);
    t += 1500 + rand() * 6000;
  }
  for (let i = 0; i < 80 && t < end; i++) { sell(t, pick(holders), 0.5 + rand() * 0.5); t += 3000 + rand() * 9000; }
}

for (let t = start; t < end; t += 4000 + rand() * 8000) {
  const x = rand();
  token(t, x < 0.8 ? 'dud' : x < 0.9 ? 'pnd' : x < 0.95 ? 'rug' : x < 0.98 ? 'slow' : 'runner');
}
events.sort((a, b) => a.ts - b.ts);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'SYNTHETIC'), 'Generated test data. Backtest results on this folder say nothing about real markets.\n');
const byHour = new Map();
for (const e of events) {
  const k = new Date(e.ts).toISOString().slice(0, 13);
  if (!byHour.has(k)) byHour.set(k, []);
  byHour.get(k).push(e);
}
for (const [k, list] of byHour) {
  const gz = createGzip();
  gz.pipe(createWriteStream(join(outDir, `${k}.jsonl.gz`)));
  for (const e of list) gz.write(JSON.stringify(e) + '\n');
  gz.end();
}
console.log(`SYNTHETIC recording: ${events.length} events, ${hours} h, ${byHour.size} files → ${outDir}`);
