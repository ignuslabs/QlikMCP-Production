import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let keys: Server;
let child: ChildProcessWithoutNullStreams;
let endpoint = '';
let healthEndpoint = '';
let allowedOrigin = '';
let issuer = '';
let childStderr = '';

function accessToken(audience = 'api://remote-test'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'remote-key' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'remote-user',
      azp: 'conformance-host',
      aud: audience,
      iss: issuer,
      exp: Math.floor(Date.now() / 1000) + 120,
    }),
  ).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString(
    'base64url',
  );
  return `${header}.${payload}.${signature}`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not reserve test port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function post(
  token: string,
  body: object,
  correlation = 'remote-conformance',
  sessionId?: string,
  origin?: string,
): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-correlation-id': correlation,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function postWithHost(host: string, correlation: string): Promise<Response> {
  const target = new URL(endpoint);
  const body = JSON.stringify({});
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken()}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          host,
          'x-correlation-id': correlation,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
            }),
          );
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

beforeAll(async () => {
  keys = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'remote-key', alg: 'RS256' }],
      }),
    );
  });
  await new Promise<void>((resolve) => keys.listen(0, '127.0.0.1', resolve));
  const keysAddress = keys.address();
  if (!keysAddress || typeof keysAddress === 'string') throw new Error('JWKS test server failed');
  issuer = `http://127.0.0.1:${keysAddress.port}`;
  const port = await freePort();
  endpoint = `http://127.0.0.1:${port}/mcp`;
  healthEndpoint = `http://127.0.0.1:${port}/healthz`;
  allowedOrigin = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'src', 'http.ts')],
    {
      cwd: root,
      env: {
        ...process.env,
        QLIK_HARNESS_TARGET_MODE: 'fixture',
        PORT: String(port),
        QLIK_HARNESS_OIDC_AUDIENCE: 'api://remote-test',
        QLIK_HARNESS_OIDC_ISSUER: issuer,
        QLIK_HARNESS_OIDC_JWKS_URI: issuer,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stderr.on('data', (chunk: Buffer) => {
    childStderr += chunk.toString('utf8');
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(healthEndpoint);
      if (response.status === 200) return;
    } catch {
      /* wait for bind */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('remote MCP server did not start');
}, 20_000);

afterAll(() => {
  child.kill();
  keys.close();
});

describe('remote MCP conformance', () => {
  it('negotiates the 2026 protocol and calls tools without a session', async () => {
    const client = new Client(
      { name: 'modern-conformance', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { authorization: `Bearer ${accessToken()}` } },
    });
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe('modern');
      expect(transport.sessionId).toBeUndefined();
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain('qlik_get_readiness');
      const readiness = await client.callTool({ name: 'qlik_get_readiness', arguments: {} });
      expect(readiness.isError).not.toBe(true);
      expect((readiness.structuredContent as { status: string }).status).toBe('ready');
      const invalid = await client.callTool({
        name: 'qlik_get_readiness',
        arguments: { extra: 1 },
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('rejects modern header/body method mismatches', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken()}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 901,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(response.status).toBe(400);
    const result = (await response.json()) as { error: { code: number } };
    expect(result.error.code).toBe(-32020);
  });

  it('bounds oversized request bodies before dispatch', async () => {
    const response = await post(accessToken(), { padding: 'x'.repeat(1024 * 1024) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'request body too large' });
  });

  it('serves a non-secret health probe without authentication', async () => {
    const response = await fetch(healthEndpoint);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'qlik-ai-harness',
      state: 'ready',
    });
    expect(childStderr).toContain(`"host":"127.0.0.1"`);
  });

  it('accepts an approved local Origin and rejects a disallowed Origin before authentication', async () => {
    const approved = await post(
      accessToken(),
      {
        jsonrpc: '2.0',
        id: 90,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'origin-conformance', version: '1' },
        },
      },
      'approved-origin',
      undefined,
      allowedOrigin,
    );
    expect(approved.status).toBe(200);

    const disallowed = await post(
      accessToken(),
      {},
      'disallowed-origin',
      undefined,
      'https://attacker.example',
    );
    expect(disallowed.status).toBe(403);
    await expect(disallowed.json()).resolves.toEqual({
      error: 'forbidden',
      correlationId: 'disallowed-origin',
    });

    const disallowedHost = await postWithHost('attacker.example', 'disallowed-host');
    expect(disallowedHost.status).toBe(403);
    await expect(disallowedHost.json()).resolves.toEqual({
      error: 'forbidden',
      correlationId: 'disallowed-host',
    });
  });

  it('fails closed when a non-loopback bind omits explicit Host and Origin allowlists', async () => {
    const rejected = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(root, 'src', 'http.ts'),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          QLIK_HARNESS_TARGET_MODE: 'fixture',
          PORT: String(await freePort()),
          QLIK_HARNESS_HTTP_HOST: '0.0.0.0',
          QLIK_HARNESS_HTTP_ALLOWED_HOSTS: '',
          QLIK_HARNESS_HTTP_ALLOWED_ORIGINS: '',
          QLIK_HARNESS_OIDC_AUDIENCE: 'api://remote-test',
          QLIK_HARNESS_OIDC_ISSUER: issuer,
          QLIK_HARNESS_OIDC_JWKS_URI: issuer,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    rejected.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exitCode = await new Promise<number | null>((resolve) => rejected.once('exit', resolve));
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('QLIK_HARNESS_HTTP_ALLOWED_HOSTS is required');
  });

  it('reports unavailable when durable service state cannot initialize', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qlik-health-state-'));
    const corruptStore = path.join(directory, 'operations.json');
    writeFileSync(corruptStore, '{not valid json', 'utf8');
    const unhealthyPort = await freePort();
    const unhealthyEndpoint = `http://127.0.0.1:${unhealthyPort}/healthz`;
    const unhealthy = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(root, 'src', 'http.ts'),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          QLIK_HARNESS_TARGET_MODE: 'fixture',
          PORT: String(unhealthyPort),
          QLIK_HARNESS_OIDC_AUDIENCE: 'api://remote-test',
          QLIK_HARNESS_OIDC_ISSUER: issuer,
          QLIK_HARNESS_OIDC_JWKS_URI: issuer,
          QLIK_HARNESS_OPERATION_STORE_PATH: corruptStore,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );

    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          response = await fetch(unhealthyEndpoint);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      expect(response?.status).toBe(503);
      await expect(response?.json()).resolves.toEqual({
        status: 'unavailable',
        service: 'qlik-ai-harness',
        state: 'initialization-failed',
      });
    } finally {
      unhealthy.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it('serves repeated health checks from bounded cached state instead of reparsing stores', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qlik-health-cache-'));
    const operationStore = path.join(directory, 'operations.json');
    const cachedPort = await freePort();
    const cachedEndpoint = `http://127.0.0.1:${cachedPort}/healthz`;
    const cached = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(root, 'src', 'http.ts'),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          QLIK_HARNESS_TARGET_MODE: 'fixture',
          PORT: String(cachedPort),
          QLIK_HARNESS_OIDC_AUDIENCE: 'api://remote-test',
          QLIK_HARNESS_OIDC_ISSUER: issuer,
          QLIK_HARNESS_OIDC_JWKS_URI: issuer,
          QLIK_HARNESS_OPERATION_STORE_PATH: operationStore,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );

    try {
      let first: Response | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          first = await fetch(cachedEndpoint);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      expect(first?.status).toBe(200);

      // If a probe rebuilt the service, this newly corrupt store would make it
      // fail. Calls inside the bounded cache window remain cheap and stable.
      writeFileSync(operationStore, '{newly corrupt json', 'utf8');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await fetch(cachedEndpoint)).status).toBe(200);
      }
    } finally {
      cached.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it('rejects missing and wrong-audience bearer tokens without leaking detail', async () => {
    expect((await fetch(endpoint, { method: 'POST' })).status).toBe(401);
    expect((await post(accessToken('wrong-audience'), {})).status).toBe(401);
  });

  it('accepts a native client with no Origin, initializes, and propagates correlation', async () => {
    const response = await post(accessToken(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'remote-conformance', version: '1' },
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe('remote-conformance');
    const sessionId = response.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    const message = (await response.json()) as {
      result?: { serverInfo?: { name?: string }; instructions?: string };
    };
    expect(message.result?.serverInfo?.name).toBe('qlik-ai-harness');
    expect(message.result?.instructions).toContain(
      'qlik_get_readiness; discover and plan; preview; request a separately authenticated reviewer',
    );
    expect(message.result?.instructions).toContain('separately authenticated reviewer');
    expect(message.result?.instructions).toContain('then apply only the unchanged approved plan');
    expect(message.result?.instructions?.length).toBeLessThanOrEqual(512);

    await post(
      accessToken(),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      'remote-conformance',
      sessionId ?? undefined,
    );
    const toolsResponse = await post(
      accessToken(),
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      'remote-conformance',
      sessionId ?? undefined,
    );
    const toolsMessage = (await toolsResponse.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(toolsMessage.result?.tools?.map((tool) => tool.name).sort()).toEqual(
      [
        'qlik_apply_sheet',
        'qlik_plan_sheet',
        'qlik_preview_sheet',
        'qlik_verify_sheet',
        'qlik_apply_visualization',
        'qlik_get_app_catalog',
        'qlik_get_operation',
        'qlik_get_readiness',
        'qlik_list_apps',
        'qlik_list_sheet_objects',
        'qlik_plan_visualization',
        'qlik_preview_visualization',
        'qlik_request_visualization_approval',
        'qlik_approve_visualization_request',
        'qlik_reject_visualization_request',
        'qlik_get_visualization_approval',
      ].sort(),
    );

    const auditCorrelation = 'remote-operation-audit-correlation';
    const appsResponse = await post(
      accessToken(),
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'qlik_list_apps', arguments: { connection: 'cloud-dev' } },
      },
      auditCorrelation,
      sessionId ?? undefined,
    );
    expect(appsResponse.status).toBe(200);
    for (let attempt = 0; attempt < 40 && !childStderr.includes(auditCorrelation); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(childStderr).toContain(`"qlik.correlation.id":"${auditCorrelation}"`);
  });
});
