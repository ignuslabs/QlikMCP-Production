import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENTCORE_MAX_MCP_BODY_BYTES,
  createAgentCoreRuntime,
} from '../../src/agentcore/runtime.js';
import { ApprovalStore } from '../../src/policy/approvalStore.js';
import { IdempotencyStore } from '../../src/policy/idempotencyStore.js';
import { InMemoryOperationStore } from '../../src/policy/operationStore.js';
import { PlanStore } from '../../src/policy/planStore.js';
import { MemoryManagementStore } from '../../src/management/state.js';
import { ARTIFACT_CHUNK_BYTES } from '../../src/management/artifacts.js';
import type * as RestProviderModule from '../../src/management/cloudRestProvider.js';

const managementProvider = vi.hoisted(() => ({
  constructed: vi.fn(),
  inspect:
    vi.fn<(action: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
  execute:
    vi.fn<(action: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
  verify: vi.fn<() => Promise<Record<string, unknown>>>(),
}));

vi.mock('../../src/management/cloudRestProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RestProviderModule>();
  return {
    ...actual,
    CloudRestManagementProvider: class {
      constructor() {
        managementProvider.constructed();
      }
      inspect(action: string, input: Record<string, unknown>) {
        return managementProvider.inspect(action, input);
      }
      execute(action: string, input: Record<string, unknown>) {
        return managementProvider.execute(action, input);
      }
      verify() {
        return managementProvider.verify();
      }
    },
  };
});

beforeEach(() => {
  managementProvider.constructed.mockClear();
  managementProvider.inspect.mockReset().mockImplementation(async (_action, input) => ({
    exists: true,
    appId: input.appId,
    spaceId: 'management-space',
    ...(Object.hasOwn(input, 'spaceId') ? { targetSpaceId: input.spaceId } : {}),
  }));
  managementProvider.execute.mockReset().mockImplementation(async (action, input) =>
    action === 'datafile.upload'
      ? {
          fileId: 'uploaded-file',
          spaceId: input.spaceId,
          name: input.name,
          sourceVersion: 'a'.repeat(64),
        }
      : { appId: input.appId, spaceId: 'management-space', sourceVersion: 'a'.repeat(64) },
  );
  managementProvider.verify.mockReset().mockResolvedValue({ verified: true });
});

async function rpcBody(response: Response): Promise<unknown> {
  const body = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .at(-1);
    if (!data) throw new Error('MCP stream has no response.');
    return JSON.parse(data.slice(6)) as unknown;
  }
  return JSON.parse(body) as unknown;
}

const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'agentcore-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const servers: ReturnType<typeof createAgentCoreRuntime>['server'][] = [];

function inMemoryState() {
  return {
    plans: new PlanStore(),
    approvals: new ApprovalStore(),
    idempotency: new IdempotencyStore(),
    operations: new InMemoryOperationStore(),
  };
}

async function listen(runtime: ReturnType<typeof createAgentCoreRuntime>): Promise<string> {
  servers.push(runtime.server);
  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const address = runtime.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: (typeof servers)[number]): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

interface ManagementToolReply {
  resultType: string;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text: string }>;
}

async function managementFixture(enabled = true) {
  const managementStore = new MemoryManagementStore();
  const cloudClientSecrets = vi.fn(async () => 'synthetic-unused-secret');
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const authenticate = vi.fn(async (authorization: string | undefined) => {
    const token = authorization?.slice(7) ?? 'unknown';
    return {
      subject: token === 'requester-other-client' ? 'requester' : token,
      clientId: token === 'requester-other-client' ? 'foreign-client' : 'test-client',
      scopes: ['qlik.invoke'],
    };
  });
  const runtime = createAgentCoreRuntime({
    environment: {
      QLIK_HARNESS_TARGET_MODE: 'cloud',
      QLIK_CLOUD_CONNECTION_ALIAS: 'management-cloud',
      QLIK_CLOUD_TENANT_HOST: 'https://tenant.example.test',
      QLIK_CLOUD_OAUTH_CLIENT_ID: 'synthetic-client',
      QLIK_CLOUD_ENVIRONMENT: 'test',
      QLIK_CLOUD_READINESS_APPROVED: 'true',
      QLIK_CLOUD_READINESS_EXPIRES_AT: expiresAt,
      QLIK_CLOUD_READINESS_CAN_READ: 'true',
      QLIK_CLOUD_READINESS_CAN_PREVIEW: 'true',
      QLIK_CLOUD_READINESS_CAN_WRITE_DESIGNATED_SHEET: 'false',
      QLIK_CLOUD_READINESS_CLEANUP_VERIFIED: 'false',
      QLIK_AGENTCORE_JWT_DISCOVERY_URL: 'https://identity.example/.well-known/openid-configuration',
      QLIK_AGENTCORE_JWT_AUDIENCE: 'test',
      QLIK_AGENTCORE_JWT_ALLOWED_CLIENT_IDS: 'test-client,foreign-client',
      QLIK_AGENTCORE_JWT_REQUIRED_SCOPES: 'qlik.invoke',
      ...(enabled
        ? {
            QLIK_MANAGEMENT_POLICY_JSON: JSON.stringify({
              version: 1,
              enabled: true,
              environment: 'test',
              grants: ['requester', 'other-actor'].map((actor) => ({
                actor,
                clientId: 'test-client',
                connection: 'management-cloud',
                actions: ['app.get', 'app.list', 'datafile.upload', 'artifact.read'],
                spaceIds: ['management-space'],
                requireApproval: false,
                expiresAt,
              })),
              reviewers: [],
            }),
          }
        : {}),
    },
    authenticate,
    cloudClientSecrets,
    stateStores: inMemoryState(),
    managementStore,
  });
  const origin = await listen(runtime);
  let id = 0;
  const request = async (method: string, params: Record<string, unknown>, actor = 'requester') => {
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        authorization: `Bearer ${actor}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method,
        params: {
          ...params,
          _meta: { ...modernMeta, actor: 'requester', hostClientId: 'test-client' },
        },
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await rpcBody(response)) as { result?: Record<string, unknown>; error?: unknown };
  };
  const call = async (name: string, args: Record<string, unknown>, actor = 'requester') => {
    const body = await request('tools/call', { name, arguments: args }, actor);
    expect(body.error).toBeUndefined();
    expect(body.result?.resultType).toBe('complete');
    return body.result as unknown as ManagementToolReply;
  };
  return { managementStore, cloudClientSecrets, authenticate, request, call };
}

async function rawPost(
  origin: string,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly chunks?: readonly Buffer[];
  },
): Promise<{
  readonly status: number;
  readonly headers: NodeJS.Dict<string | string[]>;
  body: string;
}> {
  const endpoint = new URL('/mcp', origin);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      endpoint,
      { method: 'POST', headers: options.headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.once('error', reject);
    for (const chunk of options.chunks ?? []) outgoing.write(chunk);
    outgoing.end();
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(close));
});

describe('Amazon Bedrock AgentCore Runtime contract', () => {
  it('serves health and all MCP tools while accepting the platform session header', async () => {
    const runtime = createAgentCoreRuntime({
      environment: {
        QLIK_AGENTCORE_LOCAL_DEV: 'true',
        QLIK_AGENTCORE_LOCAL_ACTOR: 'agentcore-test-actor',
        QLIK_HARNESS_TARGET_MODE: 'fixture',
      },
    });
    const origin = await listen(runtime);
    const ping = await fetch(`${origin}/ping`);
    expect(ping.status).toBe(200);
    await expect(ping.json()).resolves.toEqual({ status: 'Healthy' });

    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': 'agentcore-platform-session-123456789',
    };
    const initialize = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'agentcore-contract-test', version: '1.0.0' },
        },
      }),
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get('mcp-session-id')).toBeNull();
    await expect(rpcBody(initialize)).resolves.toMatchObject({
      result: { serverInfo: { name: 'qlik-ai-harness' } },
      id: 1,
    });

    const listed = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(listed.status).toBe(200);
    const body = (await rpcBody(listed)) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools).toHaveLength(16);
    expect(body.result.tools.map((tool) => tool.name)).toContain('qlik_apply_visualization');
  });

  it('keeps production calls authenticated and exposes no alternate MCP method', async () => {
    const runtime = createAgentCoreRuntime({
      environment: {
        PORT: '8000',
        QLIK_HARNESS_TARGET_MODE: 'fixture',
        QLIK_AGENTCORE_JWT_DISCOVERY_URL:
          'https://identity.example.com/.well-known/openid-configuration',
        QLIK_AGENTCORE_JWT_AUDIENCE: 'qlik-agentcore-test',
        QLIK_AGENTCORE_JWT_ALLOWED_CLIENT_IDS: 'approved-client',
        QLIK_AGENTCORE_JWT_REQUIRED_SCOPES: 'qlik.harness.invoke',
      },
      stateStores: inMemoryState(),
      managementStore: new MemoryManagementStore(),
      authenticate: async () => {
        throw new Error('invalid token');
      },
    });
    const origin = await listen(runtime);
    const unauthorized = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({ error: 'unauthorized' });
    expect((await fetch(`${origin}/mcp`)).status).toBe(405);
    expect((await fetch(`${origin}/invocations`)).status).toBe(404);
  });

  it('shares an authenticated-subject quota across stateless MCP requests', async () => {
    const runtime = createAgentCoreRuntime({
      environment: {
        QLIK_AGENTCORE_LOCAL_DEV: 'true',
        QLIK_AGENTCORE_LOCAL_ACTOR: 'quota-test-actor',
        QLIK_AGENTCORE_REQUESTS_PER_MINUTE: '1',
        QLIK_HARNESS_TARGET_MODE: 'fixture',
      },
    });
    const origin = await listen(runtime);
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const first = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'quota-test', version: '1.0.0' },
        },
      }),
    });
    expect(first.status).toBe(200);
    const limited = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    await expect(limited.json()).resolves.toMatchObject({ error: 'quota exceeded' });
  });

  it('rejects a declared oversize MCP body before buffering it', async () => {
    const runtime = createAgentCoreRuntime({
      environment: {
        QLIK_AGENTCORE_LOCAL_DEV: 'true',
        QLIK_HARNESS_TARGET_MODE: 'fixture',
      },
    });
    const origin = await listen(runtime);
    const response = await rawPost(origin, {
      headers: {
        'content-type': 'application/json',
        'content-length': String(AGENTCORE_MAX_MCP_BODY_BYTES + 1),
      },
    });
    expect(response.status).toBe(413);
    expect(response.headers.connection).toBe('close');
    expect(JSON.parse(response.body)).toMatchObject({ error: 'payload too large' });
  });

  it('bounds chunked MCP bodies when no Content-Length is declared', async () => {
    const runtime = createAgentCoreRuntime({
      environment: {
        QLIK_AGENTCORE_LOCAL_DEV: 'true',
        QLIK_HARNESS_TARGET_MODE: 'fixture',
      },
    });
    const origin = await listen(runtime);
    const response = await rawPost(origin, {
      headers: { 'content-type': 'application/json' },
      chunks: [
        Buffer.alloc(Math.floor(AGENTCORE_MAX_MCP_BODY_BYTES / 2), 0x20),
        Buffer.alloc(Math.floor(AGENTCORE_MAX_MCP_BODY_BYTES / 2), 0x20),
        Buffer.from('x'),
      ],
    });
    expect(response.status).toBe(413);
    expect(response.headers.connection).toBe('close');
    expect(JSON.parse(response.body)).toMatchObject({ error: 'payload too large' });
  });

  it('supports modern discovery and rejects contradictory routing headers', async () => {
    const origin = await listen(
      createAgentCoreRuntime({
        environment: {
          QLIK_AGENTCORE_LOCAL_DEV: 'true',
          QLIK_HARNESS_TARGET_MODE: 'fixture',
        },
      }),
    );
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'server/discover',
        'mcp-session-id': 'agentcore-generated-platform-session',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: { _meta: modernMeta },
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(rpcBody(response)).resolves.toMatchObject({
      result: {
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'qlik-ai-harness' } },
        resultType: 'complete',
      },
    });
    const mismatch = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: { _meta: modernMeta },
      }),
    });
    expect(mismatch.status).toBe(400);
    await expect(rpcBody(mismatch)).resolves.toHaveProperty('error');
  });

  it('retains created objects across modern requests while isolating authenticated actors', async () => {
    vi.stubEnv('QLIK_HARNESS_TARGET_MODE', 'unsupported-ambient-mode');
    vi.stubEnv('QLIK_HARNESS_CONNECTIONS_JSON', 'invalid-ambient-policy');
    const runtime = createAgentCoreRuntime({
      environment: {
        QLIK_HARNESS_TARGET_MODE: 'fixture',
        QLIK_HARNESS_MUTATION_ACTORS: 'requester',
        QLIK_HARNESS_REVIEWER_ACTORS: 'reviewer',
        QLIK_AGENTCORE_JWT_DISCOVERY_URL:
          'https://identity.example.com/.well-known/openid-configuration',
        QLIK_AGENTCORE_JWT_AUDIENCE: 'test',
        QLIK_AGENTCORE_JWT_ALLOWED_CLIENT_IDS: 'test-client',
        QLIK_AGENTCORE_JWT_REQUIRED_SCOPES: 'qlik.invoke',
      },
      stateStores: inMemoryState(),
      managementStore: new MemoryManagementStore(),
      authenticate: async (authorization) => ({
        subject: authorization?.slice(7) ?? 'unknown',
        clientId: 'test-client',
        scopes: ['qlik.invoke'],
      }),
    });
    const origin = await listen(runtime);
    let id = 0;
    const call = async (name: string, args: Record<string, unknown>, actor = 'requester') => {
      const response = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${actor}`,
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': name,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: modernMeta,
          },
        }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await rpcBody(response)) as {
        result: {
          resultType: string;
          isError?: boolean;
          structuredContent: Record<string, unknown>;
        };
      };
      expect(body.result.resultType).toBe('complete');
      return body.result;
    };
    const target = {
      connection: 'cloud-dev',
      appId: 'app-sales-cloud-dev',
      sheetId: 'sheet-sales-overview-cloud-dev',
    };
    const planned = await call('qlik_plan_visualization', {
      ...target,
      intent: {
        analysis: { dimensions: ['Region'], measures: ['Revenue'] },
        presentation: { preferredChartType: 'bar', title: 'Cross request persistence' },
      },
    });
    expect(planned.isError).toBeFalsy();
    const planHash = planned.structuredContent.planHash;
    const [preview, forbidden] = await Promise.all([
      call('qlik_preview_visualization', { planHash }),
      call('qlik_preview_visualization', { planHash }, 'different-actor'),
    ]);
    expect(preview.isError).toBeFalsy();
    expect(forbidden.isError).toBe(true);
    const approval = await call('qlik_request_visualization_approval', { planHash });
    expect(approval.isError).toBeFalsy();
    const decision = await call(
      'qlik_approve_visualization_request',
      {
        requestId: approval.structuredContent.requestId,
      },
      'reviewer',
    );
    expect(decision.isError).toBeFalsy();
    const applied = await call('qlik_apply_visualization', {
      planHash,
      approvalToken: decision.structuredContent.approvalToken,
      idempotencyKey: 'agentcore-cross-request',
    });
    expect(applied.isError).toBeFalsy();
    expect(applied.structuredContent.status).toBe('verified');
    const listed = await call('qlik_list_sheet_objects', target);
    expect(listed.isError).toBeFalsy();
    expect(listed.structuredContent.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectId: applied.structuredContent.objectId }),
      ]),
    );
  });

  it('blocks local DNS rebinding, foreign origins, and non-loopback development binds', async () => {
    expect(() =>
      createAgentCoreRuntime({
        environment: {
          QLIK_AGENTCORE_LOCAL_DEV: 'true',
          QLIK_AGENTCORE_LOCAL_HOST: '0.0.0.0',
        },
      }),
    ).toThrow('loopback');
    const origin = await listen(
      createAgentCoreRuntime({
        environment: {
          QLIK_AGENTCORE_LOCAL_DEV: 'true',
          QLIK_HARNESS_TARGET_MODE: 'fixture',
        },
      }),
    );
    const rebound = await rawPost(origin, {
      headers: { host: 'attacker.example' },
      chunks: [Buffer.from('{}')],
    });
    expect(rebound.status).toBe(403);
    const foreign = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(foreign.status).toBe(403);
  });

  it('does not expose management tools in Cloud mode when the management policy is absent', async () => {
    const fixture = await managementFixture(false);
    const listed = await fixture.request('tools/list', {});
    const names = (listed.result?.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).not.toContain('qlik_management_catalog');
    expect(names).not.toContain('qlik_upload_begin');
    const called = await fixture.request('tools/call', {
      name: 'qlik_management_read',
      arguments: {
        action: 'app.get',
        input: { connection: 'management-cloud', appId: 'app-1' },
      },
    });
    expect(called.error || called.result?.isError).toBeTruthy();
    expect(managementProvider.constructed).not.toHaveBeenCalled();
    expect(fixture.cloudClientSecrets).not.toHaveBeenCalled();
  });

  it('exposes staged upload schemas and bounded chunks without arbitrary provider bytes or actor overrides', async () => {
    const fixture = await managementFixture();
    const listed = await fixture.request('tools/list', {});
    const tools = listed.result?.tools as Array<{
      name: string;
      inputSchema: { properties: Record<string, unknown> };
    }>;
    expect(tools.map((tool) => tool.name)).toContain('qlik_management_plan');
    const chunk = tools.find((tool) => tool.name === 'qlik_upload_chunk');
    expect(chunk?.inputSchema.properties.contentBase64).toMatchObject({ maxLength: 262144 });
    expect(
      tools.find((tool) => tool.name === 'qlik_management_execute')?.inputSchema.properties,
    ).not.toHaveProperty('actor');
    const catalog = await fixture.call('qlik_management_catalog', {});
    expect(catalog.isError).toBeFalsy();
    const actions = catalog.structuredContent?.actions as Array<{
      action: string;
      inputSchema: { properties: Record<string, unknown> };
    }>;
    for (const action of ['datafile.upload', 'datafile.replace']) {
      const schema = actions.find((entry) => entry.action === action)!.inputSchema;
      expect(schema.properties).toHaveProperty('artifactId');
      expect(schema.properties).not.toHaveProperty('contentBase64');
      expect(schema.properties).not.toHaveProperty('tempContentFileId');
    }
    const rejected = await fixture.call('qlik_management_plan', {
      steps: [
        {
          action: 'datafile.upload',
          input: {
            connection: 'management-cloud',
            spaceId: 'management-space',
            name: 'data.csv',
            contentBase64: 'YQo=',
            contentSha256: 'a'.repeat(64),
          },
        },
      ],
    });
    expect(rejected.isError).toBe(true);
    expect(managementProvider.inspect).not.toHaveBeenCalled();
    expect(managementProvider.execute).not.toHaveBeenCalled();
    expect(fixture.cloudClientSecrets).not.toHaveBeenCalled();
  });

  it('uses authenticated subject and client for grants before contacting Qlik, ignoring caller identity claims', async () => {
    const fixture = await managementFixture();
    for (const [actor, connection] of [
      ['outsider', 'management-cloud'],
      ['requester-other-client', 'management-cloud'],
      ['requester', 'foreign-connection'],
    ]) {
      const denied = await fixture.call(
        'qlik_management_read',
        {
          action: 'app.get',
          input: { connection, appId: 'app-1' },
        },
        actor,
      );
      expect(denied.isError).toBe(true);
      expect(JSON.parse(denied.content![0]!.text)).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    const injected = await fixture.call(
      'qlik_management_read',
      {
        action: 'app.get',
        input: {
          connection: 'management-cloud',
          appId: 'app-1',
          actor: 'requester',
          hostClientId: 'test-client',
        },
      },
      'outsider',
    );
    expect(injected.isError).toBe(true);
    expect(managementProvider.inspect).not.toHaveBeenCalled();
    expect(managementProvider.execute).not.toHaveBeenCalled();
    const allowed = await fixture.call('qlik_management_read', {
      action: 'app.get',
      input: { connection: 'management-cloud', appId: 'app-1' },
    });
    expect(allowed.isError).toBeFalsy();
    expect(allowed.structuredContent).toMatchObject({
      appId: 'app-1',
      spaceId: 'management-space',
    });
    expect(managementProvider.execute).toHaveBeenCalledTimes(1);
    expect(fixture.authenticate).toHaveBeenCalledWith('Bearer requester', expect.any(Object));
    expect(fixture.cloudClientSecrets).not.toHaveBeenCalled();
  });

  it('retains upload chunks and plans across HTTP requests while binding state to authenticated owners', async () => {
    const fixture = await managementFixture();
    const bytes = Buffer.from(`ID,Amount\n${'1,10\n'.repeat(40_000)}`);
    const connection = 'management-cloud';
    const spaceId = 'management-space';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const begun = await fixture.call('qlik_upload_begin', {
      connection,
      spaceId,
      filename: 'fixture.csv',
      mimeType: 'text/csv',
      byteLength: bytes.length,
      sha256,
    });
    expect(begun.isError).toBeFalsy();
    const artifactId = String(begun.structuredContent?.artifactId);
    expect(await fixture.managementStore.get('requester', artifactId)).toMatchObject({
      owner: 'requester',
      kind: 'artifact',
      data: { status: 'uploading', chunkCount: 2 },
    });
    expect(await fixture.managementStore.get('other-actor', artifactId)).toBeUndefined();
    const chunkArgs = {
      connection,
      artifactId,
      index: 0,
      contentBase64: bytes.subarray(0, ARTIFACT_CHUNK_BYTES).toString('base64'),
    };
    expect((await fixture.call('qlik_upload_chunk', chunkArgs, 'other-actor')).isError).toBe(true);
    expect((await fixture.call('qlik_upload_chunk', chunkArgs)).structuredContent).toMatchObject({
      accepted: true,
      replayed: false,
    });
    expect((await fixture.call('qlik_upload_chunk', chunkArgs)).structuredContent).toMatchObject({
      accepted: true,
      replayed: true,
    });
    expect(
      (
        await fixture.call('qlik_upload_chunk', {
          connection,
          artifactId,
          index: 1,
          contentBase64: bytes.subarray(ARTIFACT_CHUNK_BYTES).toString('base64'),
        })
      ).isError,
    ).toBeFalsy();
    expect(
      (await fixture.call('qlik_upload_finish', { connection, artifactId })).structuredContent,
    ).toMatchObject({ status: 'sealed', sha256, byteLength: bytes.length });
    expect(
      (
        await fixture.call(
          'qlik_artifact_chunk',
          { connection, artifactId, index: 0 },
          'other-actor',
        )
      ).isError,
    ).toBe(true);
    const downloaded = await fixture.call('qlik_artifact_chunk', {
      connection,
      artifactId,
      index: 0,
    });
    expect(downloaded.structuredContent?.contentBase64).toBe(chunkArgs.contentBase64);

    const steps = [{ action: 'datafile.upload', input: { connection, spaceId, artifactId } }];
    const planned = await fixture.call('qlik_management_plan', { steps });
    expect(planned.isError).toBeFalsy();
    const planId = String(planned.structuredContent?.planId);
    expect(await fixture.managementStore.get('requester', planId)).toMatchObject({
      owner: 'requester',
      data: { clientId: 'test-client' },
    });
    for (const actor of ['other-actor', 'requester-other-client']) {
      expect((await fixture.call('qlik_management_status', { planId }, actor)).isError).toBe(true);
      expect(
        (await fixture.call('qlik_management_execute', { planId, steps }, actor)).isError,
      ).toBe(true);
    }
    expect(managementProvider.execute).not.toHaveBeenCalled();
    expect((await fixture.call('qlik_management_status', { planId })).isError).toBeFalsy();
    expect(
      (await fixture.call('qlik_management_execute', { planId, steps })).structuredContent,
    ).toMatchObject({ status: 'completed' });
    expect(
      (await fixture.call('qlik_management_execute', { planId, steps })).structuredContent,
    ).toMatchObject({ status: 'completed' });
    expect(managementProvider.execute).toHaveBeenCalledTimes(1);
    expect(managementProvider.execute).toHaveBeenCalledWith(
      'datafile.upload',
      expect.objectContaining({ contentSha256: sha256, name: 'fixture.csv' }),
    );
    expect(fixture.cloudClientSecrets).not.toHaveBeenCalled();
  });

  it('fails closed without durable state and for the unsupported Windows deployment lane', () => {
    expect(() =>
      createAgentCoreRuntime({
        environment: { PORT: '8000', QLIK_HARNESS_TARGET_MODE: 'fixture' },
      }),
    ).toThrow('QLIK_AGENTCORE_STATE_TABLE');
    expect(() =>
      createAgentCoreRuntime({
        environment: { PORT: '8000', QLIK_HARNESS_TARGET_MODE: 'windows' },
        stateStores: inMemoryState(),
      }),
    ).toThrow('currently supports fixture and Qlik Cloud');
  });

  it('fails production startup when JWT client or scope constraints are absent', () => {
    const baseline = {
      PORT: '8000',
      QLIK_HARNESS_TARGET_MODE: 'fixture',
      QLIK_AGENTCORE_JWT_DISCOVERY_URL:
        'https://identity.example.com/.well-known/openid-configuration',
      QLIK_AGENTCORE_JWT_AUDIENCE: 'qlik-agentcore-test',
      QLIK_AGENTCORE_JWT_ALLOWED_CLIENT_IDS: 'approved-client',
      QLIK_AGENTCORE_JWT_REQUIRED_SCOPES: 'qlik.harness.invoke',
    } as const;
    expect(() =>
      createAgentCoreRuntime({
        environment: { ...baseline, QLIK_AGENTCORE_JWT_ALLOWED_CLIENT_IDS: ' , ' },
        stateStores: inMemoryState(),
      }),
    ).toThrow('QLIK_AGENTCORE_JWT_ALLOWED_CLIENT_IDS');
    expect(() =>
      createAgentCoreRuntime({
        environment: { ...baseline, QLIK_AGENTCORE_JWT_REQUIRED_SCOPES: '' },
        stateStores: inMemoryState(),
      }),
    ).toThrow('QLIK_AGENTCORE_JWT_REQUIRED_SCOPES');
    expect(() =>
      createAgentCoreRuntime({
        environment: {
          ...baseline,
          QLIK_AGENTCORE_JWT_REQUIRED_SCOPES: 'qlik.harness.invoke,qlik.harness.admin',
        },
        stateStores: inMemoryState(),
      }),
    ).toThrow('must contain exactly one value');
    expect(() =>
      createAgentCoreRuntime({
        environment: { ...baseline, QLIK_AGENTCORE_REQUESTS_PER_MINUTE: '0' },
        stateStores: inMemoryState(),
      }),
    ).toThrow('QLIK_AGENTCORE_REQUESTS_PER_MINUTE');
  });
});
