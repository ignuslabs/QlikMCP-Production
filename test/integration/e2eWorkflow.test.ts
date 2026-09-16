import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { buildMcpServer } from '../../src/mcp/server.js';
import { buildReviewerService, buildTestService, CLOUD_DEV } from '../helpers/testContext.js';
const EXPECTED_TOOL_NAMES = [
  'qlik_list_apps',
  'qlik_get_app_catalog',
  'qlik_list_sheet_objects',
  'qlik_plan_visualization',
  'qlik_preview_visualization',
  'qlik_request_visualization_approval',
  'qlik_approve_visualization_request',
  'qlik_reject_visualization_request',
  'qlik_get_visualization_approval',
  'qlik_apply_visualization',
  'qlik_plan_sheet',
  'qlik_preview_sheet',
  'qlik_apply_sheet',
  'qlik_verify_sheet',
  'qlik_get_operation',
  'qlik_get_readiness',
].sort();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

let server: McpServer;
let client: Client;
let reviewerServer: McpServer;
let reviewerClient: Client;

beforeEach(async () => {
  const requester = buildTestService();
  server = buildMcpServer(requester.service);
  reviewerServer = buildMcpServer(buildReviewerService(requester).service);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const [reviewerServerTransport, reviewerClientTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.1' });
  reviewerClient = new Client({ name: 'reviewer-client', version: '0.0.1' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
    reviewerServer.connect(reviewerServerTransport),
    reviewerClient.connect(reviewerClientTransport),
  ]);
});

afterEach(async () => {
  await Promise.all([
    client.close(),
    server.close(),
    reviewerClient.close(),
    reviewerServer.close(),
  ]);
});

describe('MCP tool discovery', () => {
  it('exposes all required tools including approval lifecycle and readiness', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('every tool declares a strict (additionalProperties: false) input schema', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const schema = tool.inputSchema as JsonRecord;
      expect(schema.type, tool.name).toBe('object');
      expect(schema.additionalProperties, tool.name).toBe(false);
    }
  });

  it('every tool declares a strict output schema', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      const schema = tool.outputSchema as JsonRecord;
      expect(schema.additionalProperties, tool.name).toBe(false);
    }
  });

  it('qlik_plan_visualization and qlik_apply_visualization match the documented exact schemas', async () => {
    const { tools } = await client.listTools();
    const plan = tools.find((tool) => tool.name === 'qlik_plan_visualization')!;
    expect((plan.inputSchema as JsonRecord).required.sort()).toEqual([
      'appId',
      'connection',
      'intent',
    ]);

    const apply = tools.find((tool) => tool.name === 'qlik_apply_visualization')!;
    expect((apply.inputSchema as JsonRecord).required.sort()).toEqual([
      'approvalToken',
      'idempotencyKey',
      'planHash',
    ]);
    expect(Object.keys((apply.inputSchema as JsonRecord).properties).sort()).toEqual(
      ['approvalToken', 'idempotencyKey', 'planHash'].sort(),
    );
  });

  it('publishes complete approval summaries and continuation tokens in strict output schemas', async () => {
    const { tools } = await client.listTools();
    const approval = tools.find((tool) => tool.name === 'qlik_request_visualization_approval')!;
    expect(Object.keys((approval.outputSchema as JsonRecord).properties)).toEqual(
      expect.arrayContaining(['chartType', 'title', 'resolvedSummary', 'warnings', 'diff', 'note']),
    );

    for (const toolName of ['qlik_list_apps', 'qlik_get_app_catalog', 'qlik_list_sheet_objects']) {
      const tool = tools.find((entry) => entry.name === toolName)!;
      expect((tool.outputSchema as JsonRecord).properties).toHaveProperty('nextPageToken');
    }
  });

  it('exposes the suggested bounded resources and approved-workflow prompts', async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const { resources } = await client.listResources();
    const allUris = [
      ...resources.map((r) => r.uri),
      ...resourceTemplates.map((r) => r.uriTemplate),
    ];
    expect(allUris.some((uri) => uri.includes('qlik://connections'))).toBe(true);
    expect(allUris.some((uri) => uri.includes('qlik://operations'))).toBe(true);

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      'create_verified_sheet',
      'design_native_chart',
      'explain_chart_result',
      'review_chart_plan',
    ]);
  });
});

describe('MCP schema strictness', () => {
  it('rejects a tool call with an unknown extra property', async () => {
    const result = await client.callTool({
      name: 'qlik_list_apps',
      arguments: { connection: CLOUD_DEV.connection, unexpectedProperty: 'fixture-value' },
    });
    expect(result.isError).toBe(true);
  });

  it('rejects a tool call missing a required property', async () => {
    const result = await client.callTool({
      name: 'qlik_apply_visualization',
      arguments: { planHash: 'sha256:x' },
    });
    expect(result.isError).toBe(true);
  });

  it('rejects an unsupported chart-type-shaped intent value gracefully at the planning layer, not the schema layer', async () => {
    const result = await client.callTool({
      name: 'qlik_plan_visualization',
      arguments: {
        connection: CLOUD_DEV.connection,
        appId: CLOUD_DEV.appId,
        sheetId: CLOUD_DEV.writableSheetId,
        intent: {
          analysis: { dimensions: ['Region'], measures: ['Revenue'] },
          presentation: { preferredChartType: 'radar', title: 'x' },
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/UNSUPPORTED_CHART/);
  });
});

describe('MCP end-to-end workflow', () => {
  it('runs discover -> catalog -> plan -> preview -> approve -> apply -> get_operation through real MCP tool calls', async () => {
    const apps = await client.callTool({
      name: 'qlik_list_apps',
      arguments: { connection: CLOUD_DEV.connection },
    });
    expect(apps.isError).toBeFalsy();
    expect((apps.structuredContent as JsonRecord).apps[0].appId).toBe(CLOUD_DEV.appId);

    const catalog = await client.callTool({
      name: 'qlik_get_app_catalog',
      arguments: { connection: CLOUD_DEV.connection, appId: CLOUD_DEV.appId },
    });
    expect(catalog.isError).toBeFalsy();

    const plan = await client.callTool({
      name: 'qlik_plan_visualization',
      arguments: {
        connection: CLOUD_DEV.connection,
        appId: CLOUD_DEV.appId,
        sheetId: CLOUD_DEV.writableSheetId,
        intent: {
          analysis: { dimensions: ['Region'], measures: ['Revenue'] },
          presentation: { preferredChartType: 'bar', title: 'Sales by region' },
        },
      },
    });
    expect(plan.isError).toBeFalsy();
    const planHash = (plan.structuredContent as JsonRecord).planHash as string;
    expect(planHash).toMatch(/^sha256:/);

    const preview = await client.callTool({
      name: 'qlik_preview_visualization',
      arguments: { planHash },
    });
    expect(preview.isError).toBeFalsy();
    expect((preview.structuredContent as JsonRecord).status).toBe('previewed');

    const approval = await client.callTool({
      name: 'qlik_request_visualization_approval',
      arguments: { planHash, note: 'review this bounded chart' },
    });
    expect(approval.isError).toBeFalsy();
    expect(approval.structuredContent).toMatchObject({
      chartType: 'bar',
      title: 'Sales by region',
      resolvedSummary: { dimensions: ['Region'], measures: ['Revenue'], filters: [] },
      warnings: [],
      diff: { summary: expect.any(String) },
      note: 'review this bounded chart',
    });
    const requestId = (approval.structuredContent as JsonRecord).requestId as string;
    expect((approval.structuredContent as JsonRecord).status).toBe('pending');
    const decision = await reviewerClient.callTool({
      name: 'qlik_approve_visualization_request',
      arguments: { requestId },
    });
    expect(decision.isError).toBeFalsy();
    const approvalToken = (decision.structuredContent as JsonRecord).approvalToken as string;
    expect(approvalToken).toBeTruthy();

    const apply = await client.callTool({
      name: 'qlik_apply_visualization',
      arguments: { planHash, approvalToken, idempotencyKey: 'mcp-e2e-key' },
    });
    expect(apply.isError).toBeFalsy();
    const applyResult = apply.structuredContent as JsonRecord;
    expect(applyResult.status).toBe('verified');

    const operation = await client.callTool({
      name: 'qlik_get_operation',
      arguments: { operationId: applyResult.operationId },
    });
    expect(operation.isError).toBeFalsy();
    expect((operation.structuredContent as JsonRecord).typedOutcome.status).toBe('verified');

    // A replayed apply with the same idempotency key returns the same result, no error.
    const replay = await client.callTool({
      name: 'qlik_apply_visualization',
      arguments: { planHash, approvalToken, idempotencyKey: 'mcp-e2e-key' },
    });
    expect(replay.isError).toBeFalsy();
    expect((replay.structuredContent as JsonRecord).objectId).toBe(applyResult.objectId);
  });
});
