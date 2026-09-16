import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  OperationEvent,
  OperationEventSink,
} from '../../../src/observability/operationEvents.js';
import { FileApprovalStore } from '../../../src/policy/approvalStore.js';
import { FileIdempotencyStore } from '../../../src/policy/idempotencyStore.js';
import { FileOperationStore } from '../../../src/policy/operationStore.js';
import {
  barChartIntent,
  buildReviewerService,
  buildTestService,
  CLOUD_DEV,
  MUTATOR_ACTOR,
  REVIEWER_ACTOR,
} from '../../helpers/testContext.js';

const temporaryDirectories: string[] = [];

function temporaryStateDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'qlik-governance-state-'));
  temporaryDirectories.push(directory);
  return directory;
}

function eventCollector(): {
  readonly events: OperationEvent[];
  readonly sink: OperationEventSink;
} {
  const events: OperationEvent[] = [];
  return { events, sink: { emit: (event) => void events.push(event) } };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable reviewer separation', () => {
  it('lets an independent reviewer process decide from durable context and binds apply to the requester', async () => {
    const directory = temporaryStateDirectory();
    const approvalPath = path.join(directory, 'approvals.json');
    const idempotencyPath = path.join(directory, 'idempotency.json');
    const operationPath = path.join(directory, 'operations.json');
    const requester = buildTestService({
      approvals: new FileApprovalStore(approvalPath),
      idempotency: new FileIdempotencyStore(idempotencyPath),
      operations: new FileOperationStore(operationPath),
    });
    const plan = await requester.service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    const request = await requester.service.requestApproval(plan.planHash);

    // These independently constructed stores model a separate process. The
    // reviewer has no in-memory plan and can decide only from persisted state.
    const reviewer = buildTestService({
      actor: REVIEWER_ACTOR,
      reviewerActors: new Set([REVIEWER_ACTOR.actor]),
      approvals: new FileApprovalStore(approvalPath),
      idempotency: new FileIdempotencyStore(idempotencyPath),
      operations: new FileOperationStore(operationPath),
    });
    await expect(reviewer.service.getApprovalRequest(request.requestId)).resolves.toMatchObject({
      chartType: 'bar',
      title: 'Sales by region',
      resolvedSummary: {
        dimensions: ['Region'],
        measures: ['Revenue'],
        filters: [],
      },
      warnings: [],
      diff: { additions: expect.arrayContaining(['dimension: Region']) },
    });
    const approval = await reviewer.service.approveApproval(request.requestId);
    expect(approval.actor).toBe(MUTATOR_ACTOR.actor);
    expect(approval.resolvedSummary).toEqual({
      dimensions: ['Region'],
      measures: ['Revenue'],
    });
    expect(new FileApprovalStore(approvalPath).get(approval.approvalToken)).toMatchObject({
      actor: MUTATOR_ACTOR.actor,
      reviewedBy: REVIEWER_ACTOR.actor,
    });

    // A participant sees the current operation state even when the latest
    // event was emitted by the other independently authenticated actor.
    await expect(requester.service.getOperation(plan.operationId)).resolves.toMatchObject({
      requestingPrincipal: REVIEWER_ACTOR.actor,
      typedOutcome: { status: 'approved' },
    });
    const applied = await requester.service.applyVisualization(
      plan.planHash,
      approval.approvalToken,
      'durable-cross-process-key',
    );
    expect(applied.status).toBe('verified');

    const history = await new FileOperationStore(operationPath).history(plan.operationId);
    expect(history.map((record) => record.policyResult)).toEqual(
      expect.arrayContaining([
        'pending-authorized-decision',
        'approved-by-independent-reviewer',
        'allowed-designated-development-sheet',
      ]),
    );
  });

  it('prohibits self-approval even when the requester is also reviewer-allowlisted', async () => {
    const telemetry = eventCollector();
    const handle = buildTestService({
      reviewerActors: new Set([MUTATOR_ACTOR.actor]),
      operationEvents: telemetry.sink,
    });
    const plan = await handle.service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    const request = await handle.service.requestApproval(plan.planHash);

    await expect(handle.service.approveApproval(request.requestId)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(handle.approvals.getRequest(request.requestId)?.status).toBe('pending');
    const deniedAudit = (await handle.operations.history()).find(
      (record) => record.policyResult === 'approval-decision-denied',
    );
    expect(deniedAudit).toMatchObject({
      policyResult: 'approval-decision-denied',
      typedOutcome: { status: 'failed', code: 'PERMISSION_DENIED' },
    });
    expect(deniedAudit?.operationId).not.toBe(plan.operationId);
    expect(telemetry.events.at(-1)).toMatchObject({
      severityText: 'ERROR',
      attributes: { 'qlik.policy.result': 'approval-decision-denied' },
    });
  });
});

describe('governance audit and telemetry coverage', () => {
  it('propagates the authenticated transport correlation into operation audit', async () => {
    const handle = buildTestService({ correlationId: () => 'http-correlation-123' });
    await handle.service.listApps(CLOUD_DEV.connection);
    expect((await handle.operations.history())[0]).toMatchObject({
      correlationId: 'http-correlation-123',
      traceReference: 'correlation:http-correlation-123',
    });
  });

  it('audits planning and preview preflight failures', async () => {
    const telemetry = eventCollector();
    const handle = buildTestService({ operationEvents: telemetry.sink });
    await expect(
      handle.service.planVisualization(
        CLOUD_DEV.connection,
        CLOUD_DEV.appId,
        CLOUD_DEV.writableSheetId,
        barChartIntent({ dimensions: ['NotInCatalog'] }),
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_FIELD' });
    await expect(handle.service.previewVisualization('sha256:missing-plan')).rejects.toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });

    expect((await handle.operations.history()).map((record) => record.policyResult)).toEqual([
      'planning-failed',
      'preview-preflight-failed',
    ]);
    expect(telemetry.events).toHaveLength(2);
  });

  it('records discovery success, adapter failure, and unresolved-target denial', async () => {
    const telemetry = eventCollector();
    const handle = buildTestService({ operationEvents: telemetry.sink });

    await handle.service.listApps(CLOUD_DEV.connection);
    await expect(
      handle.service.getAppCatalog(CLOUD_DEV.connection, CLOUD_DEV.appId, 'empty'),
    ).rejects.toMatchObject({ code: 'EMPTY_CATALOG' });
    await expect(handle.service.listApps('not-configured')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const history = await handle.operations.history();
    expect(history.map((record) => record.policyResult)).toEqual([
      'allowed-read-discovery',
      'read-discovery-failed',
      'read-discovery-failed',
    ]);
    expect(telemetry.events.map((event) => event.attributes['qlik.operation.status'])).toEqual([
      'discovered',
      'failed',
      'failed',
    ]);
  });

  it('redacts secret-shaped rejected connection aliases before telemetry emission', async () => {
    const telemetry = eventCollector();
    const handle = buildTestService({ operationEvents: telemetry.sink });
    const secretShapedAlias = 'Bearer this-must-never-reach-telemetry';

    await expect(handle.service.listApps(secretShapedAlias)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    expect((await handle.operations.history()).at(-1)?.connectionAlias).toBe('[redacted]');
    expect(telemetry.events.at(-1)?.attributes['qlik.connection.alias']).toBe('[redacted]');
    expect(JSON.stringify(telemetry.events)).not.toContain(secretShapedAlias);
  });

  it('records rejection and apply preflight denial with matching telemetry', async () => {
    const telemetry = eventCollector();
    const requester = buildTestService({ operationEvents: telemetry.sink });
    const reviewer = buildReviewerService(requester, REVIEWER_ACTOR, {
      operationEvents: telemetry.sink,
    });
    const rejectedPlan = await requester.service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    const request = await requester.service.requestApproval(rejectedPlan.planHash);
    await reviewer.service.rejectApproval(request.requestId, 'independent review rejected');

    const deniedPlan = await requester.service.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent({ measures: ['Margin'] }),
    );
    await expect(
      requester.service.applyVisualization(
        deniedPlan.planHash,
        'approval-token-never-issued',
        'denied-apply-key',
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });

    expect((await requester.operations.history(rejectedPlan.operationId)).at(-1)).toMatchObject({
      requestingPrincipal: REVIEWER_ACTOR.actor,
      policyResult: 'rejected-by-independent-reviewer',
      approvalState: 'rejected',
      typedOutcome: { status: 'failed', code: 'APPROVAL_REJECTED' },
    });
    expect((await requester.operations.history(deniedPlan.operationId)).at(-1)).toMatchObject({
      policyResult: 'apply-preflight-denied',
      typedOutcome: { status: 'failed', code: 'APPROVAL_NOT_FOUND' },
    });
    expect(telemetry.events.map((event) => event.attributes['qlik.policy.result'])).toEqual(
      expect.arrayContaining(['rejected-by-independent-reviewer', 'apply-preflight-denied']),
    );
  });

  it('records missing approval and rejection requests without persisting attacker identifiers', async () => {
    const telemetry = eventCollector();
    const handle = buildTestService({ operationEvents: telemetry.sink });

    await expect(
      handle.service.approveApproval('Bearer attacker-controlled'),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUEST_NOT_FOUND' });
    await expect(handle.service.rejectApproval('Bearer attacker-controlled')).rejects.toMatchObject(
      { code: 'APPROVAL_REQUEST_NOT_FOUND' },
    );

    const history = await handle.operations.history();
    expect(history.map((record) => record.policyResult)).toEqual([
      'approval-decision-denied',
      'rejection-decision-denied',
    ]);
    expect(JSON.stringify(history)).not.toContain('attacker-controlled');
    expect(telemetry.events).toHaveLength(2);
  });
});
