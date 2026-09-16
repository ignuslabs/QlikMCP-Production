#!/usr/bin/env node

import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  type McpServer,
} from '@modelcontextprotocol/server';
import { buildMcpServer } from './mcp/server.js';
import { buildDefaultAdapters, buildDefaultOperationService } from './server/context.js';
import { createDefaultApprovalStore } from './policy/approvalStore.js';
import { createDefaultIdempotencyStore } from './policy/idempotencyStore.js';
import { createDefaultPlanStore } from './policy/planStore.js';
import { createDefaultOperationStore } from './policy/operationStore.js';
import { HttpBodyError, readMcpRequestBody } from './server/httpRequestBody.js';
import type { ActorContext } from './domain/types.js';
import { rootLogger } from './logging/logger.js';
import { authenticateBearer, correlationId, FixedWindowQuota } from './server/remoteSecurity.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for remote mode`);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535');
  }
  return port;
}

function parseBindHost(value: string | undefined): string {
  const host = value?.trim() || '127.0.0.1';
  if (isIP(host)) return host;
  if (host.startsWith('[') || host.endsWith(']')) {
    throw new Error('QLIK_HARNESS_HTTP_HOST must not bracket an IPv6 address');
  }
  try {
    const parsed = new URL(`http://${host}`);
    if (
      !parsed.hostname ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('invalid host');
    }
    return parsed.hostname.toLowerCase();
  } catch {
    throw new Error('QLIK_HARNESS_HTTP_HOST must be a hostname or unbracketed IP address');
  }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function parseAllowedHosts(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const hosts = value.split(',').map((entry) => entry.trim());
  return Array.from(
    new Set(
      hosts.map((host) => {
        try {
          const parsed = new URL(`http://${host}`);
          if (
            !host ||
            host.includes('*') ||
            !parsed.hostname ||
            parsed.port ||
            parsed.username ||
            parsed.password ||
            parsed.pathname !== '/' ||
            parsed.search ||
            parsed.hash
          ) {
            throw new Error('invalid allowed host');
          }
          return parsed.hostname.toLowerCase();
        } catch {
          throw new Error(
            'QLIK_HARNESS_HTTP_ALLOWED_HOSTS must contain comma-separated hostnames without ports',
          );
        }
      }),
    ),
  );
}

function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const origins = value.split(',').map((entry) => entry.trim());
  return Array.from(
    new Set(
      origins.map((origin) => {
        try {
          const parsed = new URL(origin);
          if (
            !origin ||
            (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            parsed.username ||
            parsed.password ||
            parsed.pathname !== '/' ||
            parsed.search ||
            parsed.hash ||
            parsed.origin === 'null'
          ) {
            throw new Error('invalid allowed origin');
          }
          return parsed.origin;
        } catch {
          throw new Error(
            'QLIK_HARNESS_HTTP_ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins',
          );
        }
      }),
    ),
  );
}

function bracketIpv6(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function localHttpAllowlist(host: string, port: number): { hosts: string[]; origins: string[] } {
  const hosts =
    host === 'localhost' || host === '127.0.0.1' || host === '::1'
      ? ['localhost', '127.0.0.1', '[::1]']
      : [bracketIpv6(host)];
  return {
    hosts,
    origins: hosts.map((allowedHost) => new URL(`http://${allowedHost}:${port}`).origin),
  };
}

function requestHostIsAllowed(header: string | string[] | undefined): boolean {
  if (typeof header !== 'string') return false;
  try {
    const parsed = new URL(`http://${header}`);
    return (
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash &&
      allowedHosts.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function requestOriginIsAllowed(header: string | string[] | undefined): boolean {
  if (header === undefined) return true;
  if (typeof header !== 'string') return false;
  try {
    const parsed = new URL(header);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash &&
      parsed.origin !== 'null' &&
      allowedOrigins.has(parsed.origin)
    );
  } catch {
    return false;
  }
}

const port = parsePort(process.env.PORT);
const bindHost = parseBindHost(process.env.QLIK_HARNESS_HTTP_HOST);
const localAllowlist = isLoopbackHost(bindHost) ? localHttpAllowlist(bindHost, port) : undefined;
const configuredAllowedHosts = parseAllowedHosts(process.env.QLIK_HARNESS_HTTP_ALLOWED_HOSTS);
const configuredAllowedOrigins = parseAllowedOrigins(process.env.QLIK_HARNESS_HTTP_ALLOWED_ORIGINS);
if (!localAllowlist && configuredAllowedHosts.length === 0) {
  throw new Error(
    'QLIK_HARNESS_HTTP_ALLOWED_HOSTS is required when QLIK_HARNESS_HTTP_HOST is not loopback',
  );
}
if (!localAllowlist && configuredAllowedOrigins.length === 0) {
  throw new Error(
    'QLIK_HARNESS_HTTP_ALLOWED_ORIGINS is required when QLIK_HARNESS_HTTP_HOST is not loopback',
  );
}
const allowedHosts = new Set(
  configuredAllowedHosts.length > 0 ? configuredAllowedHosts : localAllowlist?.hosts,
);
const allowedOrigins = new Set(
  configuredAllowedOrigins.length > 0 ? configuredAllowedOrigins : localAllowlist?.origins,
);
const timeoutMs = Number(process.env.QLIK_HARNESS_REQUEST_TIMEOUT_MS ?? '30000');
const quota = new FixedWindowQuota(Number(process.env.QLIK_HARNESS_REQUESTS_PER_MINUTE ?? '60'));
const identity = {
  audience: required('QLIK_HARNESS_OIDC_AUDIENCE'),
  issuer: required('QLIK_HARNESS_OIDC_ISSUER'),
  jwksUri: required('QLIK_HARNESS_OIDC_JWKS_URI'),
};
const sessions = new Map<
  string,
  { transport: NodeStreamableHTTPServerTransport; mcp: McpServer; subject: string }
>();
const requestCorrelation = new AsyncLocalStorage<string>();
const requestActor = new AsyncLocalStorage<ActorContext>();
// Provider state and stores belong to the service, independent of MCP sessions.
// Identity stays request-local, including on the stateless protocol revision.
function buildSharedResources() {
  return {
    adapters: buildDefaultAdapters(),
    approvals: createDefaultApprovalStore(),
    idempotency: createDefaultIdempotencyStore(),
    plans: createDefaultPlanStore(),
    operations: createDefaultOperationStore(),
  };
}
let sharedResources: ReturnType<typeof buildSharedResources> | undefined;
function serviceForActor(actor: ActorContext) {
  sharedResources ??= buildSharedResources();
  return buildDefaultOperationService({
    ...sharedResources,
    actor,
    correlationId: () => requestCorrelation.getStore(),
  });
}
const modernHandler = createMcpHandler(
  () => {
    const actor = requestActor.getStore();
    if (!actor) throw new Error('Authenticated identity is required.');
    return buildMcpServer(serviceForActor(actor));
  },
  { legacy: 'reject', responseMode: 'json' },
);
const modernNodeHandler = toNodeHandler(modernHandler);
const healthActor = { actor: 'health-probe', hostClientId: 'health-probe' } as const;
const HEALTH_REVALIDATION_MS = 30_000;

interface ServiceHealthState {
  readonly ready: boolean;
  readonly checkedAt: number;
}

function validateServiceState(): ServiceHealthState {
  try {
    // Construction synchronously loads and validates policy plus every configured
    // durable workflow store. No adapter request or mutation is performed.
    buildDefaultOperationService({ actor: healthActor });
    return { ready: true, checkedAt: Date.now() };
  } catch {
    return { ready: false, checkedAt: Date.now() };
  }
}

let serviceHealthState = validateServiceState();

function serviceStateIsReady(): boolean {
  const now = Date.now();
  if (now - serviceHealthState.checkedAt >= HEALTH_REVALIDATION_MS) {
    serviceHealthState = validateServiceState();
  }
  return serviceHealthState.ready;
}

function json(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const httpServer = createServer(async (request, response) => {
  const correlation = correlationId(request.headers);
  response.setHeader('x-correlation-id', correlation);
  const log = rootLogger.child({ correlationId: correlation });
  const timer = setTimeout(() => {
    if (!response.writableEnded)
      json(response, 504, { error: 'request deadline exceeded', correlationId: correlation });
  }, timeoutMs);
  try {
    if (request.method === 'GET' && request.url === '/healthz') {
      if (!serviceStateIsReady()) {
        return json(response, 503, {
          status: 'unavailable',
          service: 'qlik-ai-harness',
          state: 'initialization-failed',
        });
      }
      return json(response, 200, {
        status: 'ok',
        service: 'qlik-ai-harness',
        state: 'ready',
      });
    }
    if (request.url !== '/mcp') return json(response, 404, { error: 'not found' });
    if (
      !requestHostIsAllowed(request.headers.host) ||
      !requestOriginIsAllowed(request.headers.origin)
    ) {
      log.warn('Remote MCP request rejected', {
        method: request.method,
        reason: 'host-or-origin-validation-failure',
      });
      return json(response, 403, { error: 'forbidden', correlationId: correlation });
    }
    const principal = await authenticateBearer(request.headers.authorization, identity);
    if (!quota.consume(principal.subject)) {
      response.setHeader('retry-after', '60');
      return json(response, 429, { error: 'quota exceeded', correlationId: correlation });
    }
    if (request.method === 'POST' && !isJsonContentType(request.headers['content-type'] ?? '')) {
      return json(response, 415, { error: 'content-type must be application/json' });
    }
    const parsedBody = await readMcpRequestBody(request);
    if (response.writableEnded) return;
    const webRequest = await toWebRequest(request, parsedBody);
    if (!(await isLegacyRequest(webRequest, parsedBody))) {
      await requestActor.run({ actor: principal.subject, hostClientId: principal.clientId }, () =>
        requestCorrelation.run(correlation, () => modernNodeHandler(request, response, parsedBody)),
      );
      return;
    }
    const requestedSession = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(requestedSession) ? requestedSession[0] : requestedSession;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && (!session || session.subject !== principal.subject))
      return json(response, 404, { error: 'session not found', correlationId: correlation });

    let transport: NodeStreamableHTTPServerTransport;
    if (session) {
      transport = session.transport;
    } else {
      const service = serviceForActor({
        actor: principal.subject,
        hostClientId: principal.clientId,
      });
      const mcp = buildMcpServer(service, 'all');
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (createdSessionId) => {
          sessions.set(createdSessionId, { transport, mcp, subject: principal.subject });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        void mcp.close();
      };
      await mcp.connect(transport);
    }
    await requestCorrelation.run(correlation, () =>
      transport.handleRequest(request, response, parsedBody),
    );
    log.info('Remote MCP request completed', {
      method: request.method,
      subject: principal.subject,
      hostClientId: principal.clientId,
    });
  } catch (error) {
    if (error instanceof HttpBodyError) {
      response.setHeader('connection', 'close');
      if (!response.headersSent) json(response, error.status, { error: error.message });
      return;
    }
    log.warn('Remote MCP request rejected', {
      method: request.method,
      reason: 'authentication-or-protocol-failure',
    });
    if (!response.headersSent)
      json(response, 401, { error: 'unauthorized', correlationId: correlation });
  } finally {
    clearTimeout(timer);
  }
});
httpServer.requestTimeout = timeoutMs;
httpServer.listen(port, bindHost, () =>
  rootLogger.info('Streamable HTTP MCP endpoint listening', { host: bindHost, port }),
);
