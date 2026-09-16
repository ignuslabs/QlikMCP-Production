import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ApprovalRepository } from '../../policy/approvalStore.js';
import type { IdempotencyRepository } from '../../policy/idempotencyStore.js';
import type { OperationStore } from '../../policy/operationStore.js';
import type { PlanRepository } from '../../policy/planStore.js';
import { createDynamoDocumentClient, requireDynamoStateTable } from './dynamoClient.js';
import { DynamoApprovalStore } from './dynamoApprovalStore.js';
import { DynamoIdempotencyStore } from './dynamoIdempotencyStore.js';
import { DynamoOperationStore } from './dynamoOperationStore.js';
import { DynamoPlanStore } from './dynamoPlanStore.js';

export interface AgentCoreStateStores {
  readonly plans: PlanRepository;
  readonly approvals: ApprovalRepository;
  readonly idempotency: IdempotencyRepository;
  readonly operations: OperationStore;
}

export function createAgentCoreStateStores(
  options: {
    readonly tableName?: string;
    readonly client?: DynamoDBDocumentClient;
    readonly planRetentionDays?: number;
  } = {},
): AgentCoreStateStores {
  const tableName = options.tableName ?? requireDynamoStateTable();
  const client = options.client ?? createDynamoDocumentClient();
  const storeOptions = {
    tableName,
    client,
  };
  return {
    plans: new DynamoPlanStore({
      ...storeOptions,
      ...(options.planRetentionDays !== undefined
        ? { retentionDays: options.planRetentionDays }
        : {}),
    }),
    approvals: new DynamoApprovalStore(storeOptions),
    idempotency: new DynamoIdempotencyStore(storeOptions),
    operations: new DynamoOperationStore(storeOptions),
  };
}
