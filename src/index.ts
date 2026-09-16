#!/usr/bin/env node

import 'dotenv/config';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildMcpServer, parseMcpToolProfile } from './mcp/server.js';
import { buildDefaultOperationService } from './server/context.js';
import { rootLogger } from './logging/logger.js';

/**
 * Local STDIO entrypoint. MCP STDIO transport reserves stdout exclusively
 * for JSON-RPC; every diagnostic below goes through `rootLogger`, which
 * writes only to stderr (see docs/08-mcp-server-contract.md, "Transport
 * Policy").
 */
function main(): void {
  const service = buildDefaultOperationService();
  const profile = parseMcpToolProfile(process.env.QLIK_HARNESS_MCP_ROLE);
  const server = serveStdio(() => buildMcpServer(service, profile));

  process.on('SIGINT', () => {
    rootLogger.info('Received SIGINT; shutting down.');
    void server.close().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    rootLogger.info('Received SIGTERM; shutting down.');
    void server.close().finally(() => process.exit(0));
  });

  rootLogger.info('Qlik AI Harness MCP server connected over STDIO.');
}

try {
  main();
} catch (error) {
  rootLogger.error('Fatal startup error', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
