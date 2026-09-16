import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultApprovalStore,
  FileApprovalStore,
} from '../../../src/policy/approvalStore.js';
import {
  createDefaultIdempotencyStore,
  FileIdempotencyStore,
} from '../../../src/policy/idempotencyStore.js';
import {
  createDefaultOperationStore,
  FileOperationStore,
} from '../../../src/policy/operationStore.js';
import { withStateFileLockSync } from '../../../src/policy/filePersistence.js';
import type { OperationRecord } from '../../../src/domain/types.js';

const temporaryDirectories: string[] = [];

function temporaryStateDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'qlik-harness-state-'));
  temporaryDirectories.push(directory);
  return directory;
}

function operationRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    recordVersion: '1.0.0',
    recordType: 'sanitized-operation-audit',
    operationId: 'operation-1',
    timestamp: '2026-08-06T00:00:00.000Z',
    correlationId: 'correlation-1',
    requestingPrincipal: 'requester-1',
    hostClientId: 'requester-host',
    connectionAlias: 'cloud-dev',
    platform: 'cloud',
    target: { appId: 'app-1', sheetId: 'sheet-1' },
    effectiveQlikIdentityClass: 'cloud-development-workload',
    intentVersion: '1.0.0',
    compilerVersion: '1.0.0',
    planHash: 'sha256:plan-1',
    policyResult: 'pending-authorized-decision',
    approvalState: 'pending',
    typedOutcome: { status: 'approval-requested' },
    retryCount: 0,
    durationMilliseconds: 10,
    cleanupAttempted: false,
    cleanupOutcome: 'not-required',
    createdObjectId: null,
    sheetAttachmentId: null,
    traceReference: 'harness-trace-operation-1',
    redaction: {
      rawPayloadsRemoved: true,
      sensitiveValuesRemoved: true,
      credentialMaterialPresent: false,
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable policy stores', () => {
  it('preserves the lock-acquisition error as the timeout cause', () => {
    const filePath = path.join(temporaryStateDirectory(), 'state.json');
    writeFileSync(`${filePath}.lock`, 'another-process\n', 'utf8');
    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(5_000)
      .mockReturnValue(5_000);
    let thrown: unknown;
    try {
      withStateFileLockSync(filePath, () => undefined);
    } catch (error) {
      thrown = error;
    } finally {
      dateNow.mockRestore();
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error & { cause?: NodeJS.ErrnoException }).cause?.code).toBe('EEXIST');
  });

  it('persists approval state across instances while binding the token to the requester', () => {
    const filePath = path.join(temporaryStateDirectory(), 'approvals.json');
    const first = new FileApprovalStore(filePath);
    const request = first.request({
      planHash: 'sha256:plan-1',
      requestingActor: 'requester-1',
      connectionAlias: 'cloud-dev',
      appId: 'app-1',
      sheetId: 'sheet-1',
      riskClass: 'standard',
      ttlMs: 60_000,
      note: 'Bearer should-never-reach-disk',
      reviewContext: {
        operationId: 'operation-1',
        correlationId: 'correlation-1',
        platform: 'cloud',
        chartType: 'bar',
        title: 'Revenue by region',
        resolvedSummary: { dimensions: ['Region'], measures: ['Revenue'], filters: [] },
        warnings: [],
        diff: {
          summary: 'Create a revenue chart.',
          additions: ['dimension: Region', 'measure: Revenue'],
          removals: [],
        },
      },
    });

    const reviewerProcess = new FileApprovalStore(filePath);
    expect(reviewerProcess.getRequest(request.requestId)?.reviewContext).toMatchObject({
      operationId: 'operation-1',
      chartType: 'bar',
    });
    const approval = reviewerProcess.approve(request.requestId, 'reviewer-1', 60_000);
    expect(approval).toMatchObject({ actor: 'requester-1', reviewedBy: 'reviewer-1' });

    const requesterProcess = new FileApprovalStore(filePath);
    expect(() =>
      requesterProcess.assertValidForApply(approval.approvalToken, {
        planHash: 'sha256:plan-1',
        actor: 'requester-1',
        connectionAlias: 'cloud-dev',
        appId: 'app-1',
        sheetId: 'sheet-1',
      }),
    ).not.toThrow();
    requesterProcess.consume(approval.approvalToken, 'idempotency-1');
    expect(new FileApprovalStore(filePath).get(approval.approvalToken)).toMatchObject({
      state: 'consumed',
      consumed: true,
      consumedByIdempotencyKey: 'idempotency-1',
    });
    expect(readFileSync(filePath, 'utf8')).not.toContain('should-never-reach-disk');
  });

  it('persists completed idempotency results and redacts them before writing', () => {
    const filePath = path.join(temporaryStateDirectory(), 'idempotency.json');
    const binding = {
      actor: 'requester-1',
      connectionAlias: 'cloud-dev',
      appId: 'app-1',
      sheetId: 'sheet-1',
      planHash: 'sha256:plan-1',
    };
    const first = new FileIdempotencyStore(filePath);
    first.beginInProgress('idempotency-1', binding, 'operation-1');
    first.complete('idempotency-1', {
      objectId: 'object-1',
      accessToken: 'Bearer should-never-reach-disk',
    });

    const replay = new FileIdempotencyStore(filePath).lookup('idempotency-1', binding);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') {
      expect(replay.record.result).toEqual({
        objectId: 'object-1',
        accessToken: '[redacted]',
      });
    }
    expect(readFileSync(filePath, 'utf8')).not.toContain('should-never-reach-disk');
  });

  it('preserves a bearer-shaped idempotency identity across reserve, reload, and complete', () => {
    const filePath = path.join(temporaryStateDirectory(), 'idempotency.json');
    const key = ['Bearer', 'durable-idempotency-identity'].join(' ');
    const binding = {
      actor: 'requester-1',
      connectionAlias: 'cloud-dev',
      appId: 'app-1',
      sheetId: 'sheet-1',
      planHash: 'sha256:plan-1',
    } as const;

    new FileIdempotencyStore(filePath).beginInProgress(key, binding, 'operation-1');
    const reservedState = readFileSync(filePath, 'utf8');
    expect(reservedState).not.toContain(key);
    expect(reservedState).not.toContain('durable-idempotency-identity');

    new FileIdempotencyStore(filePath).complete(key, { objectId: 'object-1' });
    const replay = new FileIdempotencyStore(filePath).lookup(key, binding);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') {
      expect(replay.record.result).toEqual({ objectId: 'object-1' });
      expect(replay.record.idempotencyKey).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(replay.record)).not.toContain(key);
    }
  });

  it('preserves a JWT-shaped idempotency identity across reload and failure', () => {
    const filePath = path.join(temporaryStateDirectory(), 'idempotency.json');
    const key = ['headersegmentvalue', 'payloadsegmentvalue', 'signaturesegmentvalue'].join('.');
    const binding = {
      actor: 'requester-1',
      connectionAlias: 'cloud-dev',
      appId: 'app-1',
      sheetId: 'sheet-1',
      planHash: 'sha256:plan-1',
    } as const;

    new FileIdempotencyStore(filePath).beginInProgress(key, binding, 'operation-1');
    new FileIdempotencyStore(filePath).fail(key);
    const lookup = new FileIdempotencyStore(filePath).lookup(key, binding);
    expect(lookup.kind).toBe('conflict');
    expect(readFileSync(filePath, 'utf8')).not.toContain(key);
  });

  it('fails closed when a legacy durable idempotency identity was already redacted', () => {
    const filePath = path.join(temporaryStateDirectory(), 'idempotency.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        records: [
          {
            idempotencyKey: '[redacted]',
            actor: 'requester-1',
            connectionAlias: 'cloud-dev',
            appId: 'app-1',
            sheetId: 'sheet-1',
            planHash: 'sha256:plan-1',
            status: 'in-progress',
            operationId: 'operation-1',
          },
        ],
      }),
      'utf8',
    );

    expect(() => new FileIdempotencyStore(filePath)).toThrow(/unrecoverable redacted key/i);
  });

  it('appends operation history and preserves actor participation across instances', async () => {
    const filePath = path.join(temporaryStateDirectory(), 'operations.json');
    const requesterStore = new FileOperationStore(filePath);
    await requesterStore.save(operationRecord());

    const reviewerStore = new FileOperationStore(filePath);
    await reviewerStore.save(
      operationRecord({
        timestamp: '2026-08-06T00:00:01.000Z',
        requestingPrincipal: 'reviewer-1',
        hostClientId: 'reviewer-host',
        policyResult: 'approved-by-independent-reviewer',
        approvalState: 'issued',
        typedOutcome: { status: 'approved' },
      }),
    );

    const restartedStore = new FileOperationStore(filePath);
    expect(await restartedStore.history('operation-1')).toHaveLength(2);
    expect(await restartedStore.get('operation-1')).toMatchObject({
      requestingPrincipal: 'reviewer-1',
      typedOutcome: { status: 'approved' },
    });
    expect(await restartedStore.getForActor('operation-1', 'requester-1')).toMatchObject({
      typedOutcome: { status: 'approval-requested' },
    });
  });

  it('fails closed instead of replacing corrupt durable state', () => {
    const directory = temporaryStateDirectory();
    const approvalPath = path.join(directory, 'approvals.json');
    const idempotencyPath = path.join(directory, 'idempotency.json');
    const operationPath = path.join(directory, 'operations.json');
    for (const filePath of [approvalPath, idempotencyPath, operationPath]) {
      writeFileSync(filePath, '{not-json', 'utf8');
    }

    expect(() => new FileApprovalStore(approvalPath)).toThrow(/corrupt durable state/i);
    expect(() => new FileIdempotencyStore(idempotencyPath)).toThrow(/corrupt durable state/i);
    expect(() => new FileOperationStore(operationPath)).toThrow(/corrupt durable state/i);
    expect(readFileSync(approvalPath, 'utf8')).toBe('{not-json');
  });

  it('also fails closed on well-formed JSON with an invalid durable schema', () => {
    const filePath = path.join(temporaryStateDirectory(), 'approvals.json');
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, approvals: [], requests: [{ requestId: 'incomplete' }] }),
      'utf8',
    );
    expect(() => new FileApprovalStore(filePath)).toThrow(/durable (approval|state)/i);
  });

  it('selects and writes the approval, idempotency, and operation stores from QLIK_HARNESS_STATE_DIR', async () => {
    const directory = temporaryStateDirectory();
    vi.stubEnv('QLIK_HARNESS_STATE_DIR', directory);
    vi.stubEnv('QLIK_HARNESS_APPROVAL_STORE_PATH', '');
    vi.stubEnv('QLIK_HARNESS_IDEMPOTENCY_STORE_PATH', '');
    vi.stubEnv('QLIK_HARNESS_OPERATION_STORE_PATH', '');

    const approvals = createDefaultApprovalStore();
    const idempotency = createDefaultIdempotencyStore();
    const operations = createDefaultOperationStore();
    expect(approvals).toBeInstanceOf(FileApprovalStore);
    expect(idempotency).toBeInstanceOf(FileIdempotencyStore);
    expect(operations).toBeInstanceOf(FileOperationStore);

    approvals.request({
      planHash: 'sha256:plan-1',
      requestingActor: 'requester-1',
      connectionAlias: 'cloud-dev',
      appId: 'app-1',
      sheetId: 'sheet-1',
      riskClass: 'standard',
      ttlMs: 60_000,
    });
    idempotency.beginInProgress(
      'idempotency-1',
      {
        actor: 'requester-1',
        connectionAlias: 'cloud-dev',
        appId: 'app-1',
        sheetId: 'sheet-1',
        planHash: 'sha256:plan-1',
      },
      'operation-1',
    );
    await operations.save(operationRecord());
    expect(existsSync(path.join(directory, 'approvals.json'))).toBe(true);
    expect(existsSync(path.join(directory, 'idempotency.json'))).toBe(true);
    expect(existsSync(path.join(directory, 'operations.json'))).toBe(true);
  });
});
