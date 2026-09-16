import { FixtureAdapter } from '../../src/adapters/fixture/fixtureAdapter.js';
import { ApprovalStore } from '../../src/policy/approvalStore.js';
import { IdempotencyStore } from '../../src/policy/idempotencyStore.js';
import { InMemoryOperationStore } from '../../src/policy/operationStore.js';
import type { OperationStore } from '../../src/policy/operationStore.js';
import { PlanStore, type PlanRepository } from '../../src/policy/planStore.js';
import { PolicyEngine } from '../../src/policy/policy.js';
import { OperationService } from '../../src/server/operationService.js';
import type { ScheduledFault } from '../../src/adapters/fixture/fixtureAdapter.js';
import type { TargetAdapter } from '../../src/adapters/targetAdapter.js';
import type { ActorContext, PlatformId } from '../../src/domain/types.js';
import type { ConnectionAllowlistEntry, PolicyConfig } from '../../src/config/policyConfig.js';
import type { OperationEventSink } from '../../src/observability/operationEvents.js';

/** Test-only actor/policy fixtures. Never used by production code paths. */
export const MUTATOR_ACTOR: ActorContext = { actor: 'test-mutator', hostClientId: 'test-host' };
export const READ_ONLY_ACTOR: ActorContext = { actor: 'test-read-only', hostClientId: 'test-host' };
export const OTHER_MUTATOR_ACTOR: ActorContext = {
  actor: 'test-other-mutator',
  hostClientId: 'test-host',
};
export const REVIEWER_ACTOR: ActorContext = { actor: 'test-reviewer', hostClientId: 'review-host' };

const TEST_CONNECTIONS: Readonly<Record<string, ConnectionAllowlistEntry>> = {
  'cloud-dev': {
    alias: 'cloud-dev',
    platform: 'cloud',
    visualizationSchemaProfile: 'qlik-cloud-current',
    environment: 'development',
    allowedApps: { 'app-sales-cloud-dev': ['sheet-sales-overview-cloud-dev'] },
    allowedChartTypes: [
      'bar',
      'line',
      'scatter',
      'table',
      'kpi',
      'gauge',
      'treemap',
      'pie',
      'combo',
    ],
  },
  'windows-dev': {
    alias: 'windows-dev',
    platform: 'windows',
    visualizationSchemaProfile: 'qlik-windows-pre-november-2025',
    environment: 'development',
    allowedApps: { 'app-sales-windows-dev': ['sheet-sales-overview-windows-dev'] },
    allowedChartTypes: [
      'bar',
      'line',
      'scatter',
      'table',
      'kpi',
      'gauge',
      'treemap',
      'pie',
      'combo',
    ],
  },
};

export function buildTestPolicyConfig(
  mutationActors: ReadonlySet<string> = new Set([MUTATOR_ACTOR.actor]),
  reviewerActors: ReadonlySet<string> = new Set([REVIEWER_ACTOR.actor]),
): PolicyConfig {
  return {
    allowedEnvironments: ['development', 'nonproduction'],
    connections: TEST_CONNECTIONS,
    mutationActors,
    reviewerActors,
  };
}

export interface BuildTestServiceOptions {
  readonly actor?: ActorContext;
  readonly mutationActors?: ReadonlySet<string>;
  readonly reviewerActors?: ReadonlySet<string>;
  readonly faults?: ScheduledFault[];
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly operations?: OperationStore;
  readonly plans?: PlanRepository;
  readonly approvals?: ApprovalStore;
  readonly idempotency?: IdempotencyStore;
  readonly planTtlMs?: number;
  readonly approvalTtlMs?: number;
  readonly previewTimeoutMs?: number;
  readonly maxConcurrentPreviewsPerActor?: number;
  readonly maxConcurrentPreviewsPerConnection?: number;
  readonly approvalRequestTtlMs?: number;
  readonly operationEvents?: OperationEventSink;
  readonly correlationId?: () => string | undefined;
}

export interface TestServiceHandle {
  readonly service: OperationService;
  readonly fixtureAdapter: FixtureAdapter;
  readonly operations: OperationStore;
  readonly plans: PlanRepository;
  readonly approvals: ApprovalStore;
  readonly idempotency: IdempotencyStore;
}

/** Builds a fresh OperationService backed only by the deterministic FixtureAdapter. */
export function buildTestService(options: BuildTestServiceOptions = {}): TestServiceHandle {
  const fixtureAdapter = new FixtureAdapter({ faults: options.faults });
  const adapters: Readonly<Partial<Record<PlatformId, TargetAdapter>>> = {
    fixture: fixtureAdapter,
    cloud: fixtureAdapter,
    windows: fixtureAdapter,
  };
  const policy = new PolicyEngine(
    buildTestPolicyConfig(options.mutationActors, options.reviewerActors),
  );
  const operations = options.operations ?? new InMemoryOperationStore();
  const plans = options.plans ?? new PlanStore();
  const approvals = options.approvals ?? new ApprovalStore();
  const idempotency = options.idempotency ?? new IdempotencyStore();

  const service = new OperationService({
    actor: options.actor ?? MUTATOR_ACTOR,
    adapters,
    policy,
    approvals,
    idempotency,
    plans,
    operations,
    planTtlMs: options.planTtlMs,
    approvalTtlMs: options.approvalTtlMs,
    previewTimeoutMs: options.previewTimeoutMs,
    maxConcurrentPreviewsPerActor: options.maxConcurrentPreviewsPerActor,
    maxConcurrentPreviewsPerConnection: options.maxConcurrentPreviewsPerConnection,
    approvalRequestTtlMs: options.approvalRequestTtlMs,
    sleep: options.sleep ?? (async () => undefined),
    operationEvents: options.operationEvents,
    correlationId: options.correlationId,
  });

  return { service, fixtureAdapter, operations, plans, approvals, idempotency };
}

/** Builds the distinct authenticated reviewer lane over the requester's shared stores. */
export function buildReviewerService(
  requester: Pick<TestServiceHandle, 'approvals' | 'idempotency' | 'operations' | 'plans'>,
  actor: ActorContext = REVIEWER_ACTOR,
  overrides: BuildTestServiceOptions = {},
): TestServiceHandle {
  return buildTestService({
    ...overrides,
    actor,
    mutationActors: new Set([MUTATOR_ACTOR.actor, OTHER_MUTATOR_ACTOR.actor]),
    reviewerActors: new Set([actor.actor]),
    approvals: requester.approvals,
    idempotency: requester.idempotency,
    operations: requester.operations,
    plans: requester.plans,
  });
}

export const CLOUD_DEV = {
  connection: 'cloud-dev',
  appId: 'app-sales-cloud-dev',
  writableSheetId: 'sheet-sales-overview-cloud-dev',
  readOnlySheetId: 'sheet-sales-readonly-cloud-dev',
} as const;

export const WINDOWS_DEV = {
  connection: 'windows-dev',
  appId: 'app-sales-windows-dev',
  writableSheetId: 'sheet-sales-overview-windows-dev',
  readOnlySheetId: 'sheet-sales-readonly-windows-dev',
} as const;

export function barChartIntent(
  overrides: Partial<{ dimensions: string[]; measures: string[]; title: string }> = {},
) {
  return {
    analysis: {
      dimensions: overrides.dimensions ?? ['Region'],
      measures: overrides.measures ?? ['Revenue'],
    },
    presentation: {
      preferredChartType: 'bar',
      title: overrides.title ?? 'Sales by region',
    },
    mode: 'preview' as const,
  };
}
