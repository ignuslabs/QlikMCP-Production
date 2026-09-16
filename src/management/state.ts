import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  createDynamoDocumentClient,
  isConditionalConflict,
  type DynamoStateOptions,
} from '../agentcore/state/dynamoClient.js';
import { computePlanHash } from '../domain/ids.js';
import { createError } from '../domain/errors.js';

export interface ManagementRecord {
  readonly id: string;
  readonly owner: string;
  readonly version: number;
  readonly kind: 'plan' | 'execution' | 'artifact' | 'chunk' | 'lock';
  readonly expiresAt: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ManagementWrite {
  readonly record: ManagementRecord;
  readonly expectedVersion: number | null;
}

/** CAS is mandatory: a read followed by an unconditional write cannot claim a provider mutation. */
export interface ManagementStore {
  get(owner: string, id: string): Promise<ManagementRecord | undefined>;
  put(record: ManagementRecord, expectedVersion: number | null): Promise<void>;
  transact(writes: readonly ManagementWrite[]): Promise<void>;
}

function key(owner: string, id: string) {
  return { pk: `MANAGEMENT#${computePlanHash({ owner, id })}`, sk: 'STATE' };
}

function validate(record: ManagementRecord, expectedVersion?: number | null): void {
  if (
    !record.id ||
    !record.owner ||
    !Number.isSafeInteger(record.version) ||
    record.version < 1 ||
    !Number.isFinite(Date.parse(record.expiresAt))
  ) {
    throw new Error('Invalid management state record.');
  }
  if (expectedVersion !== undefined && record.version !== (expectedVersion ?? 0) + 1) {
    throw new Error('Management state version must advance exactly once.');
  }
  if (Buffer.byteLength(JSON.stringify(record)) > 350_000) {
    throw createError('MALFORMED_REQUEST', { message: 'Management state exceeds its size bound.' });
  }
}

function transactionWrites(writes: readonly ManagementWrite[]): ManagementWrite[] {
  if (!Array.isArray(writes) || writes.length < 1 || writes.length > 20) {
    throw createError('MALFORMED_REQUEST', {
      message: 'A management transaction requires between 1 and 20 writes.',
    });
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const { record, expectedVersion } of writes) {
    if (
      expectedVersion !== null &&
      (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    ) {
      throw createError('MALFORMED_REQUEST', {
        message: 'A management write requires null or a positive expected version.',
      });
    }
    validate(record, expectedVersion);
    const recordKey = key(record.owner, record.id).pk;
    if (seen.has(recordKey))
      throw createError('MALFORMED_REQUEST', {
        message: 'A management transaction cannot write the same record twice.',
      });
    seen.add(recordKey);
    totalBytes +=
      Buffer.byteLength(JSON.stringify(record)) *
      (record.kind === 'artifact' || record.kind === 'chunk' ? 1 : 2);
  }
  // DynamoDB's transaction size includes audit copies. Leave space for keys and marshalling.
  if (totalBytes > 3_500_000)
    throw createError('CAPACITY_EXHAUSTED', {
      message: 'The management transaction exceeds its aggregate size limit.',
    });
  return structuredClone(writes) as ManagementWrite[];
}

function statePut(tableName: string, write: ManagementWrite) {
  const { record, expectedVersion } = write;
  return {
    TableName: tableName,
    Item: {
      ...key(record.owner, record.id),
      kind: 'management',
      payload: record,
      expiresAtEpoch: Math.floor(Date.parse(record.expiresAt) / 1000),
    },
    ConditionExpression:
      expectedVersion === null ? 'attribute_not_exists(pk)' : '#payload.#version = :version',
    ...(expectedVersion === null
      ? {}
      : {
          ExpressionAttributeNames: { '#payload': 'payload', '#version': 'version' },
          ExpressionAttributeValues: { ':version': expectedVersion },
        }),
  };
}

function auditPut(tableName: string, record: ManagementRecord) {
  return {
    TableName: tableName,
    Item: {
      ...key(record.owner, record.id),
      sk: `EVENT#${String(record.version).padStart(8, '0')}`,
      kind: 'management-event',
      payload: record,
      expiresAtEpoch: Math.floor(Date.parse(record.expiresAt) / 1000),
    },
    ConditionExpression: 'attribute_not_exists(pk)',
  };
}

export class MemoryManagementStore implements ManagementStore {
  private readonly records = new Map<string, ManagementRecord>();
  async get(owner: string, id: string): Promise<ManagementRecord | undefined> {
    const record = this.records.get(key(owner, id).pk);
    return record ? structuredClone(record) : undefined;
  }
  async put(record: ManagementRecord, expectedVersion: number | null): Promise<void> {
    return this.transact([{ record, expectedVersion }]);
  }
  async transact(writes: readonly ManagementWrite[]): Promise<void> {
    const prepared = transactionWrites(writes);
    for (const { record, expectedVersion } of prepared) {
      const current = this.records.get(key(record.owner, record.id).pk);
      if ((current?.version ?? null) !== expectedVersion) throw createError('IDEMPOTENCY_CONFLICT');
    }
    // There are no awaits between validation and commit: either every CAS passes or nothing changes.
    for (const { record } of prepared) this.records.set(key(record.owner, record.id).pk, record);
  }
}

/** Separate keys keep private artifact bytes out of governance audit events. */
export class DynamoManagementStore implements ManagementStore {
  private readonly client: DynamoDBDocumentClient;
  constructor(private readonly options: DynamoStateOptions) {
    this.client = options.client ?? createDynamoDocumentClient();
  }
  async get(owner: string, id: string): Promise<ManagementRecord | undefined> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.options.tableName,
        Key: key(owner, id),
        ConsistentRead: true,
      }),
    );
    if (!response.Item) return undefined;
    const record = response.Item.payload as ManagementRecord;
    validate(record);
    if (record.owner !== owner || record.id !== id)
      throw new Error('Management ownership mismatch.');
    return record;
  }
  async put(record: ManagementRecord, expectedVersion: number | null): Promise<void> {
    validate(record, expectedVersion);
    if (record.kind !== 'artifact' && record.kind !== 'chunk')
      return this.transact([{ record, expectedVersion }]);
    try {
      await this.client.send(
        new PutCommand(
          statePut(this.options.tableName, { record: structuredClone(record), expectedVersion }),
        ),
      );
    } catch (error) {
      if (isConditionalConflict(error)) throw createError('IDEMPOTENCY_CONFLICT');
      throw error;
    }
  }
  async transact(writes: readonly ManagementWrite[]): Promise<void> {
    const prepared = transactionWrites(writes);
    const items = prepared.flatMap((write) => [
      { Put: statePut(this.options.tableName, write) },
      ...(write.record.kind === 'artifact' || write.record.kind === 'chunk'
        ? []
        : [{ Put: auditPut(this.options.tableName, write.record) }]),
    ]);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (isConditionalConflict(error)) throw createError('IDEMPOTENCY_CONFLICT');
      throw error;
    }
  }
}
