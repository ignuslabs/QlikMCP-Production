import { readFileSync } from 'node:fs';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { FixtureRepository } from '../../../src/adapters/fixture/fixtureRepository.js';
import { chartIntentSchema } from '../../../src/compiler/chartIntentSchema.js';
import { compileChartIntent } from '../../../src/compiler/compiler.js';
import type { OperationRecord } from '../../../src/domain/types.js';
import { DynamoApprovalStore } from '../../../src/agentcore/state/dynamoApprovalStore.js';
import { DynamoIdempotencyStore } from '../../../src/agentcore/state/dynamoIdempotencyStore.js';
import { DynamoOperationStore } from '../../../src/agentcore/state/dynamoOperationStore.js';
import { DynamoPlanStore } from '../../../src/agentcore/state/dynamoPlanStore.js';

type Command = GetCommand | PutCommand | QueryCommand | TransactWriteCommand | UpdateCommand;

function documentClient(handler: (command: Command) => Promise<unknown>): DynamoDBDocumentClient {
  return { send: vi.fn(handler) } as unknown as DynamoDBDocumentClient;
}

describe('DynamoDB AgentCore governance stores', () => {
  it('round-trips a fully validated plan with an integrity hash and TTL', async () => {
    let item: Record<string, unknown> | undefined;
    const items = new Map<string, Record<string, unknown>>();
    const client = documentClient(async (command) => {
      if (command instanceof PutCommand) {
        item = command.input.Item;
        items.set(`${String(item?.pk)}|${String(item?.sk)}`, item!);
        return {};
      }
      if (command instanceof GetCommand) {
        return {
          Item: items.get(`${String(command.input.Key?.pk)}|${String(command.input.Key?.sk)}`),
        };
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    });
    const catalog = new FixtureRepository().getCatalog(
      'cloud-dev',
      'app-sales-cloud-dev',
      'default',
    );
    const plan = compileChartIntent({
      catalog,
      target: {
        connection: 'cloud-dev',
        appId: 'app-sales-cloud-dev',
        sheetId: 'sheet-sales-overview-cloud-dev',
      },
      platform: 'cloud',
      intent: chartIntentSchema.parse({
        analysis: { dimensions: ['Region'], measures: ['Revenue'] },
        presentation: { preferredChartType: 'bar', title: 'AgentCore plan' },
      }),
    });
    const stored = {
      ownerActor: 'agentcore-plan-owner',
      plan,
      operationId: 'operation-agentcore-plan',
      correlationId: 'correlation-agentcore-plan',
      presentationTarget: null,
    } as const;
    const store = new DynamoPlanStore({ tableName: 'state-table', client });
    await store.save(stored);
    expect(item).toMatchObject({
      pk: expect.stringMatching(/^PLAN#sha256:[0-9a-f]{64}$/u),
      sk: 'STATE',
      kind: 'plan',
      integrityHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      expiresAtEpoch: Math.floor(Date.parse(plan.expiresAt) / 1000) + 30 * 86_400,
      payload: { ownerActor: stored.ownerActor },
    });
    expect(String(item?.pk)).not.toContain(stored.ownerActor);
    expect((item?.payload as { plan: { expiresAt: string } }).plan.expiresAt).toBe(plan.expiresAt);
    expect(
      () => new DynamoPlanStore({ tableName: 'state-table', client, retentionDays: 1 }),
    ).toThrow('30 through 3650');
    const firstPartitionKey = item?.pk;
    const otherOwnerStored = {
      ...stored,
      ownerActor: 'other-agentcore-plan-owner',
      operationId: 'operation-agentcore-plan-other',
      correlationId: 'correlation-agentcore-plan-other',
    };
    await store.save(otherOwnerStored);
    expect(item?.pk).not.toBe(firstPartitionKey);
    await expect(store.get(stored.ownerActor, plan.planHash)).resolves.toEqual(stored);
    await expect(store.get(otherOwnerStored.ownerActor, plan.planHash)).resolves.toEqual(
      otherOwnerStored,
    );
    await expect(store.get('different-agentcore-owner', plan.planHash)).resolves.toBeUndefined();
  });

  it('persists only approval-token and idempotency-key digests', async () => {
    let requestItem: Record<string, unknown> | undefined;
    let approvalItem: Record<string, unknown> | undefined;
    let approvalUpdate: Record<string, unknown> | undefined;
    let transactionJson = '';
    const client = documentClient(async (command) => {
      if (command instanceof PutCommand) {
        requestItem = command.input.Item;
        return {};
      }
      if (command instanceof GetCommand) {
        const key = command.input.Key as { pk?: string };
        return { Item: key.pk?.startsWith('APPROVAL_REQUEST#') ? requestItem : approvalItem };
      }
      if (command instanceof TransactWriteCommand) {
        transactionJson = JSON.stringify(command.input);
        approvalItem = command.input.TransactItems?.[0]?.Put?.Item;
        requestItem = command.input.TransactItems?.[1]?.Put?.Item;
        return {};
      }
      if (command instanceof UpdateCommand) {
        approvalUpdate = command.input.ExpressionAttributeValues?.[':payload'] as Record<
          string,
          unknown
        >;
        approvalItem = { ...approvalItem, payload: approvalUpdate };
        return {};
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    });
    const store = new DynamoApprovalStore({ tableName: 'state-table', client });
    const request = await store.request({
      planHash: `sha256:${'a'.repeat(64)}`,
      requestingActor: 'requester-subject',
      connectionAlias: 'cloud-dev',
      appId: 'app-sales-cloud-dev',
      sheetId: 'sheet-sales-overview-cloud-dev',
      riskClass: 'standard',
      ttlMs: 60_000,
    });
    const approval = await store.approve(request.requestId, 'reviewer-subject', 60_000);
    expect(approval.approvalToken).not.toMatch(/^sha256:/u);
    expect(transactionJson).not.toContain(approval.approvalToken);
    expect(approvalItem).toMatchObject({
      pk: expect.stringMatching(/^APPROVAL#sha256:[0-9a-f]{64}$/u),
      payload: { approvalToken: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) },
    });
    await expect(store.get(approval.approvalToken)).resolves.toMatchObject({
      approvalToken: approval.approvalToken,
      actor: 'requester-subject',
      reviewedBy: 'reviewer-subject',
    });
    await store.consume(approval.approvalToken, 'caller-idempotency-key');
    expect(JSON.stringify(approvalUpdate)).not.toContain('caller-idempotency-key');
    expect(approvalUpdate).toMatchObject({
      state: 'consumed',
      consumed: true,
      consumedByIdempotencyKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  it('uses conditional writes for cross-replica idempotent replay', async () => {
    let item: Record<string, unknown> | undefined;
    const client = documentClient(async (command) => {
      if (command instanceof PutCommand) {
        item = command.input.Item;
        return {};
      }
      if (command instanceof GetCommand) return { Item: item };
      if (command instanceof UpdateCommand) {
        item = {
          ...item,
          payload: command.input.ExpressionAttributeValues?.[':payload'],
        };
        return {};
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    });
    const store = new DynamoIdempotencyStore({ tableName: 'state-table', client });
    const binding = {
      actor: 'requester-subject',
      connectionAlias: 'cloud-dev',
      appId: 'app-sales-cloud-dev',
      sheetId: 'sheet-sales-overview-cloud-dev',
      planHash: `sha256:${'b'.repeat(64)}`,
    } as const;
    await store.beginInProgress('raw-idempotency-key', binding, 'operation-1');
    expect(JSON.stringify(item)).not.toContain('raw-idempotency-key');
    expect(item).toMatchObject({
      pk: expect.stringMatching(/^IDEMPOTENCY#sha256:[0-9a-f]{64}$/u),
      payload: { status: 'in-progress' },
    });
    await store.complete('raw-idempotency-key', { status: 'verified' });
    await expect(store.lookup('raw-idempotency-key', binding)).resolves.toMatchObject({
      kind: 'replay',
      record: { status: 'completed', operationId: 'operation-1' },
    });
  });

  it('atomically saves latest and append-only sanitized operation records', async () => {
    const record = JSON.parse(
      readFileSync('test/fixtures/audit/success.json', 'utf8'),
    ) as OperationRecord;
    let latest: Record<string, unknown> | undefined;
    const history: Record<string, unknown>[] = [];
    const client = documentClient(async (command) => {
      if (command instanceof TransactWriteCommand) {
        latest = command.input.TransactItems?.[0]?.Put?.Item;
        const event = command.input.TransactItems?.[1]?.Put?.Item;
        if (event) history.push(event);
        return {};
      }
      if (command instanceof GetCommand) return { Item: latest };
      if (command instanceof QueryCommand) return { Items: history };
      throw new Error(`Unexpected command ${command.constructor.name}`);
    });
    const store = new DynamoOperationStore({ tableName: 'state-table', client });
    await store.save(record);
    expect(latest).toMatchObject({
      pk: `OPERATION#${record.operationId}`,
      sk: 'LATEST',
      kind: 'operation',
    });
    await expect(
      store.getForActor(record.operationId, record.requestingPrincipal),
    ).resolves.toEqual(record);
    await expect(store.getForActor(record.operationId, 'other-actor')).resolves.toBeUndefined();
    await expect(store.history(record.operationId)).resolves.toEqual([record]);
    await expect(store.history()).rejects.toThrow('requires an exact operation ID');
    const newer = {
      ...record,
      timestamp: new Date(Date.parse(record.timestamp) + 1_000).toISOString(),
    };
    await store.save(newer);
    await expect(
      store.getForActor(record.operationId, record.requestingPrincipal),
    ).resolves.toEqual(newer);
    await store.save({
      ...record,
      requestingPrincipal: 'other-actor',
      timestamp: new Date(Date.parse(record.timestamp) + 2_000).toISOString(),
    });
    await expect(
      store.getForActor(record.operationId, record.requestingPrincipal),
    ).resolves.toEqual(newer);
  });
});
