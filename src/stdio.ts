#!/usr/bin/env node
// Local mode for Claude Desktop / Claude Code (no HTTP). Same engine and tools.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Engine } from './engine.js';
import { buildServer } from './tools.js';

const engine = new Engine();
engine.start();
const server = buildServer(engine);

const shutdown = () => {
  engine.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
console.error('[mcp] pumpfun-trader ready on stdio');
