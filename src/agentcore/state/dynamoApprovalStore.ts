import { createHash } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { createError } from '../../domain/errors.js';
import { generateApprovalRequestId, generateApprovalToken } from '../../domain/ids.js';
import { redactForAudit } from '../../domain/redaction.js';
import type { ApprovalRecord, ApprovalRequestRecord } from '../../domain/types.js';
import {
  validateApproval,
  validateRequest,
  type ApplyBindingParams,
  type ApprovalRepository,
  type CreateApprovalRequestParams,
  type IssueApprovalParams,
} from '../../policy/approvalStore.js';
import { digestKey } from '../../policy/idempotencyStore.js';
import {
  createDynamoDocumentClient,
  expiryEpochSeconds,
  isConditionalConflict,
  itemPayload,
  type DynamoStateOptions,
} from './dynamoClient.js';

const REQUEST_KIND = 'approval-request';
const APPROVAL_KIND = 'approval';

function opaqueDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function requestKey(requestId: string): Record<string, string> {
  return { pk: `APPROVAL_REQUEST#${requestId}`, sk: 'STATE' };
}

function approvalKey(approvalToken: string): Record<string, string> {
  return { pk: `APPROVAL#${opaqueDigest(approvalToken)}`, sk: 'STATE' };
}

function safeRequest(request: ApprovalRequestRecord): ApprovalRequestRecord {
  return validateRequest(redactForAudit(request));
}

function safeApproval(approval: ApprovalRecord): ApprovalRecord {
  return validateApproval(redactForAudit(approval));
}

export class DynamoApprovalStore implements ApprovalRepository {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(options: DynamoStateOptions) {
    this.tableName = options.tableName;
    this.client = options.client ?? createDynamoDocumentClient();
  }

  async request(params: CreateApprovalRequestParams): Promise<ApprovalRequestRecord> {
    const now = new Date();
    const request = safeRequest({
      requestId: generateApprovalRequestId(),
      planHash: params.planHash,
      requestingActor: params.requestingActor,
      connectionAlias: params.connectionAlias,
      appId: params.appId,
      sheetId: params.sheetId,
      riskClass: params.riskClass,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + params.ttlMs).toISOString(),
      status: 'pending',
      ...(params.note ? { note: params.note } : {}),
      ...(params.reviewContext ? { reviewContext: params.reviewContext } : {}),
    });
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...requestKey(request.requestId),
          kind: REQUEST_KIND,
          expiresAtEpoch: expiryEpochSeconds(request.expiresAt),
          payload: request,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return request;
  }

  async getRequest(requestId: string): Promise<ApprovalRequestRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: requestKey(requestId),
        ConsistentRead: true,
      }),
    );
    const payload = itemPayload(result.Item, REQUEST_KIND);
    if (payload === undefined) return undefined;
    const request = validateRequest(payload);
    if (request.requestId !== requestId) {
      throw new Error('AgentCore approval request key does not match its request ID.');
    }
    return request;
  }

  async approve(requestId: string, decidingActor: string, ttlMs: number): Promise<ApprovalRecord> {
    const request = await this.requirePendingRequest(requestId, decidingActor);
    const now = new Date();
    const rawToken = generateApprovalToken();
    const storedToken = opaqueDigest(rawToken);
    const approval = this.issueRecord(
      {
        planHash: request.planHash,
        actor: request.requestingActor,
        reviewedBy: decidingActor,
        connectionAlias: request.connectionAlias,
        appId: request.appId,
        sheetId: request.sheetId,
        riskClass: request.riskClass,
        ttlMs,
      },
      rawToken,
      now,
    );
    const storedApproval = safeApproval({ ...approval, approvalToken: storedToken });
    const updatedRequest = safeRequest({
      ...request,
      status: 'approved',
      decidedAt: approval.decidedAt,
      decidedBy: decidingActor,
      approvalToken: storedToken,
    });

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...approvalKey(rawToken),
                  kind: APPROVAL_KIND,
                  expiresAtEpoch: expiryEpochSeconds(storedApproval.expiresAt),
                  payload: storedApproval,
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...requestKey(requestId),
                  kind: REQUEST_KIND,
                  expiresAtEpoch: expiryEpochSeconds(updatedRequest.expiresAt),
                  payload: updatedRequest,
                },
                ConditionExpression:
                  '#payload.#status = :pending AND #payload.#requestingActor <> :decidingActor',
                ExpressionAttributeNames: {
                  '#payload': 'payload',
                  '#status': 'status',
                  '#requestingActor': 'requestingActor',
                },
                ExpressionAttributeValues: {
                  ':pending': 'pending',
                  ':decidingActor': decidingActor,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionalConflict(error)) throw createError('APPROVAL_ALREADY_DECIDED');
      throw error;
    }
    return approval;
  }

  async reject(
    requestId: string,
    decidingActor: string,
    reason?: string,
  ): Promise<ApprovalRequestRecord> {
    const request = await this.requirePendingRequest(requestId, decidingActor);
    const rejected = safeRequest({
      ...request,
      status: 'rejected',
      decidedAt: new Date().toISOString(),
      decidedBy: decidingActor,
      ...(reason ? { rejectionReason: reason } : {}),
    });
    try {
      await this.replaceRequestWhenPending(rejected, decidingActor);
    } catch (error) {
      if (isConditionalConflict(error)) throw createError('APPROVAL_ALREADY_DECIDED');
      throw error;
    }
    return rejected;
  }

  async expire(approvalToken: string): Promise<ApprovalRecord> {
    const record = await this.requireApproval(approvalToken);
    if (record.state !== 'requested' && record.state !== 'approved') {
      throw createError('PERMISSION_DENIED', {
        message: `Approval cannot transition from ${record.state}.`,
      });
    }
    const expired = safeApproval({
      ...record,
      approvalToken: opaqueDigest(approvalToken),
      state: 'expired',
    });
    await this.replaceApprovalWhenState(approvalToken, expired, record.state);
    return { ...expired, approvalToken };
  }

  async get(approvalToken: string): Promise<ApprovalRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: approvalKey(approvalToken),
        ConsistentRead: true,
      }),
    );
    const payload = itemPayload(result.Item, APPROVAL_KIND);
    return payload === undefined ? undefined : { ...validateApproval(payload), approvalToken };
  }

  async assertValidForApply(
    approvalToken: string,
    params: ApplyBindingParams,
  ): Promise<ApprovalRecord> {
    let record = await this.requireApproval(approvalToken);
    if (
      (record.state === 'requested' || record.state === 'approved') &&
      Date.now() > Date.parse(record.expiresAt)
    ) {
      const previousState = record.state;
      record = safeApproval({
        ...record,
        approvalToken: opaqueDigest(approvalToken),
        state: 'expired',
      });
      await this.replaceApprovalWhenState(approvalToken, record, previousState);
    }
    if (record.state === 'consumed') throw createError('APPROVAL_REPLAYED');
    if (record.state === 'expired') throw createError('APPROVAL_EXPIRED');
    if (record.state !== 'approved') {
      throw createError('PERMISSION_DENIED', { message: `Approval is ${record.state}.` });
    }
    if (record.actor !== params.actor) throw createError('APPROVAL_ACTOR_MISMATCH');
    if (record.planHash !== params.planHash) throw createError('APPROVAL_PLAN_HASH_MISMATCH');
    if (
      record.connectionAlias !== params.connectionAlias ||
      record.appId !== params.appId ||
      record.sheetId !== params.sheetId
    ) {
      throw createError('APPROVAL_TARGET_MISMATCH');
    }
    return { ...record, approvalToken };
  }

  async consume(approvalToken: string, idempotencyKey: string): Promise<void> {
    const record = await this.requireApproval(approvalToken);
    if (record.state !== 'approved' || record.consumed) throw createError('APPROVAL_REPLAYED');
    const consumed = safeApproval({
      ...record,
      approvalToken: opaqueDigest(approvalToken),
      consumed: true,
      state: 'consumed',
      consumedByIdempotencyKey: digestKey(idempotencyKey),
    });
    try {
      await this.replaceApprovalWhenState(approvalToken, consumed, 'approved', true);
    } catch (error) {
      if (isConditionalConflict(error)) throw createError('APPROVAL_REPLAYED');
      throw error;
    }
  }

  private async requirePendingRequest(
    requestId: string,
    decidingActor: string,
  ): Promise<ApprovalRequestRecord> {
    const request = await this.getRequest(requestId);
    if (!request) throw createError('APPROVAL_REQUEST_NOT_FOUND');
    if (Date.now() > Date.parse(request.expiresAt)) throw createError('APPROVAL_REQUEST_EXPIRED');
    if (request.status !== 'pending') throw createError('APPROVAL_ALREADY_DECIDED');
    if (request.requestingActor === decidingActor) {
      throw createError('PERMISSION_DENIED', {
        message: 'The requester cannot decide their own visualization request.',
      });
    }
    return request;
  }

  private async requireApproval(approvalToken: string): Promise<ApprovalRecord> {
    const record = await this.get(approvalToken);
    if (!record) throw createError('APPROVAL_NOT_FOUND', { details: { approvalToken } });
    return record;
  }

  private issueRecord(
    params: IssueApprovalParams,
    approvalToken: string,
    now: Date,
  ): ApprovalRecord {
    return {
      approvalToken,
      planHash: params.planHash,
      actor: params.actor,
      reviewedBy: params.reviewedBy,
      connectionAlias: params.connectionAlias,
      appId: params.appId,
      sheetId: params.sheetId,
      riskClass: params.riskClass,
      expiresAt: new Date(now.getTime() + params.ttlMs).toISOString(),
      singleUse: true,
      state: 'approved',
      consumed: false,
      decidedAt: now.toISOString(),
      createdAt: now.toISOString(),
    };
  }

  private async replaceRequestWhenPending(
    request: ApprovalRequestRecord,
    decidingActor: string,
  ): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: requestKey(request.requestId),
        UpdateExpression: 'SET #payload = :payload',
        ConditionExpression:
          '#payload.#status = :pending AND #payload.#requestingActor <> :decidingActor',
        ExpressionAttributeNames: {
          '#payload': 'payload',
          '#status': 'status',
          '#requestingActor': 'requestingActor',
        },
        ExpressionAttributeValues: {
          ':payload': request,
          ':pending': 'pending',
          ':decidingActor': decidingActor,
        },
      }),
    );
  }

  private async replaceApprovalWhenState(
    approvalToken: string,
    approval: ApprovalRecord,
    expectedState: ApprovalRecord['state'],
    requireUnconsumed = false,
  ): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: approvalKey(approvalToken),
        UpdateExpression: 'SET #payload = :payload',
        ConditionExpression: requireUnconsumed
          ? '#payload.#state = :expectedState AND #payload.#consumed = :notConsumed'
          : '#payload.#state = :expectedState',
        ExpressionAttributeNames: {
          '#payload': 'payload',
          '#state': 'state',
          ...(requireUnconsumed ? { '#consumed': 'consumed' } : {}),
        },
        ExpressionAttributeValues: {
          ':payload': approval,
          ':expectedState': expectedState,
          ...(requireUnconsumed ? { ':notConsumed': false } : {}),
        },
      }),
    );
  }
}
