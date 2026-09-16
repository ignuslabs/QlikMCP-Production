import { generateApprovalRequestId, generateApprovalToken } from '../domain/ids.js';
import { createError } from '../domain/errors.js';
import { redactForAudit } from '../domain/redaction.js';
import type {
  ApprovalRecord,
  ApprovalRequestRecord,
  ApprovalReviewContext,
  ConnectionAlias,
  RiskClass,
} from '../domain/types.js';
import { CHART_TYPE_IDS } from '../domain/types.js';
import {
  configuredStatePath,
  isRecord,
  readJsonStateSnapshot,
  requireString,
  withStateFileLockSync,
  writeJsonStateAtomic,
} from './filePersistence.js';
import type { Awaitable } from './storeTypes.js';

export interface IssueApprovalParams {
  readonly planHash: string;
  readonly actor: string;
  readonly reviewedBy: string;
  readonly connectionAlias: ConnectionAlias;
  readonly appId: string;
  readonly sheetId: string;
  readonly riskClass: RiskClass;
  readonly ttlMs: number;
}

export interface CreateApprovalRequestParams {
  readonly planHash: string;
  readonly requestingActor: string;
  readonly connectionAlias: ConnectionAlias;
  readonly appId: string;
  readonly sheetId: string;
  readonly riskClass: RiskClass;
  readonly ttlMs: number;
  readonly note?: string;
  readonly reviewContext?: ApprovalReviewContext;
}

export interface ApplyBindingParams {
  readonly planHash: string;
  readonly actor: string;
  readonly connectionAlias: ConnectionAlias;
  readonly appId: string;
  readonly sheetId: string;
}

export interface ApprovalRepository {
  request(params: CreateApprovalRequestParams): Awaitable<ApprovalRequestRecord>;
  getRequest(requestId: string): Awaitable<ApprovalRequestRecord | undefined>;
  approve(requestId: string, decidingActor: string, ttlMs: number): Awaitable<ApprovalRecord>;
  reject(
    requestId: string,
    decidingActor: string,
    reason?: string,
  ): Awaitable<ApprovalRequestRecord>;
  expire(approvalToken: string): Awaitable<ApprovalRecord>;
  get(approvalToken: string): Awaitable<ApprovalRecord | undefined>;
  assertValidForApply(approvalToken: string, params: ApplyBindingParams): Awaitable<ApprovalRecord>;
  consume(approvalToken: string, idempotencyKey: string): Awaitable<void>;
}

interface ApprovalStateFile {
  readonly version: 1;
  readonly approvals: readonly ApprovalRecord[];
  readonly requests: readonly ApprovalRequestRecord[];
}

const APPROVAL_STATES = new Set(['requested', 'approved', 'rejected', 'expired', 'consumed']);
const REQUEST_STATES = new Set(['pending', 'approved', 'rejected']);
const RISK_CLASSES = new Set(['standard', 'elevated', 'restricted']);
const PLATFORMS = new Set(['cloud', 'windows', 'fixture']);

function validateOptionalString(record: Record<string, unknown>, key: string): void {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    throw new Error(`Durable approval field ${key} must be a string when present.`);
  }
}

function validateTimestamp(record: Record<string, unknown>, key: string): void {
  const value = requireString(record, key);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Durable approval field ${key} must be an ISO timestamp.`);
  }
}

function validateReviewContext(value: unknown): ApprovalReviewContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Durable approval reviewContext must be an object.');
  requireString(value, 'operationId');
  requireString(value, 'correlationId');
  if (!PLATFORMS.has(requireString(value, 'platform'))) {
    throw new Error('Durable approval reviewContext has an invalid platform.');
  }
  if (!(CHART_TYPE_IDS as readonly string[]).includes(requireString(value, 'chartType'))) {
    throw new Error('Durable approval reviewContext has an invalid chart type.');
  }
  requireString(value, 'title');
  if (!isRecord(value.resolvedSummary)) {
    throw new Error('Durable approval resolvedSummary must be an object.');
  }
  for (const key of ['dimensions', 'measures'] as const) {
    const entries = value.resolvedSummary[key];
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) {
      throw new Error(`Durable approval resolvedSummary.${key} must be a string array.`);
    }
  }
  const filters = value.resolvedSummary.filters;
  if (
    !Array.isArray(filters) ||
    !filters.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.field === 'string' &&
        entry.field.length > 0 &&
        Array.isArray(entry.values) &&
        entry.values.every((filterValue) => typeof filterValue === 'string'),
    )
  ) {
    throw new Error('Durable approval resolvedSummary.filters must contain bounded filters.');
  }
  if (
    !Array.isArray(value.warnings) ||
    !value.warnings.every((entry) => typeof entry === 'string')
  ) {
    throw new Error('Durable approval warnings must be a string array.');
  }
  if (!isRecord(value.diff)) {
    throw new Error('Durable approval diff must be an object.');
  }
  requireString(value.diff, 'summary');
  for (const key of ['additions', 'removals'] as const) {
    const entries = value.diff[key];
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) {
      throw new Error(`Durable approval diff.${key} must be a string array.`);
    }
  }
  return value as unknown as ApprovalReviewContext;
}

export function validateApproval(value: unknown): ApprovalRecord {
  if (!isRecord(value)) throw new Error('Durable approval entry must be an object.');
  for (const key of [
    'approvalToken',
    'planHash',
    'actor',
    'reviewedBy',
    'connectionAlias',
    'appId',
    'sheetId',
    'riskClass',
    'expiresAt',
    'createdAt',
    'state',
  ]) {
    requireString(value, key);
  }
  if (!APPROVAL_STATES.has(value.state as string) || value.singleUse !== true) {
    throw new Error('Durable approval entry has an invalid state or single-use marker.');
  }
  if (!RISK_CLASSES.has(value.riskClass as string)) {
    throw new Error('Durable approval entry has an invalid risk class.');
  }
  if (typeof value.consumed !== 'boolean') {
    throw new Error('Durable approval consumed marker must be boolean.');
  }
  validateTimestamp(value, 'createdAt');
  validateTimestamp(value, 'expiresAt');
  validateOptionalString(value, 'decidedAt');
  validateOptionalString(value, 'consumedByIdempotencyKey');
  return value as unknown as ApprovalRecord;
}

export function validateRequest(value: unknown): ApprovalRequestRecord {
  if (!isRecord(value)) throw new Error('Durable approval request must be an object.');
  for (const key of [
    'requestId',
    'planHash',
    'requestingActor',
    'connectionAlias',
    'appId',
    'sheetId',
    'riskClass',
    'createdAt',
    'expiresAt',
    'status',
  ]) {
    requireString(value, key);
  }
  if (!REQUEST_STATES.has(value.status as string)) {
    throw new Error('Durable approval request has an invalid status.');
  }
  if (!RISK_CLASSES.has(value.riskClass as string)) {
    throw new Error('Durable approval request has an invalid risk class.');
  }
  validateTimestamp(value, 'createdAt');
  validateTimestamp(value, 'expiresAt');
  for (const key of ['note', 'decidedAt', 'decidedBy', 'rejectionReason', 'approvalToken']) {
    validateOptionalString(value, key);
  }
  validateReviewContext(value.reviewContext);
  return value as unknown as ApprovalRequestRecord;
}

function validateState(value: unknown): ApprovalStateFile {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Durable approval state has an unsupported version.');
  }
  if (!Array.isArray(value.approvals) || !Array.isArray(value.requests)) {
    throw new Error('Durable approval state must contain approval and request arrays.');
  }
  const approvals = value.approvals.map(validateApproval);
  const requests = value.requests.map(validateRequest);
  if (new Set(approvals.map((record) => record.approvalToken)).size !== approvals.length) {
    throw new Error('Durable approval state contains duplicate approval tokens.');
  }
  if (new Set(requests.map((request) => request.requestId)).size !== requests.length) {
    throw new Error('Durable approval state contains duplicate request IDs.');
  }
  return {
    version: 1,
    approvals,
    requests,
  };
}

/**
 * Single-use approval state. The base implementation is in-memory; the file
 * implementation below persists the same transitions through atomic snapshots.
 */
export class ApprovalStore {
  protected approvals = new Map<string, ApprovalRecord>();
  protected requests = new Map<string, ApprovalRequestRecord>();

  protected prepare(): void {}

  protected commit(): void {}

  request(params: CreateApprovalRequestParams): ApprovalRequestRecord {
    this.prepare();
    const now = new Date();
    const request: ApprovalRequestRecord = {
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
    };
    this.requests.set(request.requestId, request);
    this.commit();
    return request;
  }

  getRequest(requestId: string): ApprovalRequestRecord | undefined {
    this.prepare();
    return this.requests.get(requestId);
  }

  approve(requestId: string, decidingActor: string, ttlMs: number): ApprovalRecord {
    this.prepare();
    const request = this.assertPendingLoaded(requestId);
    if (request.requestingActor === decidingActor) {
      throw createError('PERMISSION_DENIED', {
        message: 'The requester cannot approve their own visualization request.',
      });
    }
    const approval = this.issueLoaded({
      planHash: request.planHash,
      actor: request.requestingActor,
      reviewedBy: decidingActor,
      connectionAlias: request.connectionAlias,
      appId: request.appId,
      sheetId: request.sheetId,
      riskClass: request.riskClass,
      ttlMs,
    });
    request.status = 'approved';
    request.decidedAt = approval.decidedAt;
    request.decidedBy = decidingActor;
    request.approvalToken = approval.approvalToken;
    this.commit();
    return approval;
  }

  reject(requestId: string, decidingActor: string, reason?: string): ApprovalRequestRecord {
    this.prepare();
    const request = this.assertPendingLoaded(requestId);
    if (request.requestingActor === decidingActor) {
      throw createError('PERMISSION_DENIED', {
        message: 'The requester cannot decide their own visualization request.',
      });
    }
    request.status = 'rejected';
    request.decidedAt = new Date().toISOString();
    request.decidedBy = decidingActor;
    request.rejectionReason = reason;
    this.commit();
    return request;
  }

  private assertPendingLoaded(requestId: string): ApprovalRequestRecord {
    const request = this.requests.get(requestId);
    if (!request) throw createError('APPROVAL_REQUEST_NOT_FOUND');
    if (Date.now() > Date.parse(request.expiresAt)) throw createError('APPROVAL_REQUEST_EXPIRED');
    if (request.status !== 'pending') throw createError('APPROVAL_ALREADY_DECIDED');
    return request;
  }

  private issueLoaded(params: IssueApprovalParams): ApprovalRecord {
    const now = new Date();
    const record: ApprovalRecord = {
      approvalToken: generateApprovalToken(),
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
    this.approvals.set(record.approvalToken, record);
    return record;
  }

  expire(approvalToken: string): ApprovalRecord {
    this.prepare();
    const record = this.approvals.get(approvalToken);
    if (!record) throw createError('APPROVAL_NOT_FOUND', { details: { approvalToken } });
    if (record.state !== 'requested' && record.state !== 'approved') {
      throw createError('PERMISSION_DENIED', {
        message: `Approval cannot transition from ${record.state}.`,
      });
    }
    record.state = 'expired';
    this.commit();
    return record;
  }

  get(approvalToken: string): ApprovalRecord | undefined {
    this.prepare();
    return this.approvals.get(approvalToken);
  }

  /** Validates every binding without consuming the approval. */
  assertValidForApply(approvalToken: string, params: ApplyBindingParams): ApprovalRecord {
    this.prepare();
    const record = this.approvals.get(approvalToken);
    if (!record) {
      throw createError('APPROVAL_NOT_FOUND', { details: { approvalToken } });
    }
    if (
      (record.state === 'requested' || record.state === 'approved') &&
      Date.now() > Date.parse(record.expiresAt)
    ) {
      record.state = 'expired';
      this.commit();
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
    return record;
  }

  /** Atomically marks an approval consumed in this store instance. */
  consume(approvalToken: string, idempotencyKey: string): void {
    this.prepare();
    const record = this.approvals.get(approvalToken);
    if (!record) throw createError('APPROVAL_NOT_FOUND', { details: { approvalToken } });
    if (record.state !== 'approved' || record.consumed) throw createError('APPROVAL_REPLAYED');
    record.consumed = true;
    record.state = 'consumed';
    record.consumedByIdempotencyKey = idempotencyKey;
    this.commit();
  }
}

export class FileApprovalStore extends ApprovalStore {
  private snapshot: string | undefined;

  constructor(private readonly filePath: string) {
    super();
    this.reload();
  }

  protected override prepare(): void {
    this.reload();
  }

  protected override commit(): void {
    const state: ApprovalStateFile = {
      version: 1,
      approvals: [...this.approvals.values()],
      requests: [...this.requests.values()],
    };
    withStateFileLockSync(this.filePath, () => {
      const current = readJsonStateSnapshot(this.filePath).raw;
      if (current !== this.snapshot) {
        throw new Error('Durable approval state changed concurrently; retry the operation.');
      }
      writeJsonStateAtomic(this.filePath, redactForAudit(state));
      this.snapshot = readJsonStateSnapshot(this.filePath).raw;
    });
  }

  private reload(): void {
    const snapshot = readJsonStateSnapshot(this.filePath);
    this.snapshot = snapshot.raw;
    if (snapshot.value === undefined) {
      this.approvals = new Map();
      this.requests = new Map();
      return;
    }
    const state = validateState(snapshot.value);
    this.approvals = new Map(state.approvals.map((record) => [record.approvalToken, record]));
    this.requests = new Map(state.requests.map((request) => [request.requestId, request]));
  }
}

export function createDefaultApprovalStore(): ApprovalStore {
  const filePath = configuredStatePath('QLIK_HARNESS_APPROVAL_STORE_PATH', 'approvals.json');
  return filePath ? new FileApprovalStore(filePath) : new ApprovalStore();
}
