#!/usr/bin/env node

import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import type { CloudOAuthClientSecretProvider } from '../adapters/cloud/cloudOAuth.js';
import { rootLogger } from '../logging/logger.js';
import { buildMcpServer, parseMcpToolProfile } from '../mcp/server.js';
import { ApprovalStore } from '../policy/approvalStore.js';
import { IdempotencyStore } from '../policy/idempotencyStore.js';
import { InMemoryOperationStore } from '../policy/operationStore.js';
import { PlanStore } from '../policy/planStore.js';
import { buildDefaultAdapters, buildDefaultOperationService } from '../server/context.js';
import {
  authenticateBearer,
  correlationId,
  FixedWindowQuota,
  type RemotePrincipal,
} from '../server/remoteSecurity.js';
import { createAgentCoreQlikSecretProvider } from './secrets.js';
import { createAgentCoreStateStores, type AgentCoreStateStores } from './state/index.js';
import { buildManagementContext } from '../management/context.js';
import {
  DynamoManagementStore,
  MemoryManagementStore,
  type ManagementStore,
} from '../management/state.js';

const DEFAULT_PORT = 8000;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_TIMEOUT_MS = 14 * 60 * 1000;
const DEFAULT_REQUESTS_PER_MINUTE = 60;
const MAX_REQUESTS_PER_MINUTE = 10_000;
export const AGENTCORE_MAX_MCP_BODY_BYTES = 1024 * 1024;
const OIDC_DISCOVERY_CACHE_MS = 5 * 60 * 1000;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface AgentCoreRuntimeDependencies {
  readonly managementStore?: ManagementStore;
  readonly environment?: RuntimeEnvironment;
  readonly stateStores?: AgentCoreStateStores;
  readonly cloudClientSecrets?: CloudOAuthClientSecretProvider;
  readonly authenticate?: (
    authorization: string | undefined,
    environment: RuntimeEnvironment,
  ) => Promise<RemotePrincipal>;
}

export interface AgentCoreRuntime {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly localDevelopment: boolean;
}

function required(environment: RuntimeEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for AgentCore Runtime.`);
  return value;
}

function csv(value: string | undefined): readonly string[] | undefined {
  const entries = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries?.length ? Array.from(new Set(entries)) : undefined;
}

function requiredCsv(environment: RuntimeEnvironment, name: string): readonly string[] {
  const entries = csv(required(environment, name));
  if (!entries?.length) throw new Error(`${name} must contain at least one value.`);
  return entries;
}

function requiredSingletonCsv(environment: RuntimeEnvironment, name: string): readonly [string] {
  const entries = requiredCsv(environment, name);
  if (entries.length !== 1) throw new Error(`${name} must contain exactly one value.`);
  return [entries[0] as string];
}

function exactBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function parsePort(value: string | undefined, localDevelopment: boolean): number {
  if (!localDevelopment && value !== undefined && value.trim() !== String(DEFAULT_PORT)) {
    throw new Error('AgentCore Runtime requires PORT=8000.');
  }
  const port = Number(value?.trim() || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535.');
  }
  return port;
}

function parseTimeout(value: string | undefined): number {
  const timeout = Number(value?.trim() || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > DEFAULT_TIMEOUT_MS) {
    throw new Error(
      `QLIK_AGENTCORE_REQUEST_TIMEOUT_MS must be between 1000 and ${DEFAULT_TIMEOUT_MS}.`,
    );
  }
  return timeout;
}

function parseRequestsPerMinute(value: string | undefined): number {
  const limit = Number(value?.trim() || DEFAULT_REQUESTS_PER_MINUTE);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REQUESTS_PER_MINUTE) {
    throw new Error(
      `QLIK_AGENTCORE_REQUESTS_PER_MINUTE must be between 1 and ${MAX_REQUESTS_PER_MINUTE}.`,
    );
  }
  return limit;
}

function localStateStores(): AgentCoreStateStores {
  return {
    plans: new PlanStore(),
    approvals: new ApprovalStore(),
    idempotency: new IdempotencyStore(),
    operations: new InMemoryOperationStore(),
  };
}

function defaultCloudSecretProvider(
  environment: RuntimeEnvironment,
  localDevelopment: boolean,
): CloudOAuthClientSecretProvider | undefined {
  if ((environment.QLIK_HARNESS_TARGET_MODE?.trim().toLowerCase() || 'fixture') !== 'cloud') {
    return undefined;
  }
  if (localDevelopment) {
    const value = required(environment, 'QLIK_CLOUD_OAUTH_CLIENT_SECRET');
    const connectionAlias = required(environment, 'QLIK_CLOUD_CONNECTION_ALIAS');
    return async (connection) => {
      if (connection !== connectionAlias) {
        throw new Error('No Qlik secret is configured for the requested connection alias.');
      }
      return value;
    };
  }
  return createAgentCoreQlikSecretProvider({
    secretId: required(environment, 'QLIK_AGENTCORE_QLIK_SECRET_ID'),
    connectionAlias: required(environment, 'QLIK_CLOUD_CONNECTION_ALIAS'),
  });
}

const oidcDiscoveryCache = new Map<
  string,
  { readonly issuer: string; readonly jwksUri: string; readonly expiresAt: number }
>();

async function discoverIdentityProvider(discoveryUrl: string): Promise<{
  readonly issuer: string;
  readonly jwksUri: string;
}> {
  const cached = oidcDiscoveryCache.get(discoveryUrl);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const parsedUrl = new URL(discoveryUrl);
  if (
    parsedUrl.protocol !== 'https:' ||
    !parsedUrl.pathname.endsWith('/.well-known/openid-configuration')
  ) {
    throw new Error('QLIK_AGENTCORE_JWT_DISCOVERY_URL must be an HTTPS OIDC discovery URL.');
  }
  const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error('OIDC discovery failed.');
  const document = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
  if (typeof document.issuer !== 'string' || typeof document.jwks_uri !== 'string') {
    throw new Error('OIDC discovery returned incomplete issuer metadata.');
  }
  const jwksUrl = new URL(document.jwks_uri);
  if (jwksUrl.protocol !== 'https:') throw new Error('The OIDC JWKS URI must use HTTPS.');
  const discovered = {
    issuer: document.issuer,
    jwksUri: document.jwks_uri,
    expiresAt: Date.now() + OIDC_DISCOVERY_CACHE_MS,
  };
  oidcDiscoveryCache.set(discoveryUrl, discovered);
  return discovered;
}

async function defaultAuthenticate(
  authorization: string | undefined,
  environment: RuntimeEnvironment,
): Promise<RemotePrincipal> {
  if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim()) {
    throw new Error('Bearer authorization is required.');
  }
  const identityProvider = await discoverIdentityProvider(
    required(environment, 'QLIK_AGENTCORE_JWT_DISCOVERY_URL'),
  );
  return authenticateBearer(authorization, {
    audience: required(environment, 'QLIK_AGENTCORE_JWT_AUDIENCE'),
    issuer: identityProvider.issuer,
    jwksUri: identityProvider.jwksUri,
    allowedClientIds: requiredCsv(environment, 'QLIK_AGENTCORE_JWT_ALLOWED_CLIENT_IDS'),
    requiredScopes: requiredSingletonCsv(environment, 'QLIK_AGENTCORE_JWT_REQUIRED_SCOPES'),
  });
}

function localPrincipal(environment: RuntimeEnvironment): RemotePrincipal {
  return {
    subject: environment.QLIK_AGENTCORE_LOCAL_ACTOR?.trim() || 'local-agentcore-actor',
    clientId: 'agentcore-local-development',
    scopes: [],
  };
}

function headerValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

class McpRequestBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly publicMessage: 'invalid request body' | 'payload too large',
    readonly logReason: 'invalid-request-body' | 'request-body-too-large',
  ) {
    super(publicMessage);
    this.name = 'McpRequestBodyError';
  }
}

function discardRemainingBody(request: IncomingMessage): void {
  request.resume();
}

/** Reads one bounded JSON-RPC body and drains, rather than buffers, any oversize remainder. */
async function readMcpJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredHeader = headerValue(request.headers['content-length']);
  if (declaredHeader !== undefined) {
    if (!/^\d+$/u.test(declaredHeader)) {
      discardRemainingBody(request);
      throw new McpRequestBodyError(400, 'invalid request body', 'invalid-request-body');
    }
    const declaredBytes = Number(declaredHeader);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > AGENTCORE_MAX_MCP_BODY_BYTES) {
      discardRemainingBody(request);
      throw new McpRequestBodyError(413, 'payload too large', 'request-body-too-large');
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const body = await new Promise<Buffer>((resolve, reject) => {
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
    };
    const rejectBody = (error: McpRequestBodyError) => {
      cleanup();
      discardRemainingBody(request);
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > AGENTCORE_MAX_MCP_BODY_BYTES) {
        rejectBody(new McpRequestBodyError(413, 'payload too large', 'request-body-too-large'));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes));
    };
    const onAborted = () =>
      rejectBody(new McpRequestBodyError(400, 'invalid request body', 'invalid-request-body'));
    const onError = () =>
      rejectBody(new McpRequestBodyError(400, 'invalid request body', 'invalid-request-body'));
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
  });

  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new McpRequestBodyError(400, 'invalid request body', 'invalid-request-body');
  }
}

function json(response: ServerResponse, status: number, body: object): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Builds the AgentCore HTTP contract without binding a socket, enabling integration tests. */
export function createAgentCoreRuntime(
  dependencies: AgentCoreRuntimeDependencies = {},
): AgentCoreRuntime {
  const environment = Object.freeze({ ...(dependencies.environment ?? process.env) });
  const localDevelopment = exactBoolean(environment.QLIK_AGENTCORE_LOCAL_DEV);
  const host = localDevelopment
    ? environment.QLIK_AGENTCORE_LOCAL_HOST?.trim() || '127.0.0.1'
    : DEFAULT_HOST;
  if (localDevelopment && !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('QLIK_AGENTCORE_LOCAL_HOST must be a loopback address.');
  }
  const port = parsePort(environment.PORT, localDevelopment);
  const timeoutMs = parseTimeout(environment.QLIK_AGENTCORE_REQUEST_TIMEOUT_MS);
  const quota = new FixedWindowQuota(
    parseRequestsPerMinute(environment.QLIK_AGENTCORE_REQUESTS_PER_MINUTE),
  );
  const targetMode = environment.QLIK_HARNESS_TARGET_MODE?.trim().toLowerCase() || 'fixture';
  if (!localDevelopment && targetMode === 'windows') {
    throw new Error(
      'The AgentCore edition currently supports fixture and Qlik Cloud modes; Windows credentials and private routing are not configured.',
    );
  }
  const stateStores =
    dependencies.stateStores ??
    (localDevelopment
      ? localStateStores()
      : createAgentCoreStateStores({
          tableName: required(environment, 'QLIK_AGENTCORE_STATE_TABLE'),
          ...(environment.QLIK_AGENTCORE_PLAN_RETENTION_DAYS !== undefined
            ? {
                planRetentionDays: Number(environment.QLIK_AGENTCORE_PLAN_RETENTION_DAYS),
              }
            : {}),
        }));
  const cloudClientSecrets =
    dependencies.cloudClientSecrets ?? defaultCloudSecretProvider(environment, localDevelopment);
  if (!localDevelopment) {
    required(environment, 'QLIK_AGENTCORE_JWT_DISCOVERY_URL');
    required(environment, 'QLIK_AGENTCORE_JWT_AUDIENCE');
    requiredCsv(environment, 'QLIK_AGENTCORE_JWT_ALLOWED_CLIENT_IDS');
    requiredSingletonCsv(environment, 'QLIK_AGENTCORE_JWT_REQUIRED_SCOPES');
  }
  const authenticate = dependencies.authenticate ?? defaultAuthenticate;
  const requestContext = new AsyncLocalStorage<{
    principal: RemotePrincipal;
    correlation: string;
  }>();
  // Retain provider connection/token caches and fixture objects across requests;
  // actor-bound services and MCP instances remain request-local.
  const adapters = buildDefaultAdapters(cloudClientSecrets, environment);
  const profile = parseMcpToolProfile(environment.QLIK_HARNESS_MCP_ROLE);
  const managementStore =
    dependencies.managementStore ??
    (localDevelopment
      ? new MemoryManagementStore()
      : new DynamoManagementStore({
          tableName: required(environment, 'QLIK_AGENTCORE_STATE_TABLE'),
        }));
  const handler = createMcpHandler(() => {
    const context = requestContext.getStore();
    if (!context) throw new Error('Authenticated request context is unavailable.');
    return buildMcpServer(
      buildDefaultOperationService({
        environment,
        actor: { actor: context.principal.subject, hostClientId: context.principal.clientId },
        adapters,
        plans: stateStores.plans,
        approvals: stateStores.approvals,
        idempotency: stateStores.idempotency,
        operations: stateStores.operations,
        correlationId: () => requestContext.getStore()?.correlation,
      }),
      profile,
      buildManagementContext({
        environment,
        actor: { actor: context.principal.subject, hostClientId: context.principal.clientId },
        store: managementStore,
        cloudClientSecrets,
        cloudAdapter: adapters.cloud,
      }),
    );
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: () => rootLogger.error('AgentCore MCP request processing failed.'),
  });
  const validateLocalHost = localhostHostValidation();
  const validateLocalOrigin = localhostOriginValidation();
  const allowedOrigins = new Set(csv(environment.QLIK_AGENTCORE_ALLOWED_ORIGINS) ?? []);
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
      throw new Error('QLIK_AGENTCORE_ALLOWED_ORIGINS must contain exact HTTPS origins.');
    }
  }

  const server = createServer(async (request, response) => {
    const correlation = correlationId(request.headers);
    response.setHeader('x-correlation-id', correlation);
    const log = rootLogger.child({
      component: 'agentcore-runtime',
      correlationId: correlation,
      agentcoreSessionId: headerValue(request.headers['mcp-session-id']),
    });
    try {
      if (localDevelopment && !validateLocalHost(request, response)) return;
      if (request.method === 'GET' && request.url === '/ping') {
        return json(response, 200, { status: 'Healthy' });
      }
      if (request.url !== '/mcp') return json(response, 404, { error: 'not found' });
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        return json(response, 405, { error: 'method not allowed' });
      }
      const origin = headerValue(request.headers.origin);
      if (localDevelopment) {
        if (!validateLocalOrigin(request, response)) return;
      } else if (origin !== undefined && !allowedOrigins.has(origin)) {
        return json(response, 403, { error: 'origin not allowed', correlationId: correlation });
      }
      let principal: RemotePrincipal;
      try {
        principal = localDevelopment
          ? localPrincipal(environment)
          : await authenticate(request.headers.authorization, environment);
      } catch {
        response.setHeader('www-authenticate', 'Bearer');
        log.warn('AgentCore MCP authentication rejected');
        return json(response, 401, { error: 'unauthorized', correlationId: correlation });
      }
      if (!quota.consume(principal.subject)) {
        response.setHeader('retry-after', '60');
        log.warn('AgentCore MCP request rejected', { reason: 'subject-quota-exceeded' });
        return json(response, 429, { error: 'quota exceeded', correlationId: correlation });
      }
      const parsedBody = await readMcpJsonBody(request);
      await requestContext.run({ principal, correlation }, () =>
        nodeHandler(request, response, parsedBody),
      );
      log.info('AgentCore MCP request completed', {
        subject: principal.subject,
        hostClientId: principal.clientId,
      });
    } catch (error) {
      if (error instanceof McpRequestBodyError) {
        if (error.status === 413) response.setHeader('connection', 'close');
        log.warn('AgentCore MCP request rejected', { reason: error.logReason });
        return json(response, error.status, {
          error: error.publicMessage,
          correlationId: correlation,
        });
      }
      log.warn('AgentCore MCP request rejected', {
        reason: 'internal-processing-failure',
      });
      if (!response.headersSent) {
        json(response, 500, { error: 'internal server error', correlationId: correlation });
      }
    }
  });
  server.once('close', () => {
    void handler.close();
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(timeoutMs, 60_000);
  return { server, host, port, localDevelopment };
}

export async function startAgentCoreRuntime(
  dependencies: AgentCoreRuntimeDependencies = {},
): Promise<AgentCoreRuntime> {
  const runtime = createAgentCoreRuntime(dependencies);
  await new Promise<void>((resolve, reject) => {
    runtime.server.once('error', reject);
    runtime.server.listen(runtime.port, runtime.host, () => {
      runtime.server.off('error', reject);
      resolve();
    });
  });
  rootLogger.info('Amazon Bedrock AgentCore MCP endpoint listening', {
    host: runtime.host,
    port: runtime.port,
    path: '/mcp',
    localDevelopment: runtime.localDevelopment,
  });
  return runtime;
}

async function main(): Promise<void> {
  const runtime = await startAgentCoreRuntime();
  const shutdown = (signal: string) => {
    rootLogger.info(`Received ${signal}; shutting down AgentCore Runtime.`);
    runtime.server.close((error) => {
      if (error) rootLogger.error('AgentCore Runtime shutdown failed', { message: error.message });
      process.exitCode = error ? 1 : 0;
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error) => {
    rootLogger.error('Fatal AgentCore Runtime startup error', {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
