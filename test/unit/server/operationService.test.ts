import { describe, expect, it, vi } from 'vitest';
import {
  buildTestService,
  buildReviewerService,
  CLOUD_DEV,
  MUTATOR_ACTOR,
  OTHER_MUTATOR_ACTOR,
  READ_ONLY_ACTOR,
  REVIEWER_ACTOR,
  barChartIntent,
} from '../../helpers/testContext.js';
import { ApprovalStore } from '../../../src/policy/approvalStore.js';
import { IdempotencyStore } from '../../../src/policy/idempotencyStore.js';
import { InMemoryOperationStore } from '../../../src/policy/operationStore.js';
import { PlanStore } from '../../../src/policy/planStore.js';
import type { OperationRecord } from '../../../src/domain/types.js';
import { createError, type HarnessError } from '../../../src/domain/errors.js';
import { findForbiddenPaths } from '../../../src/domain/redaction.js';
import type { OperationEventSink } from '../../../src/observability/operationEvents.js';

class FailOnceOnApplyReservationStore extends InMemoryOperationStore {
  private failed = false;

  constructor(private readonly failure: unknown = new Error('simulated operation audit failure')) {
    super();
  }

  override async save(record: OperationRecord): Promise<void> {
    if (!this.failed && record.policyResult === 'apply-reserved-before-adapter-mutation') {
      this.failed = true;
      throw this.failure;
    }
    await super.save(record);
  }
}

class FinalizationOutageIdempotencyStore extends IdempotencyStore {
  completeCalls = 0;
  failCalls = 0;

  constructor(private readonly outage: { readonly complete?: boolean; readonly fail?: boolean }) {
    super();
  }

  override complete(key: string, result: unknown): void {
    this.completeCalls += 1;
    if (this.outage.complete) {
      throw new Error('Bearer raw-complete-store-error-must-not-leak');
    }
    super.complete(key, result);
  }

  override fail(key: string): void {
    this.failCalls += 1;
    if (this.outage.fail) {
      throw new Error('Bearer raw-fail-store-error-must-not-leak');
    }
    super.fail(key);
  }
}

async function planAndApprove(overrides?: Parameters<typeof buildTestService>[0]) {
  const handle = buildTestService(overrides);
  const plan = await handle.service.planVisualization(
    CLOUD_DEV.connection,
    CLOUD_DEV.appId,
    CLOUD_DEV.writableSheetId,
    barChartIntent(),
  );
  const request = await handle.service.requestApproval(plan.planHash);
  const approval = await buildReviewerService(handle).service.approveApproval(request.requestId);
  return { ...handle, plan, approval };
}

describe('OperationService: full lifecycle', () => {
  it('runs discover -> catalog -> plan -> preview -> approve -> apply -> verify end to end', async () => {
    const handle = buildTestService();
    const { service } = handle;

    const apps = await service.listApps(CLOUD_DEV.connection);
    expect(apps.apps.map((app) => app.appId)).toContain(CLOUD_DEV.appId);

    const catalog = await service.getAppCatalog(CLOUD_DEV.connection, CLOUD_DEV.appId);
    expect(catalog.dimensions.length).toBeGreaterThan(0);

    const plan = await service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    expect(plan.previewEligible).toBe(true);

    const preview = await service.previewVisualization(plan.planHash);
    expect(preview.status).toBe('previewed');
    expect(preview.preview.rows.length).toBeGreaterThan(0);

    const request = await service.requestApproval(plan.planHash);
    const approval = await buildReviewerService(handle).service.approveApproval(request.requestId);
    expect(request.status).toBe('pending');
    expect(approval.status).toBe('approved');

    const applied = await service.applyVisualization(
      plan.planHash,
      approval.approvalToken,
      'e2e-key-1',
    );
    expect(applied.status).toBe('verified');
    expect(applied.verified).toBe(true);

    const objects = await service.listSheetObjects(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
    );
    expect(objects.objects.map((entry) => entry.objectId)).toContain(applied.objectId);

    const operation = await service.getOperation(applied.operationId);
    expect(operation.typedOutcome.status).toBe('verified');
    expect(operation.createdObjectId).toBe(applied.objectId);
  });

  it('resolves a default sheet automatically when exactly one write-allowed sheet exists', async () => {
    const { service } = buildTestService();
    const plan = await service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      undefined,
      barChartIntent(),
    );
    expect(plan.target.sheetId).toBe(CLOUD_DEV.writableSheetId);
  });
});

describe('OperationService: catalog/discovery safety', () => {
  it('propagates adapter continuation tokens for apps, catalog, and sheet objects', async () => {
    const { service, fixtureAdapter } = buildTestService();
    const listApps = fixtureAdapter.listAccessibleApps.bind(fixtureAdapter);
    const getCatalog = fixtureAdapter.getSemanticCatalog.bind(fixtureAdapter);
    const listObjects = fixtureAdapter.listSheetObjects.bind(fixtureAdapter);
    vi.spyOn(fixtureAdapter, 'listAccessibleApps').mockImplementation(async (...args) => ({
      ...(await listApps(...args)),
      truncated: true,
      nextPageToken: 'apps:next',
    }));
    vi.spyOn(fixtureAdapter, 'getSemanticCatalog').mockImplementation(async (...args) => ({
      ...(await getCatalog(...args)),
      truncated: true,
      nextPageToken: 'catalog:next',
    }));
    vi.spyOn(fixtureAdapter, 'listSheetObjects').mockImplementation(async (...args) => ({
      ...(await listObjects(...args)),
      truncated: true,
      nextPageToken: 'objects:next',
    }));

    await expect(service.listApps(CLOUD_DEV.connection)).resolves.toMatchObject({
      nextPageToken: 'apps:next',
    });
    await expect(
      service.getAppCatalog(CLOUD_DEV.connection, CLOUD_DEV.appId),
    ).resolves.toMatchObject({ nextPageToken: 'catalog:next' });
    await expect(
      service.listSheetObjects(CLOUD_DEV.connection, CLOUD_DEV.appId, CLOUD_DEV.writableSheetId),
    ).resolves.toMatchObject({ nextPageToken: 'objects:next' });
  });

  it('fails with EMPTY_CATALOG for the empty catalog variant', async () => {
    const { service } = buildTestService();
    await expect(
      service.getAppCatalog(CLOUD_DEV.connection, CLOUD_DEV.appId, 'empty'),
    ).rejects.toMatchObject({
      code: 'EMPTY_CATALOG',
    });
  });

  it('never returns sensitive or hidden metadata from catalog discovery', async () => {
    const { service } = buildTestService();
    const catalog = await service.getAppCatalog(CLOUD_DEV.connection, CLOUD_DEV.appId);
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toMatch(/CustomerEmail/);
    expect(serialized).not.toMatch(/InternalTenantKey/);
    expect(serialized).not.toMatch(/LoadTimestamp/);
  });
});

describe('OperationService: planning safety (unknown/ambiguous/sensitive/unsafe expressions)', () => {
  it('rejects an ambiguous field with candidate IDs and performs no mutation', async () => {
    const { service } = buildTestService();
    await expect(
      service.planVisualization(
        CLOUD_DEV.connection,
        CLOUD_DEV.appId,
        CLOUD_DEV.writableSheetId,
        barChartIntent({ dimensions: ['Status'] }),
      ),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_FIELD' });
  });

  it('rejects a sensitive field reference', async () => {
    const { service } = buildTestService();
    await expect(
      service.planVisualization(
        CLOUD_DEV.connection,
        CLOUD_DEV.appId,
        CLOUD_DEV.writableSheetId,
        barChartIntent({ dimensions: ['CustomerEmail'] }),
      ),
    ).rejects.toMatchObject({ code: 'SENSITIVE_FIELD' });
  });

  it('rejects a caller-supplied compound expression', async () => {
    const { service } = buildTestService();
    await expect(
      service.planVisualization(
        CLOUD_DEV.connection,
        CLOUD_DEV.appId,
        CLOUD_DEV.writableSheetId,
        barChartIntent({ measures: ['Sum(Revenue)+Avg(Margin)'] }),
      ),
    ).rejects.toMatchObject({ code: 'DISALLOWED_EXPRESSION' });
  });
});

describe('OperationService: high-cardinality bounded preview', () => {
  it('bounds a high-cardinality dimension and reports truncation with a continuation token', async () => {
    const { service } = buildTestService();
    const plan = await service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      {
        analysis: { dimensions: ['CustomerID'], measures: ['Revenue'] },
        presentation: { preferredChartType: 'table', title: 'Customer revenue', topN: 10 },
        mode: 'preview',
      },
    );
    expect(plan.warnings).toContain('high-cardinality-dimension');

    const preview = await service.previewVisualization(plan.planHash);
    expect(preview.preview.truncated).toBe(true);
    expect(preview.preview.returnedRows).toBe(10);
    expect(preview.preview.maxRows).toBe(10);
    expect(preview.preview.continuation).toBe('fixture-continuation-001');
  });
});

describe('OperationService: bounded preview finalization', () => {
  async function planned(overrides?: Parameters<typeof buildTestService>[0]) {
    const handle = buildTestService(overrides);
    const plan = await handle.service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    return { ...handle, plan };
  }

  it('disposes on success and emits a sanitized successful preview audit', async () => {
    const { service, fixtureAdapter, operations, plan } = await planned();
    const dispose = vi.spyOn(fixtureAdapter, 'disposeSessionChart');

    await expect(service.previewVisualization(plan.planHash)).resolves.toMatchObject({
      status: 'previewed',
    });

    expect(dispose).toHaveBeenCalledOnce();
    const record = await operations.get(plan.operationId);
    expect(record).toMatchObject({
      cleanupAttempted: true,
      cleanupOutcome: 'session-disposed',
      typedOutcome: { status: 'previewed' },
    });
    expect(findForbiddenPaths(record)).toEqual([]);
  });

  it('disposes when preview rendering fails and audits only the safe failure', async () => {
    const { service, fixtureAdapter, operations, plan } = await planned();
    const dispose = vi.spyOn(fixtureAdapter, 'disposeSessionChart');
    vi.spyOn(fixtureAdapter, 'renderDescriptor').mockImplementation(() => {
      throw new Error('safe rendering failure');
    });

    await expect(service.previewVisualization(plan.planHash)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(await operations.get(plan.operationId)).toMatchObject({
      cleanupAttempted: true,
      cleanupOutcome: 'session-disposed',
      typedOutcome: { status: 'failed', code: 'INTERNAL_ERROR' },
    });
  });

  it('propagates caller cancellation to the adapter and disposes an allocated session', async () => {
    const { service, fixtureAdapter, operations, plan } = await planned();
    const external = new AbortController();
    const originalCreate = fixtureAdapter.createSessionChart.bind(fixtureAdapter);
    const create = vi
      .spyOn(fixtureAdapter, 'createSessionChart')
      .mockImplementation(async (request) => {
        const result = await originalCreate(request);
        external.abort();
        return result;
      });
    const dispose = vi.spyOn(fixtureAdapter, 'disposeSessionChart');

    await expect(
      service.previewVisualization(plan.planHash, external.signal),
    ).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
    });
    expect(create.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(await operations.get(plan.operationId)).toMatchObject({
      cleanupOutcome: 'session-disposed',
      typedOutcome: { status: 'failed', code: 'OPERATION_CANCELLED' },
    });
  });

  it('bounds a hung adapter call, propagates timeout cancellation, and audits finalization', async () => {
    const { service, fixtureAdapter, operations, plan } = await planned({ previewTimeoutMs: 5 });
    let receivedSignal: AbortSignal | undefined;
    vi.spyOn(fixtureAdapter, 'createSessionChart').mockImplementation(
      (request) =>
        new Promise((_, reject) => {
          receivedSignal = request.signal;
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );

    await expect(service.previewVisualization(plan.planHash)).rejects.toMatchObject({
      code: 'PREVIEW_TIMEOUT',
    });
    expect(receivedSignal?.aborted).toBe(true);
    expect(await operations.get(plan.operationId)).toMatchObject({
      cleanupAttempted: false,
      cleanupOutcome: 'not-required',
      typedOutcome: { status: 'failed', code: 'PREVIEW_TIMEOUT' },
    });
  });

  it('enforces actor concurrency and releases capacity after cancellation', async () => {
    const { service, fixtureAdapter, plan } = await planned({
      maxConcurrentPreviewsPerActor: 1,
    });
    const external = new AbortController();
    vi.spyOn(fixtureAdapter, 'createSessionChart').mockImplementation(
      (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const first = service.previewVisualization(plan.planHash, external.signal);
    await Promise.resolve();
    await expect(service.previewVisualization(plan.planHash)).rejects.toMatchObject({
      code: 'CAPACITY_EXHAUSTED',
      details: { scope: 'actor' },
    });
    external.abort();
    await expect(first).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
  });
});

describe('OperationService: default-deny mutation and read-only actors', () => {
  it('refuses to issue an approval for an actor outside the mutation allowlist', async () => {
    const { service } = buildTestService({
      actor: READ_ONLY_ACTOR,
      mutationActors: new Set([MUTATOR_ACTOR.actor]),
    });
    const plan = await service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    // Preview (read/session-only) still succeeds for a read-only actor.
    await expect(service.previewVisualization(plan.planHash)).resolves.toMatchObject({
      status: 'previewed',
    });
    // But no approval -- and therefore no persistence -- is possible.
    await expect(service.requestApproval(plan.planHash)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('denies apply to a designated read-only sheet even for an allowlisted mutation actor', async () => {
    const handle = buildTestService();
    const { service } = handle;
    const plan = await service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.readOnlySheetId,
      barChartIntent(),
    );
    const request = await service.requestApproval(plan.planHash);
    const approval = await buildReviewerService(handle).service.approveApproval(request.requestId);
    await expect(
      service.applyVisualization(plan.planHash, approval.approvalToken, 'readonly-key'),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });
});

describe('OperationService: approval binding', () => {
  it('keeps requests pending, supports terminal rejection, and sanitizes lookup', async () => {
    const handle = buildTestService();
    const { service } = handle;
    const reviewer = buildReviewerService(handle).service;
    const plan = await service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    const request = await service.requestApproval(plan.planHash);
    expect(request.status).toBe('pending');
    expect(request).not.toHaveProperty('approvalToken');

    const rejected = await reviewer.rejectApproval(request.requestId, 'review failed');
    expect(rejected).toMatchObject({ status: 'rejected', rejectionReason: 'review failed' });
    const lookup = await service.getApprovalRequest(request.requestId);
    expect(lookup).not.toHaveProperty('approvalToken');
    await expect(reviewer.approveApproval(request.requestId)).rejects.toMatchObject({
      code: 'APPROVAL_ALREADY_DECIDED',
    });
  });

  it('rejects an apply after the approval has expired', async () => {
    const handle = buildTestService({ approvalTtlMs: -1 });
    const { service } = handle;
    const plan = await service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    const request = await service.requestApproval(plan.planHash);
    const approval = await buildReviewerService(handle, undefined, {
      approvalTtlMs: -1,
    }).service.approveApproval(request.requestId);
    await expect(
      service.applyVisualization(plan.planHash, approval.approvalToken, 'expiry-key'),
    ).rejects.toMatchObject({
      code: 'APPROVAL_EXPIRED',
    });
  });

  it('rejects a second apply attempt reusing a consumed approval with a new idempotency key', async () => {
    const { service, plan, approval } = await planAndApprove();
    await service.applyVisualization(plan.planHash, approval.approvalToken, 'first-key');
    await expect(
      service.applyVisualization(plan.planHash, approval.approvalToken, 'second-key'),
    ).rejects.toMatchObject({
      code: 'APPROVAL_REPLAYED',
    });
  });

  it('rejects an approval bound to a different actor than the one applying', async () => {
    // Two OperationService instances (different actors) sharing one ApprovalStore: serviceA
    // requests approval as MUTATOR_ACTOR; serviceB independently plans the identical, deterministic
    // intent (same plan hash) and then tries to apply using serviceA's approval token as OTHER_MUTATOR_ACTOR.
    const sharedApprovals = new ApprovalStore();
    const mutationActors = new Set([MUTATOR_ACTOR.actor, OTHER_MUTATOR_ACTOR.actor]);
    const handleA = buildTestService({
      actor: MUTATOR_ACTOR,
      mutationActors,
      approvals: sharedApprovals,
    });
    const serviceA = handleA.service;
    const serviceB = buildTestService({
      actor: OTHER_MUTATOR_ACTOR,
      mutationActors,
      approvals: sharedApprovals,
    }).service;

    const planA = await serviceA.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    const requestA = await serviceA.requestApproval(planA.planHash);
    const approvalA = await buildReviewerService(handleA).service.approveApproval(
      requestA.requestId,
    );

    const planB = await serviceB.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    expect(planB.planHash).toBe(planA.planHash);

    await expect(
      serviceB.applyVisualization(planB.planHash, approvalA.approvalToken, 'actor-mismatch-key'),
    ).rejects.toMatchObject({
      code: 'APPROVAL_ACTOR_MISMATCH',
    });
  });

  it('isolates identical plan hashes and operation history across actors sharing a plan store', async () => {
    const plans = new PlanStore();
    const operations = new InMemoryOperationStore();
    const mutationActors = new Set([MUTATOR_ACTOR.actor, OTHER_MUTATOR_ACTOR.actor]);
    const first = buildTestService({
      actor: MUTATOR_ACTOR,
      mutationActors,
      plans,
      operations,
    });
    const second = buildTestService({
      actor: OTHER_MUTATOR_ACTOR,
      mutationActors,
      plans,
      operations,
    });

    const planA = await first.service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    const planB = await second.service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    expect(planB.planHash).toBe(planA.planHash);
    expect(planB.operationId).not.toBe(planA.operationId);

    const previewA = await first.service.previewVisualization(planA.planHash);
    const previewB = await second.service.previewVisualization(planB.planHash);
    expect(previewA.operationId).toBe(planA.operationId);
    expect(previewB.operationId).toBe(planB.operationId);

    await expect(first.service.getOperation(planA.operationId)).resolves.toMatchObject({
      operationId: planA.operationId,
      requestingPrincipal: MUTATOR_ACTOR.actor,
      typedOutcome: { status: 'previewed' },
    });
    await expect(second.service.getOperation(planB.operationId)).resolves.toMatchObject({
      operationId: planB.operationId,
      requestingPrincipal: OTHER_MUTATOR_ACTOR.actor,
      typedOutcome: { status: 'previewed' },
    });
    await expect(first.service.getOperation(planB.operationId)).rejects.toMatchObject({
      code: 'OPERATION_ACCESS_DENIED',
    });
    await expect(second.service.getOperation(planA.operationId)).rejects.toMatchObject({
      code: 'OPERATION_ACCESS_DENIED',
    });
    expect(
      (await operations.history(planA.operationId)).map((record) => record.requestingPrincipal),
    ).toEqual([MUTATOR_ACTOR.actor, MUTATOR_ACTOR.actor]);
    expect(
      (await operations.history(planB.operationId)).map((record) => record.requestingPrincipal),
    ).toEqual([OTHER_MUTATOR_ACTOR.actor, OTHER_MUTATOR_ACTOR.actor]);
  });

  it('rejects an approval token bound to a different plan hash', async () => {
    const { service, plan: planA, approval: approvalA } = await planAndApprove();
    const planB = await service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent({ measures: ['Margin'] }),
    );
    expect(planB.planHash).not.toBe(planA.planHash);
    await expect(
      service.applyVisualization(planB.planHash, approvalA.approvalToken, 'plan-hash-mismatch-key'),
    ).rejects.toMatchObject({
      code: 'APPROVAL_PLAN_HASH_MISMATCH',
    });
  });
});

describe('OperationService: idempotency replay and conflict', () => {
  it('keeps approval consumption and retry state accurate when reservation audit storage fails', async () => {
    const operations = new FailOnceOnApplyReservationStore();
    const { service, approvals, idempotency, fixtureAdapter, plan, approval } =
      await planAndApprove({ operations });
    const persist = vi.spyOn(fixtureAdapter, 'persistChart');

    await expect(
      service.applyVisualization(plan.planHash, approval.approvalToken, 'audit-failure-key'),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    expect(persist).not.toHaveBeenCalled();
    expect(approvals.get(approval.approvalToken)).toMatchObject({
      consumed: true,
      state: 'consumed',
      consumedByIdempotencyKey: 'audit-failure-key',
    });
    expect(
      idempotency.lookup('audit-failure-key', {
        actor: MUTATOR_ACTOR.actor,
        connectionAlias: CLOUD_DEV.connection,
        appId: CLOUD_DEV.appId,
        sheetId: CLOUD_DEV.writableSheetId,
        planHash: plan.planHash,
      }),
    ).toMatchObject({ kind: 'conflict', record: { status: 'failed' } });
    expect((await operations.history(plan.operationId)).at(-1)).toMatchObject({
      policyResult: 'apply-reservation-audit-failed',
      approvalState: 'consumed',
      typedOutcome: { status: 'failed', code: 'INTERNAL_ERROR', retryable: false },
    });
    await expect(
      service.applyVisualization(plan.planHash, approval.approvalToken, 'audit-failure-key'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('keeps approval consumption and retry state accurate when reservation telemetry fails', async () => {
    let failed = false;
    const eventSink: OperationEventSink = {
      emit(event) {
        if (
          !failed &&
          event.attributes['qlik.policy.result'] === 'apply-reserved-before-adapter-mutation'
        ) {
          failed = true;
          throw new Error('simulated operation telemetry failure');
        }
      },
    };
    const { service, approvals, idempotency, operations, fixtureAdapter, plan, approval } =
      await planAndApprove({ operationEvents: eventSink });
    const persist = vi.spyOn(fixtureAdapter, 'persistChart');

    await expect(
      service.applyVisualization(plan.planHash, approval.approvalToken, 'telemetry-failure-key'),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    expect(persist).not.toHaveBeenCalled();
    expect(approvals.get(approval.approvalToken)).toMatchObject({
      consumed: true,
      state: 'consumed',
      consumedByIdempotencyKey: 'telemetry-failure-key',
    });
    expect(
      idempotency.lookup('telemetry-failure-key', {
        actor: MUTATOR_ACTOR.actor,
        connectionAlias: CLOUD_DEV.connection,
        appId: CLOUD_DEV.appId,
        sheetId: CLOUD_DEV.writableSheetId,
        planHash: plan.planHash,
      }),
    ).toMatchObject({ kind: 'conflict', record: { status: 'failed' } });
    expect((await operations.history(plan.operationId)).at(-1)).toMatchObject({
      policyResult: 'apply-reservation-audit-failed',
      approvalState: 'consumed',
      typedOutcome: { status: 'failed', code: 'INTERNAL_ERROR', retryable: false },
    });
    await expect(
      service.applyVisualization(plan.planHash, approval.approvalToken, 'telemetry-failure-key'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('preserves a preflight primary failure and records an unconfirmed idempotency transition', async () => {
    const operations = new FailOnceOnApplyReservationStore(createError('TRANSIENT_UNAVAILABLE'));
    const idempotency = new FinalizationOutageIdempotencyStore({ fail: true });
    const { service, fixtureAdapter, plan, approval } = await planAndApprove({
      operations,
      idempotency,
    });
    const persist = vi.spyOn(fixtureAdapter, 'persistChart');
    const baseline = await service.listSheetObjects(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
    );

    let failure: unknown;
    try {
      await service.applyVisualization(
        plan.planHash,
        approval.approvalToken,
        'preflight-finalization-outage-key',
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
      details: { idempotencyState: 'unconfirmed', auditRecorded: true },
    });
    expect(persist).not.toHaveBeenCalled();
    expect(idempotency.completeCalls).toBe(0);
    expect(idempotency.failCalls).toBe(1);
    await expect(
      service.listSheetObjects(CLOUD_DEV.connection, CLOUD_DEV.appId, CLOUD_DEV.writableSheetId),
    ).resolves.toEqual(baseline);
    expect((await operations.history(plan.operationId)).at(-1)).toMatchObject({
      policyResult: 'apply-reservation-audit-failed-idempotency-state-unconfirmed',
      typedOutcome: { status: 'failed', code: 'TRANSIENT_UNAVAILABLE' },
      cleanupAttempted: false,
      cleanupOutcome: 'not-required',
    });
    expect(
      JSON.stringify({
        failure: (failure as HarnessError).toEnvelope(),
        history: await operations.history(plan.operationId),
      }),
    ).not.toMatch(/raw-fail-store-error-must-not-leak/);
  });

  it('preserves an adapter failure when the post-reservation fail transition is unavailable', async () => {
    const idempotency = new FinalizationOutageIdempotencyStore({ fail: true });
    const { service, operations, plan, approval } = await planAndApprove({
      idempotency,
      faults: [{ method: 'persistChart', errorCode: 'PERMISSION_DENIED' }],
    });
    const baseline = await service.listSheetObjects(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
    );

    let failure: unknown;
    try {
      await service.applyVisualization(
        plan.planHash,
        approval.approvalToken,
        'mutation-boundary-finalization-outage-key',
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { idempotencyState: 'unconfirmed', auditRecorded: true },
    });
    expect(idempotency.completeCalls).toBe(0);
    expect(idempotency.failCalls).toBe(1);
    await expect(
      service.listSheetObjects(CLOUD_DEV.connection, CLOUD_DEV.appId, CLOUD_DEV.writableSheetId),
    ).resolves.toEqual(baseline);
    expect((await operations.history(plan.operationId)).at(-1)).toMatchObject({
      policyResult: 'allowed-designated-development-sheet-idempotency-state-unconfirmed',
      typedOutcome: { status: 'failed', code: 'PERMISSION_DENIED' },
      cleanupAttempted: false,
      cleanupOutcome: 'not-required',
    });
    expect(
      JSON.stringify({
        failure: (failure as HarnessError).toEnvelope(),
        history: await operations.history(plan.operationId),
      }),
    ).not.toMatch(/raw-fail-store-error-must-not-leak/);
  });

  it('replays the original result for a matching completed idempotency key without a new mutation', async () => {
    const { service, fixtureAdapter, plan, approval } = await planAndApprove();
    const first = await service.applyVisualization(
      plan.planHash,
      approval.approvalToken,
      'replay-key',
    );
    const persistSpy = vi.spyOn(fixtureAdapter, 'persistChart');
    const replayed = await service.applyVisualization(
      plan.planHash,
      approval.approvalToken,
      'replay-key',
    );
    expect(replayed).toEqual(first);
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('fails a conflicting reuse of the same idempotency key for a different plan', async () => {
    const handle = buildTestService();
    const { service } = handle;
    const reviewer = buildReviewerService(handle).service;
    const planA = await service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    const requestA = await service.requestApproval(planA.planHash);
    const approvalA = await reviewer.approveApproval(requestA.requestId);
    const secretShapedKey = 'Bearer idempotency-key-must-not-leak';
    await service.applyVisualization(planA.planHash, approvalA.approvalToken, secretShapedKey);

    const planB = await service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent({ measures: ['Margin'] }),
    );
    const requestB = await service.requestApproval(planB.planHash);
    const approvalB = await reviewer.approveApproval(requestB.requestId);
    let conflict: unknown;
    try {
      await service.applyVisualization(planB.planHash, approvalB.approvalToken, secretShapedKey);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(JSON.stringify(conflict)).not.toContain(secretShapedKey);
  });
});

describe('OperationService: partial-apply cleanup', () => {
  it('restores the exact object baseline when complete and fail both outage after mutation', async () => {
    const idempotency = new FinalizationOutageIdempotencyStore({ complete: true, fail: true });
    const { service, operations, fixtureAdapter, plan, approval } = await planAndApprove({
      idempotency,
    });
    const cleanup = vi.spyOn(fixtureAdapter, 'cleanupObject');
    const baseline = await service.listSheetObjects(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
    );

    let failure: unknown;
    try {
      await service.applyVisualization(
        plan.planHash,
        approval.approvalToken,
        'complete-finalization-outage-key',
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'PARTIAL_APPLY',
      details: {
        cleanupRequired: false,
        idempotencyState: 'unconfirmed',
        auditRecorded: true,
        primaryFailureCode: 'INTERNAL_ERROR',
      },
    });
    expect(idempotency.completeCalls).toBe(1);
    expect(idempotency.failCalls).toBe(1);
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(
      service.listSheetObjects(CLOUD_DEV.connection, CLOUD_DEV.appId, CLOUD_DEV.writableSheetId),
    ).resolves.toEqual(baseline);
    const record = await operations.get(plan.operationId);
    expect(record).toMatchObject({
      policyResult: 'allowed-designated-development-sheet-idempotency-state-unconfirmed',
      cleanupAttempted: true,
      cleanupOutcome: 'cleanup-complete',
      typedOutcome: {
        status: 'failed',
        code: 'PARTIAL_APPLY',
        cleanupRequired: false,
      },
    });
    expect(cleanup.mock.calls[0]?.[0].objectId).toBe(
      (failure as { details?: { createdObjectId?: string } }).details?.createdObjectId,
    );
    expect(JSON.stringify({ failure: (failure as HarnessError).toEnvelope(), record })).not.toMatch(
      /raw-(?:complete|fail)-store-error-must-not-leak/,
    );
  });

  it('surfaces cleanup-required evidence when finalization and exact-object cleanup outage', async () => {
    const idempotency = new FinalizationOutageIdempotencyStore({ complete: true, fail: true });
    const { service, operations, fixtureAdapter, plan, approval } = await planAndApprove({
      idempotency,
    });
    const cleanup = vi
      .spyOn(fixtureAdapter, 'cleanupObject')
      .mockRejectedValue(new Error('Bearer raw-cleanup-error-must-not-leak'));
    const baseline = await service.listSheetObjects(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
    );

    let failure: unknown;
    try {
      await service.applyVisualization(
        plan.planHash,
        approval.approvalToken,
        'cleanup-finalization-outage-key',
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'PARTIAL_APPLY',
      details: {
        cleanupRequired: true,
        idempotencyState: 'unconfirmed',
        auditRecorded: true,
        primaryFailureCode: 'INTERNAL_ERROR',
      },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    const createdObjectId = (failure as { details?: { createdObjectId?: string } }).details
      ?.createdObjectId;
    expect(cleanup.mock.calls[0]?.[0].objectId).toBe(createdObjectId);
    const currentObjects = await service.listSheetObjects(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
    );
    expect(currentObjects.objects).toHaveLength(baseline.objects.length + 1);
    expect(currentObjects.objects.map((object) => object.objectId)).toContain(createdObjectId);
    const record = await operations.get(plan.operationId);
    expect(record).toMatchObject({
      policyResult: 'allowed-designated-development-sheet-idempotency-state-unconfirmed',
      cleanupAttempted: true,
      cleanupOutcome: 'cleanup-failed',
      createdObjectId,
      typedOutcome: {
        status: 'cleanup-required',
        code: 'PARTIAL_APPLY',
        cleanupRequired: true,
      },
    });
    expect(JSON.stringify({ failure: (failure as HarnessError).toEnvelope(), record })).not.toMatch(
      /raw-(?:complete|fail)-store-error-must-not-leak|raw-cleanup-error-must-not-leak/,
    );
  });

  it('cleans up the created object and records a failed, cleanup-complete outcome when sheet attachment fails', async () => {
    const { service, operations, plan, approval } = await planAndApprove({
      faults: [{ method: 'attachChartToSheet', errorCode: 'PARTIAL_APPLY' }],
    });
    await expect(
      service.applyVisualization(plan.planHash, approval.approvalToken, 'partial-key'),
    ).rejects.toMatchObject({
      code: 'PARTIAL_APPLY',
    });

    const record = await operations.get(plan.operationId);
    expect(record).toBeDefined();
    expect(record?.cleanupAttempted).toBe(true);
    expect(record?.cleanupOutcome).toBe('cleanup-complete');
    expect(record?.createdObjectId).not.toBeNull();
    expect(record?.sheetAttachmentId).toBeFalsy();
    expect(record?.typedOutcome.status).toBe('failed');
  });

  it('cleans up the attachment and object when native layout verification fails', async () => {
    const { service, operations, plan, approval } = await planAndApprove({
      faults: [{ method: 'verifyChart', errorCode: 'PARTIAL_APPLY' }],
    });
    await expect(
      service.applyVisualization(plan.planHash, approval.approvalToken, 'verification-failure-key'),
    ).rejects.toMatchObject({ code: 'PARTIAL_APPLY' });

    const record = await operations.get(plan.operationId);
    expect(record).toMatchObject({
      cleanupAttempted: true,
      cleanupOutcome: 'cleanup-complete',
      typedOutcome: { status: 'failed' },
    });
    expect(record?.createdObjectId).toBeTruthy();
    expect(record?.sheetAttachmentId).toBeTruthy();
  });
});

describe('OperationService: operation ownership and redaction', () => {
  it('does not grant operation access to an unauthorized reviewer whose decision was denied', async () => {
    const requester = buildTestService();
    const plan = await requester.service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent({ measures: ['Margin'] }),
    );
    const request = await requester.service.requestApproval(plan.planHash);
    const unauthorized = buildTestService({
      actor: OTHER_MUTATOR_ACTOR,
      reviewerActors: new Set([REVIEWER_ACTOR.actor]),
      approvals: requester.approvals,
      idempotency: requester.idempotency,
      operations: requester.operations,
    });
    await expect(unauthorized.service.approveApproval(request.requestId)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(unauthorized.service.getOperation(plan.operationId)).rejects.toMatchObject({
      code: 'OPERATION_ACCESS_DENIED',
    });

    const deniedAudit = (await requester.operations.history()).find(
      (record) => record.policyResult === 'approval-decision-denied',
    );
    expect(deniedAudit?.operationId).not.toBe(plan.operationId);
  });

  it('denies get_operation to an actor that does not own the operation', async () => {
    const { service, operations, plan, approval } = await planAndApprove();
    const applied = await service.applyVisualization(
      plan.planHash,
      approval.approvalToken,
      'ownership-key',
    );

    const otherActorService = buildTestService({ actor: OTHER_MUTATOR_ACTOR, operations }).service;
    await expect(otherActorService.getOperation(applied.operationId)).rejects.toMatchObject({
      code: 'OPERATION_ACCESS_DENIED',
    });
    await expect(service.getOperation(applied.operationId)).resolves.toMatchObject({
      operationId: applied.operationId,
    });
  });

  it('never stores or returns a forbidden field in the operation record', async () => {
    const { service, operations, plan, approval } = await planAndApprove();
    const applied = await service.applyVisualization(
      plan.planHash,
      approval.approvalToken,
      'redaction-key',
    );
    const stored = await operations.get(applied.operationId);
    expect(findForbiddenPaths(stored)).toEqual([]);
  });
});
