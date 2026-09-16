import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  DynamoManagementStore,
  MemoryManagementStore,
  type ManagementRecord,
  type ManagementWrite,
} from '../../../src/management/state.js';

const record: ManagementRecord = {
  id: 'plan',
  owner: 'owner',
  kind: 'plan',
  version: 1,
  expiresAt: '2026-10-01T00:00:00Z',
  data: { status: 'planned' },
};
describe('management compare-and-swap persistence', () => {
  it('requires monotonic versions and prevents create or update overwrite', async () => {
    const store = new MemoryManagementStore();
    await store.put(record, null);
    await expect(store.put(record, null)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(store.put({ ...record, version: 3 }, 1)).rejects.toThrow('exactly once');
    await store.put({ ...record, version: 2 }, 1);
    await expect(store.put({ ...record, version: 2 }, 1)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await store.get('other', 'plan')).toBeUndefined();
  });
  it('atomically records audit events and conditional mutation claims', async () => {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
    const mocked = mockClient(client);
    mocked.on(TransactWriteCommand).resolves({});
    const store = new DynamoManagementStore({ client, tableName: 'state' });
    await store.put(record, null);
    const transaction = mocked.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(transaction.TransactItems).toHaveLength(2);
    expect(transaction.TransactItems![0]!.Put!.ConditionExpression).toBe(
      'attribute_not_exists(pk)',
    );
    expect(transaction.TransactItems![1]!.Put!.Item!.sk).toBe('EVENT#00000001');
    mocked.on(TransactWriteCommand).rejects(
      Object.assign(new Error('Conditional conflict'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    await expect(store.put({ ...record, version: 2 }, 1)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    mocked.restore();
  });
  it('excludes artifact content from audit events and reads state consistently', async () => {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
    const mocked = mockClient(client);
    mocked.on(PutCommand).resolves({});
    mocked.on(GetCommand).resolves({ Item: { payload: record } });
    const store = new DynamoManagementStore({ client, tableName: 'state' });
    await store.put({ ...record, kind: 'chunk', data: { contentBase64: 'cHJpdmF0ZQ==' } }, null);
    expect(mocked.commandCalls(TransactWriteCommand)).toHaveLength(0);
    await store.get('owner', 'plan');
    expect(mocked.commandCalls(GetCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
    mocked.restore();
  });

  it('leaves every record unchanged when any transaction condition conflicts', async () => {
    const store = new MemoryManagementStore();
    await store.put(record, null);
    const lock: ManagementRecord = {
      ...record,
      id: 'app-lock',
      owner: '__management_locks__',
      kind: 'lock',
      data: { status: 'held' },
    };
    await expect(
      store.transact([
        { record: lock, expectedVersion: null },
        { record, expectedVersion: null },
      ]),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await store.get(lock.owner, lock.id)).toBeUndefined();
    expect(await store.get(record.owner, record.id)).toEqual(record);
    await store.put(lock, null);
    await expect(
      store.transact([
        { record: { ...lock, version: 2, data: { status: 'released' } }, expectedVersion: 1 },
        { record: { ...record, version: 3 }, expectedVersion: 2 },
      ]),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await store.get(lock.owner, lock.id)).toEqual(lock);
  });

  it('commits paired lock and execution claims together and isolates stored data', async () => {
    const store = new MemoryManagementStore();
    const lock: ManagementRecord = {
      ...record,
      id: 'lock',
      owner: '__management_locks__',
      kind: 'lock',
    };
    const execution: ManagementRecord = {
      ...record,
      id: 'execution',
      kind: 'execution',
      data: { status: 'in-progress', lockId: 'lock' },
    };
    await store.transact([
      { record: lock, expectedVersion: null },
      { record: execution, expectedVersion: null },
    ]);
    expect(await store.get(lock.owner, lock.id)).toEqual(lock);
    const found = await store.get(execution.owner, execution.id);
    expect(found).toEqual(execution);
    (found!.data as Record<string, unknown>).status = 'changed outside';
    expect((await store.get(execution.owner, execution.id))!.data.status).toBe('in-progress');
  });

  it('allows only one concurrent transaction to acquire the same lock', async () => {
    const store = new MemoryManagementStore();
    const lock: ManagementRecord = {
      ...record,
      id: 'lock',
      owner: '__management_locks__',
      kind: 'lock',
    };
    const a: ManagementRecord = { ...record, id: 'first-execution', kind: 'execution' };
    const b: ManagementRecord = { ...record, id: 'second-execution', kind: 'execution' };
    const results = await Promise.allSettled([
      store.transact([
        { record: lock, expectedVersion: null },
        { record: a, expectedVersion: null },
      ]),
      store.transact([
        { record: lock, expectedVersion: null },
        { record: b, expectedVersion: null },
      ]),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await store.get(a.owner, a.id)).toEqual(a);
    expect(await store.get(b.owner, b.id)).toBeUndefined();
  });

  it('rejects duplicate keys, empty transactions and more than 20 writes before committing', async () => {
    const store = new MemoryManagementStore();
    await expect(store.transact([])).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    await expect(
      store.transact([
        { record, expectedVersion: null },
        { record, expectedVersion: null },
      ]),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    await expect(
      store.transact(
        Array.from({ length: 21 }, (_, index) => ({
          record: { ...record, id: String(index) },
          expectedVersion: null,
        })),
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(await store.get(record.owner, record.id)).toBeUndefined();
    const writes: ManagementWrite[] = Array.from({ length: 20 }, (_, index) => ({
      record: { ...record, id: String(index) },
      expectedVersion: null,
    }));
    await store.transact(writes);
    expect(await store.get(record.owner, '19')).toBeDefined();
  });

  it('bounds transaction aggregate size including durable audit copies', async () => {
    const store = new MemoryManagementStore();
    const writes = Array.from({ length: 10 }, (_, index) => ({
      record: { ...record, id: String(index), data: { bounded: 'x'.repeat(200_000) } },
      expectedVersion: null,
    }));
    await expect(store.transact(writes)).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
    expect(await store.get(record.owner, '0')).toBeUndefined();
  });

  it('sends both state claims and both immutable audit events in one DynamoDB transaction', async () => {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
    const mocked = mockClient(client);
    mocked.on(TransactWriteCommand).resolves({});
    try {
      const store = new DynamoManagementStore({ client, tableName: 'state' });
      const lock: ManagementRecord = {
        ...record,
        id: 'lock',
        owner: '__management_locks__',
        kind: 'lock',
        version: 4,
      };
      const execution: ManagementRecord = { ...record, id: 'execution', kind: 'execution' };
      await store.transact([
        { record: lock, expectedVersion: 3 },
        { record: execution, expectedVersion: null },
      ]);
      expect(mocked.commandCalls(TransactWriteCommand)).toHaveLength(1);
      expect(mocked.commandCalls(PutCommand)).toHaveLength(0);
      const items = mocked.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items).toHaveLength(4);
      const states = items.filter((item) => item.Put?.Item?.sk === 'STATE');
      const events = items.filter((item) => String(item.Put?.Item?.sk).startsWith('EVENT#'));
      expect(states.map((item) => item.Put!.Item!.payload)).toEqual([lock, execution]);
      expect(states[0]!.Put).toMatchObject({
        ConditionExpression: '#payload.#version = :version',
        ExpressionAttributeValues: { ':version': 3 },
      });
      expect(states[1]!.Put!.ConditionExpression).toBe('attribute_not_exists(pk)');
      expect(events.map((item) => item.Put!.Item!.sk)).toEqual([
        'EVENT#00000004',
        'EVENT#00000001',
      ]);
      expect(
        events.every((item) => item.Put!.ConditionExpression === 'attribute_not_exists(pk)'),
      ).toBe(true);
    } finally {
      mocked.restore();
    }
  });

  it('omits content audit events from mixed transactions and rejects conflicts without fallback writes', async () => {
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
    const mocked = mockClient(client);
    mocked.on(TransactWriteCommand).resolves({});
    try {
      const store = new DynamoManagementStore({ client, tableName: 'state' });
      const content: ManagementRecord = {
        ...record,
        id: 'chunk',
        kind: 'chunk',
        data: { contentBase64: 'cHJpdmF0ZQ==' },
      };
      const writes = [
        { record, expectedVersion: null },
        { record: content, expectedVersion: null },
      ];
      await store.transact(writes);
      const items = mocked.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
      expect(items).toHaveLength(3);
      expect(
        items
          .filter((item) => item.Put?.Item?.kind === 'management-event')
          .map((item) => item.Put!.Item!.payload),
      ).toEqual([record]);
      mocked.on(TransactWriteCommand).rejects(
        Object.assign(new Error('Conflict'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      );
      await expect(store.transact(writes)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(mocked.commandCalls(PutCommand)).toHaveLength(0);
    } finally {
      mocked.restore();
    }
  });
});
