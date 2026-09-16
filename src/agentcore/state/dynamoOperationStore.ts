import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { redactForAudit } from '../../domain/redaction.js';
import type { OperationRecord } from '../../domain/types.js';
import { validateOperationRecord, type OperationStore } from '../../policy/operationStore.js';
import {
  createDynamoDocumentClient,
  itemPayload,
  type DynamoStateOptions,
} from './dynamoClient.js';

const KIND = 'operation';

function partitionKey(operationId: string): string {
  return `OPERATION#${operationId}`;
}

function historySortKey(record: OperationRecord): string {
  return `EVENT#${record.timestamp}#${randomUUID()}`;
}

export class DynamoOperationStore implements OperationStore {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(options: DynamoStateOptions) {
    this.tableName = options.tableName;
    this.client = options.client ?? createDynamoDocumentClient();
  }

  async save(record: OperationRecord): Promise<void> {
    const safe = validateOperationRecord(redactForAudit(record));
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                pk: partitionKey(safe.operationId),
                sk: 'LATEST',
                kind: KIND,
                payload: safe,
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                pk: partitionKey(safe.operationId),
                sk: historySortKey(safe),
                kind: KIND,
                payload: safe,
              },
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
        ],
      }),
    );
  }

  async get(operationId: string): Promise<OperationRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: partitionKey(operationId), sk: 'LATEST' },
        ConsistentRead: true,
      }),
    );
    const payload = itemPayload(result.Item, KIND);
    return payload === undefined ? undefined : validateOperationRecord(payload);
  }

  async getForActor(operationId: string, actor: string): Promise<OperationRecord | undefined> {
    const latest = await this.get(operationId);
    if (latest?.requestingPrincipal === actor) return latest;
    // A later denied call may belong to another actor. Preserve access to the
    // owner's most recent event without exposing the other actor's record.
    const records = await this.history(operationId);
    return [...records].reverse().find((record) => record.requestingPrincipal === actor);
  }

  async history(operationId?: string): Promise<readonly OperationRecord[]> {
    if (!operationId) {
      throw new Error('AgentCore operation history requires an exact operation ID.');
    }
    const items = await this.queryHistory(operationId);
    return items
      .map((item) => validateOperationRecord(itemPayload(item, KIND)))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  private async queryHistory(operationId: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :eventPrefix)',
          ExpressionAttributeValues: {
            ':pk': partitionKey(operationId),
            ':eventPrefix': 'EVENT#',
          },
          ExclusiveStartKey: exclusiveStartKey,
          ConsistentRead: true,
        }),
      );
      items.push(...(page.Items ?? []));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }
}
