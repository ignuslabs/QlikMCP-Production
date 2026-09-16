import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { createError } from '../../domain/errors.js';
import { redactForAudit } from '../../domain/redaction.js';
import type { IdempotencyRecord, IdempotencyStatus } from '../../domain/types.js';
import {
  digestKey,
  validateRecord,
  type IdempotencyBindingParams,
  type IdempotencyLookup,
  type IdempotencyRepository,
} from '../../policy/idempotencyStore.js';
import {
  createDynamoDocumentClient,
  isConditionalConflict,
  itemPayload,
  type DynamoStateOptions,
} from './dynamoClient.js';

const KIND = 'idempotency';

function recordKey(key: string): Record<string, string> {
  return { pk: `IDEMPOTENCY#${digestKey(key)}`, sk: 'STATE' };
}

export class DynamoIdempotencyStore implements IdempotencyRepository {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(options: DynamoStateOptions) {
    this.tableName = options.tableName;
    this.client = options.client ?? createDynamoDocumentClient();
  }

  async lookup(key: string, params: IdempotencyBindingParams): Promise<IdempotencyLookup> {
    const existing = await this.get(key);
    if (!existing) return { kind: 'miss' };
    const bindingMatches =
      existing.actor === params.actor &&
      existing.connectionAlias === params.connectionAlias &&
      existing.appId === params.appId &&
      existing.sheetId === params.sheetId &&
      existing.planHash === params.planHash;
    if (bindingMatches && existing.status === 'completed') {
      return { kind: 'replay', record: existing };
    }
    return { kind: 'conflict', record: existing };
  }

  async beginInProgress(
    key: string,
    params: IdempotencyBindingParams,
    operationId: string,
  ): Promise<void> {
    const record: IdempotencyRecord = {
      idempotencyKey: digestKey(key),
      actor: params.actor,
      connectionAlias: params.connectionAlias,
      appId: params.appId,
      sheetId: params.sheetId,
      planHash: params.planHash,
      status: 'in-progress' satisfies IdempotencyStatus,
      operationId,
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...recordKey(key), kind: KIND, payload: record },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (isConditionalConflict(error)) {
        throw createError('IDEMPOTENCY_CONFLICT', {
          details: { idempotencyKey: record.idempotencyKey },
        });
      }
      throw error;
    }
  }

  async complete(key: string, result: unknown): Promise<void> {
    const record = await this.get(key);
    if (!record || record.status !== 'in-progress') {
      throw createError('IDEMPOTENCY_CONFLICT', {
        details: { idempotencyKey: digestKey(key) },
      });
    }
    await this.replaceWhenStatus(
      key,
      {
        ...record,
        status: 'completed',
        result: redactForAudit(result),
      },
      'in-progress',
    );
  }

  async fail(key: string): Promise<void> {
    const record = await this.get(key);
    if (!record) {
      throw createError('IDEMPOTENCY_CONFLICT', {
        details: { idempotencyKey: digestKey(key) },
      });
    }
    await this.replaceWhenStatus(key, { ...record, status: 'failed' }, record.status);
  }

  private async get(key: string): Promise<IdempotencyRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: recordKey(key),
        ConsistentRead: true,
      }),
    );
    const payload = itemPayload(result.Item, KIND);
    return payload === undefined ? undefined : validateRecord(payload);
  }

  private async replaceWhenStatus(
    key: string,
    record: IdempotencyRecord,
    expectedStatus: IdempotencyStatus,
  ): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: recordKey(key),
          UpdateExpression: 'SET #payload = :payload',
          ConditionExpression: '#payload.#status = :expectedStatus',
          ExpressionAttributeNames: { '#payload': 'payload', '#status': 'status' },
          ExpressionAttributeValues: { ':payload': record, ':expectedStatus': expectedStatus },
        }),
      );
    } catch (error) {
      if (isConditionalConflict(error)) {
        throw createError('IDEMPOTENCY_CONFLICT', {
          details: { idempotencyKey: digestKey(key) },
        });
      }
      throw error;
    }
  }
}
