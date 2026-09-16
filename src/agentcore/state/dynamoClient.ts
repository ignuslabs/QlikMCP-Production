import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isRecord } from '../../policy/filePersistence.js';

export interface DynamoStateOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export function createDynamoDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export function requireDynamoStateTable(environment = process.env): string {
  const tableName = environment.QLIK_AGENTCORE_STATE_TABLE?.trim();
  if (!tableName) {
    throw new Error('QLIK_AGENTCORE_STATE_TABLE is required for AgentCore durable state.');
  }
  return tableName;
}

export function itemPayload(item: Record<string, unknown> | undefined, kind: string): unknown {
  if (!item) return undefined;
  if (item.kind !== kind || !isRecord(item.payload)) {
    throw new Error(`AgentCore DynamoDB ${kind} item has an invalid shape.`);
  }
  return item.payload;
}

export function expiryEpochSeconds(isoTimestamp: string): number {
  return Math.floor(Date.parse(isoTimestamp) / 1000);
}

export function isConditionalConflict(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.name === 'ConditionalCheckFailedException') return true;
  if (error.name !== 'TransactionCanceledException') return false;
  const reasons = error.CancellationReasons;
  return (
    Array.isArray(reasons) &&
    reasons.some((reason) => isRecord(reason) && reason.Code === 'ConditionalCheckFailed')
  );
}
