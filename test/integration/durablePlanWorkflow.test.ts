import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureAdapter } from '../../src/adapters/fixture/fixtureAdapter.js';
import type { TargetAdapter } from '../../src/adapters/targetAdapter.js';
import { FileApprovalStore } from '../../src/policy/approvalStore.js';
import { FileIdempotencyStore } from '../../src/policy/idempotencyStore.js';
import { FileOperationStore } from '../../src/policy/operationStore.js';
import { FilePlanStore } from '../../src/policy/planStore.js';
import { PolicyEngine } from '../../src/policy/policy.js';
import { OperationService } from '../../src/server/operationService.js';
import type { ActorContext, PlatformId } from '../../src/domain/types.js';
import {
  CLOUD_DEV,
  MUTATOR_ACTOR,
  OTHER_MUTATOR_ACTOR,
  REVIEWER_ACTOR,
  barChartIntent,
  buildTestPolicyConfig,
} from '../helpers/testContext.js';

const temporaryDirectories: string[] = [];

function temporaryStateDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'qlik-durable-plan-workflow-'));
  temporaryDirectories.push(directory);
  return directory;
}

function buildProcessService(
  stateDirectory: string,
  actor: ActorContext,
  planTtlMs?: number,
): OperationService {
  const fixture = new FixtureAdapter();
  const adapters: Readonly<Partial<Record<PlatformId, TargetAdapter>>> = {
    fixture,
    cloud: fixture,
    windows: fixture,
  };
  return new OperationService({
    actor,
    adapters,
    policy: new PolicyEngine(buildTestPolicyConfig()),
    plans: new FilePlanStore(path.join(stateDirectory, 'plans.json')),
    approvals: new FileApprovalStore(path.join(stateDirectory, 'approvals.json')),
    idempotency: new FileIdempotencyStore(path.join(stateDirectory, 'idempotency.json')),
    operations: new FileOperationStore(path.join(stateDirectory, 'operations.json')),
    ...(planTtlMs !== undefined ? { planTtlMs } : {}),
    sleep: async () => undefined,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable visualization plan workflow', () => {
  it('isolates identical canonical plans and operation history across durable actor owners', async () => {
    const stateDirectory = temporaryStateDirectory();
    const first = buildProcessService(stateDirectory, MUTATOR_ACTOR);
    const second = buildProcessService(stateDirectory, OTHER_MUTATOR_ACTOR);

    const planA = await first.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    const planB = await second.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    expect(planB.planHash).toBe(planA.planHash);
    expect(planB.operationId).not.toBe(planA.operationId);

    await expect(first.previewVisualization(planA.planHash)).resolves.toMatchObject({
      operationId: planA.operationId,
    });
    await expect(second.previewVisualization(planB.planHash)).resolves.toMatchObject({
      operationId: planB.operationId,
    });
    await expect(first.getOperation(planA.operationId)).resolves.toMatchObject({
      requestingPrincipal: MUTATOR_ACTOR.actor,
      typedOutcome: { status: 'previewed' },
    });
    await expect(second.getOperation(planB.operationId)).resolves.toMatchObject({
      requestingPrincipal: OTHER_MUTATOR_ACTOR.actor,
      typedOutcome: { status: 'previewed' },
    });
    await expect(first.getOperation(planB.operationId)).rejects.toMatchObject({
      code: 'OPERATION_ACCESS_DENIED',
    });
    await expect(second.getOperation(planA.operationId)).rejects.toMatchObject({
      code: 'OPERATION_ACCESS_DENIED',
    });
  });

  it('survives requester restarts through preview, approval request, and apply', async () => {
    const stateDirectory = temporaryStateDirectory();
    const planner = buildProcessService(stateDirectory, MUTATOR_ACTOR);
    const plan = await planner.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );

    const restartedRequester = buildProcessService(stateDirectory, MUTATOR_ACTOR);
    await expect(restartedRequester.previewVisualization(plan.planHash)).resolves.toMatchObject({
      status: 'previewed',
      planHash: plan.planHash,
    });
    const request = await restartedRequester.requestApproval(plan.planHash);

    const independentReviewer = buildProcessService(stateDirectory, REVIEWER_ACTOR);
    await expect(independentReviewer.previewVisualization(plan.planHash)).rejects.toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });
    const approval = await independentReviewer.approveApproval(request.requestId);

    const restartedApplyProcess = buildProcessService(stateDirectory, MUTATOR_ACTOR);
    const applied = await restartedApplyProcess.applyVisualization(
      plan.planHash,
      approval.approvalToken,
      'durable-plan-restart-key',
    );
    expect(applied).toMatchObject({ status: 'verified', verified: true });
    expect(await restartedApplyProcess.getOperation(applied.operationId)).toMatchObject({
      planHash: plan.planHash,
      typedOutcome: { status: 'verified' },
    });
  });

  it('still rejects an expired plan after a process restart', async () => {
    const stateDirectory = temporaryStateDirectory();
    const planner = buildProcessService(stateDirectory, MUTATOR_ACTOR, 0);
    const plan = await planner.planVisualization(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      CLOUD_DEV.writableSheetId,
      barChartIntent(),
    );
    await new Promise((resolve) => setTimeout(resolve, 2));

    await expect(
      buildProcessService(stateDirectory, MUTATOR_ACTOR).previewVisualization(plan.planHash),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' });
  });
});
