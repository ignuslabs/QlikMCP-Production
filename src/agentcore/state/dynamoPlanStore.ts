import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  durableRecord,
  planOwnershipKey,
  storedRecord,
  validateDurableRecord,
  type PlanRepository,
  type StoredPlan,
} from '../../policy/planStore.js';
import {
  createDynamoDocumentClient,
  expiryEpochSeconds,
  itemPayload,
  type DynamoStateOptions,
} from './dynamoClient.js';

const KIND = 'plan';
export const DEFAULT_PLAN_RETENTION_DAYS = 30;

function partitionKey(ownerActor: string, planHash: string): string {
  return `PLAN#${planOwnershipKey(ownerActor, planHash)}`;
}

export class DynamoPlanStore implements PlanRepository {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;
  private readonly retentionDays: number;

  constructor(options: DynamoStateOptions & { readonly retentionDays?: number }) {
    this.retentionDays = options.retentionDays ?? DEFAULT_PLAN_RETENTION_DAYS;
    if (
      !Number.isInteger(this.retentionDays) ||
      this.retentionDays < 30 ||
      this.retentionDays > 3650
    ) {
      throw new Error('AgentCore plan retention must be an integer from 30 through 3650 days.');
    }
    this.tableName = options.tableName;
    this.client = options.client ?? createDynamoDocumentClient();
  }

  async save(stored: StoredPlan): Promise<void> {
    const record = durableRecord(stored);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: partitionKey(record.ownerActor, record.plan.planHash),
          sk: 'STATE',
          kind: KIND,
          integrityHash: record.integrityHash,
          // Keep verification evidence beyond the logical write-authority expiry.
          expiresAtEpoch: expiryEpochSeconds(record.plan.expiresAt) + this.retentionDays * 86_400,
          payload: record,
        },
      }),
    );
  }

  async get(ownerActor: string, planHash: string): Promise<StoredPlan | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: partitionKey(ownerActor, planHash), sk: 'STATE' },
        ConsistentRead: true,
      }),
    );
    const payload = itemPayload(result.Item, KIND);
    if (payload === undefined) return undefined;
    const record = validateDurableRecord(payload);
    if (record.ownerActor !== ownerActor || record.plan.planHash !== planHash) {
      throw new Error(
        'AgentCore durable plan key does not match its actor ownership and plan hash.',
      );
    }
    return storedRecord(record);
  }
}
