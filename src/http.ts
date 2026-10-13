#!/usr/bin/env node
import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { Engine } from './engine.js';
import { buildServer } from './tools.js';

const log = (...a: unknown[]) => console.error('[http]', ...a);

if (!config.mcpSecret || config.mcpSecret.length < 32) {
  log('FATAL: MCP_SECRET must be set and at least 32 characters (run: npm run gen-secret)');
  process.exit(1);
}

const engine = new Engine();
engine.start();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Nginx
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------- auth

const digest = (s: string) => createHash('sha256').update(s).digest();
const SECRET = digest(config.mcpSecret);
const matches = (candidate?: string) => !!candidate && timingSafeEqual(digest(candidate), SECRET);

/** Accept the secret either in the URL path (/mcp/<secret>, for claude.ai connectors) or as a Bearer token (Claude Code / other clients). */
function auth(req: Request, res: Response, next: NextFunction) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (matches(req.params.secret) || matches(bearer)) return next();
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
}

// simple fixed-window rate limit per IP
const hits = new Map<string, { n: number; reset: number }>();
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now > h.reset) hits.set(key, { n: 1, reset: now + 60_000 });
  else if (++h.n > 120) return void res.status(429).json({ error: 'Too many requests' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60_000).unref();

// ---------------------------------------------------------------- MCP (stateless Streamable HTTP)

async function handleMcp(req: Request, res: Response) {
  const server = buildServer(engine);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    log('request error:', (e as Error).message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}

const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });

for (const path of ['/mcp', '/mcp/:secret']) {
  app.post(path, rateLimit, auth, handleMcp);
  app.get(path, rateLimit, auth, methodNotAllowed);
  app.delete(path, rateLimit, auth, methodNotAllowed);
}

// public liveness probe — reveals nothing sensitive
app.get('/health', (_req, res) => {
  res.json({ ok: true, streamConnected: engine.collector.stats.connected, uptimeSec: Math.round(process.uptime()) });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

const httpServer = app.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port} (mode=${config.tradingMode})`);
});

const shutdown = () => {
  log('shutting down');
  engine.stop();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
