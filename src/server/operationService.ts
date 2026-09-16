import { SheetService, type SheetIntentInput } from './sheetService.js';
import {
  createError,
  HarnessError,
  isHarnessError,
  toSafeUnexpectedError,
} from '../domain/errors.js';
import { generateOperationId, generateCorrelationId } from '../domain/ids.js';
import { redactForAudit, redactForOutput } from '../domain/redaction.js';
import {
  compileChartIntent,
  COMPILER_VERSION,
  CHART_INTENT_VERSION,
  DEFAULT_PLAN_TTL_MS,
} from '../compiler/compiler.js';
import type { ChartIntentInput } from '../compiler/chartIntentSchema.js';
import {
  assertMutationCapability,
  assertPreviewCapability,
  assertReadCapability,
} from '../adapters/capabilityProbe.js';
import type { CatalogVariant } from '../catalog/catalogTypes.js';
import type {
  CatalogResult,
  CreateSessionChartResult,
  ListAppsResult,
  ListSheetObjectsResult,
  PageRequest,
  SheetObjectSummary,
  SheetSummary,
  TargetAdapter,
} from '../adapters/targetAdapter.js';
import type { PolicyEngine } from '../policy/policy.js';
import { ApprovalStore, type ApprovalRepository } from '../policy/approvalStore.js';
import { IdempotencyStore, type IdempotencyRepository } from '../policy/idempotencyStore.js';
import { PlanStore, type PlanRepository, type StoredPlan } from '../policy/planStore.js';
import type { OperationStore } from '../policy/operationStore.js';
import type {
  ActorContext,
  ApplySummary,
  ApprovalRecord,
  ApprovalRequestRecord,
  ApprovalRequestSummary,
  ApprovalReviewContext,
  ApprovalSummary,
  ChartPlanSummary,
  ConnectionAlias,
  OperationRecord,
  PlatformId,
  PreviewSummary,
  TypedOutcome,
  VisualizationSchemaProfileId,
} from '../domain/types.js';
import type { OperationEventSink } from '../observability/operationEvents.js';
import { operationEventFromRecord } from '../observability/operationEvents.js';

export interface OperationServiceConfig {
  readonly actor: ActorContext;
  readonly adapters: Readonly<Partial<Record<PlatformId, TargetAdapter>>>;
  readonly policy: PolicyEngine;
  readonly approvals?: ApprovalRepository;
  readonly idempotency?: IdempotencyRepository;
  readonly plans?: PlanRepository;
  readonly operations: OperationStore;
  readonly planTtlMs?: number;
  readonly approvalTtlMs?: number;
  readonly approvalRequestTtlMs?: number;
  readonly maxRetryAttempts?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxRetrySleepSeconds?: number;
  readonly previewTimeoutMs?: number;
  readonly maxConcurrentPreviewsPerActor?: number;
  readonly maxConcurrentPreviewsPerConnection?: number;
  readonly operationEvents?: OperationEventSink;
  /** Supplies the authenticated transport request correlation when available. */
  readonly correlationId?: () => string | undefined;
}

const sharedActorPreviews = new Map<string, number>();
const sharedConnectionPreviews = new Map<string, number>();
const HARD_PAGE_CAP = 200;
const DEFAULT_PREVIEW_TIMEOUT_MS = 15_000;
const PREVIEW_CLEANUP_GRACE_MS = 50;

function reviewAuditOperationId(): string {
  return generateOperationId('review');
}

function boundList<T>(
  items: readonly T[],
  pageSize: number | undefined,
): { items: readonly T[]; truncated: boolean } {
  const limit = Math.min(pageSize && pageSize > 0 ? pageSize : HARD_PAGE_CAP, HARD_PAGE_CAP);
  if (items.length <= limit) {
    return { items, truncated: false };
  }
  return { items: items.slice(0, limit), truncated: true };
}

async function defaultSleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * The provider-neutral core service. Every MCP tool handler delegates here;
 * this class never knows about JSON-RPC, zod, or the MCP SDK. It owns the
 * full discover -> plan -> preview -> approve -> apply -> verify lifecycle,
 * policy enforcement, idempotency/approval binding, and audit recording.
 */
export class OperationService {
  private readonly sheets: SheetService;
  private readonly plans: PlanRepository;
  private readonly approvals: ApprovalRepository;
  private readonly idempotency: IdempotencyRepository;
  private readonly planTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly approvalRequestTtlMs: number;
  private readonly maxRetryAttempts: number;
  private readonly maxRetrySleepSeconds: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly activeActorPreviews = sharedActorPreviews;
  private readonly activeConnectionPreviews = sharedConnectionPreviews;

  constructor(private readonly config: OperationServiceConfig) {
    this.approvals = config.approvals ?? new ApprovalStore();
    this.idempotency = config.idempotency ?? new IdempotencyStore();
    this.plans = config.plans ?? new PlanStore();
    this.planTtlMs = config.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
    this.approvalTtlMs = config.approvalTtlMs ?? 10 * 60 * 1000;
    this.approvalRequestTtlMs = config.approvalRequestTtlMs ?? 10 * 60 * 1000;
    this.maxRetryAttempts = config.maxRetryAttempts ?? 2;
    this.maxRetrySleepSeconds = config.maxRetrySleepSeconds ?? 2;
    this.sleep = config.sleep ?? defaultSleep;
    this.sheets = new SheetService({
      actor: config.actor,
      adapters: config.adapters,
      policy: config.policy,
      operations: config.operations,
      idempotency: this.idempotency,
      planTtlMs: this.planTtlMs,
      previewTimeoutMs: config.previewTimeoutMs,
      getPlan: async (hash) => this.plans.get(this.actor.actor, hash),
      savePlan: async (stored) => {
        await this.plans.save({ ...stored, ownerActor: this.actor.actor });
      },
      saveOperation: (record) => this.saveOperation(record),
      acquirePreviewSlot: (connection) => this.acquirePreviewSlot(connection),
    });
  }

  planSheet(input: SheetIntentInput) {
    return this.sheets.plan(input);
  }
  previewSheet(planHash: string, signal?: AbortSignal) {
    return this.sheets.preview(planHash, signal);
  }
  applySheet(planHash: string, idempotencyKey: string, attempt = 0, signal?: AbortSignal) {
    return this.sheets.apply(planHash, idempotencyKey, attempt, signal);
  }
  verifySheet(planHash: string) {
    return this.sheets.verify(planHash);
  }

  private get actor(): ActorContext {
    return this.config.actor;
  }

  private correlationId(): string {
    return this.config.correlationId?.() ?? generateCorrelationId();
  }

  private acquirePreviewSlot(connection: ConnectionAlias): () => void {
    const actorCount = this.activeActorPreviews.get(this.actor.actor) ?? 0;
    const connectionCount = this.activeConnectionPreviews.get(connection) ?? 0;
    const actorLimit = this.config.maxConcurrentPreviewsPerActor ?? 2;
    const connectionLimit = this.config.maxConcurrentPreviewsPerConnection ?? 4;
    if (actorCount >= actorLimit || connectionCount >= connectionLimit) {
      throw createError('CAPACITY_EXHAUSTED', {
        details: { scope: actorCount >= actorLimit ? 'actor' : 'connection' },
      });
    }
    this.activeActorPreviews.set(this.actor.actor, actorCount + 1);
    this.activeConnectionPreviews.set(connection, connectionCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.decrementPreviewCount(this.activeActorPreviews, this.actor.actor);
      this.decrementPreviewCount(this.activeConnectionPreviews, connection);
    };
  }

  private decrementPreviewCount(counts: Map<string, number>, key: string): void {
    const next = (counts.get(key) ?? 1) - 1;
    if (next === 0) counts.delete(key);
    else counts.set(key, next);
  }

  private getAdapter(platform: PlatformId): TargetAdapter {
    const adapter = this.config.adapters[platform];
    if (!adapter) {
      throw createError('NOT_CONFIGURED', {
        message: `No adapter is registered for platform "${platform}".`,
      });
    }
    return adapter;
  }

  private resolveAdapterForConnection(connection: ConnectionAlias): {
    adapter: TargetAdapter;
    platform: PlatformId;
    visualizationSchemaProfile?: VisualizationSchemaProfileId;
    visualizationSchemaVersion?: string;
  } {
    const entry = this.config.policy.assertConnectionAllowed(connection);
    return {
      adapter: this.getAdapter(entry.platform),
      platform: entry.platform,
      ...(entry.visualizationSchemaProfile
        ? { visualizationSchemaProfile: entry.visualizationSchemaProfile }
        : {}),
      ...(entry.visualizationSchemaVersion
        ? { visualizationSchemaVersion: entry.visualizationSchemaVersion }
        : {}),
    };
  }

  /**
   * Returns a bounded, non-secret readiness view of the service and every
   * allowlisted connection. Capability probes must themselves be side-effect
   * free; their human-readable reasons are passed through the standard output
   * redactor before crossing the MCP boundary.
   */
  async getReadiness(): Promise<{
    status: 'ready' | 'degraded';
    service: { ready: true; adapterCount: number };
    adapters: Array<{
      connection: string;
      platform: PlatformId;
      configured: boolean;
      canRead: boolean;
      canPreview: boolean;
      canWriteDesignatedSheet: boolean;
      cleanupVerified: boolean;
      reason: string;
    }>;
  }> {
    const connections = [...this.config.policy.listConnections()].sort((a, b) =>
      a.alias.localeCompare(b.alias),
    );
    const adapters = await Promise.all(
      connections.map(async (entry) => {
        const adapter = this.getAdapter(entry.platform);
        const result = await adapter.getEnvironmentCapabilities(entry.alias);
        const safe = redactForOutput(result) as typeof result;
        return {
          connection: safe.connection,
          platform: safe.platform,
          configured: safe.configured,
          canRead: safe.canRead,
          canPreview: safe.canPreview,
          canWriteDesignatedSheet: safe.canWriteDesignatedSheet,
          cleanupVerified: safe.cleanupVerified,
          reason: safe.reason,
        };
      }),
    );
    return {
      status: adapters.every((adapter) => adapter.configured && adapter.canRead)
        ? 'ready'
        : 'degraded',
      service: { ready: true, adapterCount: adapters.length },
      adapters,
    };
  }

  private async withBoundedRetry<T>(
    fn: () => Promise<T>,
  ): Promise<{ value: T; retryCount: number }> {
    let attempt = 0;
    for (;;) {
      try {
        const value = await fn();
        return { value, retryCount: attempt };
      } catch (error) {
        if (isHarnessError(error) && error.retryable && attempt < this.maxRetryAttempts) {
          attempt += 1;
          const delaySeconds = Math.min(error.retryAfterSeconds ?? 1, this.maxRetrySleepSeconds);
          await this.sleep(delaySeconds * 1000);
          continue;
        }
        throw error;
      }
    }
  }

  private buildOperationRecord(params: {
    operationId: string;
    correlationId: string;
    connectionAlias: ConnectionAlias;
    platform: PlatformId;
    appId: string;
    sheetId?: string;
    planHash?: string;
    policyResult: string;
    approvalState: string;
    typedOutcome: TypedOutcome;
    retryCount?: number;
    durationMilliseconds: number;
    cleanupAttempted?: boolean;
    cleanupOutcome?: string;
    createdObjectId?: string | null;
    sheetAttachmentId?: string | null;
  }): OperationRecord {
    return {
      recordVersion: '1.0.0',
      recordType: 'sanitized-operation-audit',
      operationId: params.operationId,
      timestamp: new Date().toISOString(),
      correlationId: params.correlationId,
      requestingPrincipal: this.actor.actor,
      hostClientId: this.actor.hostClientId,
      connectionAlias: params.connectionAlias,
      platform: params.platform,
      target: { appId: params.appId, sheetId: params.sheetId },
      effectiveQlikIdentityClass: `${params.platform}-development-workload`,
      intentVersion: CHART_INTENT_VERSION,
      compilerVersion: COMPILER_VERSION,
      planHash: params.planHash,
      policyResult: params.policyResult,
      approvalState: params.approvalState,
      typedOutcome: params.typedOutcome,
      retryCount: params.retryCount ?? 0,
      durationMilliseconds: params.durationMilliseconds,
      cleanupAttempted: params.cleanupAttempted ?? false,
      cleanupOutcome: params.cleanupOutcome ?? 'not-required',
      createdObjectId: params.createdObjectId ?? null,
      sheetAttachmentId: params.sheetAttachmentId ?? null,
      traceReference: `correlation:${params.correlationId}`,
      redaction: {
        rawPayloadsRemoved: true,
        sensitiveValuesRemoved: true,
        credentialMaterialPresent: false,
      },
    };
  }

  private async saveOperation(record: OperationRecord): Promise<void> {
    const safe = redactForAudit(record);
    await this.config.operations.save(safe);
    await this.config.operationEvents?.emit(operationEventFromRecord(safe));
  }

  /**
   * Recovery must not stop because the idempotency store is unavailable. The
   * returned state is deliberately bounded and safe to include in audit/error
   * evidence; the underlying store error is never exposed.
   */
  private async markIdempotencyFailed(idempotencyKey: string): Promise<'failed' | 'unconfirmed'> {
    try {
      await this.idempotency.fail(idempotencyKey);
      return 'failed';
    } catch {
      return 'unconfirmed';
    }
  }

  /** Attempts the already-sanitized recovery audit without replacing the primary failure. */
  private async saveRecoveryOperation(record: OperationRecord): Promise<boolean> {
    try {
      await this.saveOperation(record);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Preserve a typed primary failure and add only bounded recovery evidence.
   * Unknown exceptions become a generic internal error rather than exposing a
   * database, telemetry, or adapter message through the MCP boundary.
   */
  private safeApplyFailure(error: unknown): HarnessError {
    return isHarnessError(error)
      ? error
      : new HarnessError({
          code: 'INTERNAL_ERROR',
          category: 'internal',
          retryable: false,
          stage: 'operation',
          message: 'An unexpected internal error occurred.',
        });
  }

  private applyFailureWithRecoveryEvidence(
    error: unknown,
    evidence: {
      readonly idempotencyState: 'not-started' | 'failed' | 'unconfirmed';
      readonly auditRecorded: boolean;
    },
  ): HarnessError {
    const primary = this.safeApplyFailure(error);
    return new HarnessError({
      ...primary.toEnvelope(),
      details: {
        ...primary.details,
        idempotencyState: evidence.idempotencyState,
        auditRecorded: evidence.auditRecorded,
      },
    });
  }

  private async saveFailedOperation(
    params: Omit<Parameters<OperationService['buildOperationRecord']>[0], 'typedOutcome'>,
    error: unknown,
  ): Promise<HarnessError> {
    const safe = toSafeUnexpectedError(error);
    await this.saveOperation(
      this.buildOperationRecord({
        ...params,
        typedOutcome: {
          status: 'failed',
          code: safe.code,
          category: safe.category,
          retryable: safe.retryable,
          ...(safe.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: safe.retryAfterSeconds }
            : {}),
        },
      }),
    );
    return safe;
  }

  /**
   * Records a denied call even when caller-supplied identifiers cannot be
   * resolved to a configured target. Deliberately omits those identifiers
   * from target/plan fields so an invalid value cannot become audit content.
   */
  private async saveUnresolvedFailedOperation(
    policyResult: string,
    approvalState: string,
    started: number,
    error: unknown,
  ): Promise<HarnessError> {
    return this.saveFailedOperation(
      {
        operationId: generateOperationId('denied'),
        correlationId: this.correlationId(),
        connectionAlias: 'unresolved',
        platform: 'fixture',
        appId: 'unresolved',
        policyResult,
        approvalState,
        durationMilliseconds: Date.now() - started,
      },
      error,
    );
  }

  // ---------------------------------------------------------------------
  // Discovery (read-only)
  // ---------------------------------------------------------------------

  /** Non-secret connection allowlist, safe for a read-only MCP resource. */
  listConnections() {
    return this.config.policy.listConnections();
  }

  async listApps(connection: ConnectionAlias, page?: PageRequest): Promise<ListAppsResult> {
    const started = Date.now();
    const operationId = generateOperationId('discovery');
    const correlationId = this.correlationId();
    let platform: PlatformId = 'fixture';
    try {
      const readEntry = this.config.policy.assertReadAllowed(this.actor.actor, connection);
      platform = readEntry.platform;
      const adapter = this.getAdapter(platform);
      await assertReadCapability(adapter, connection);
      const { value: result, retryCount } = await this.withBoundedRetry(() =>
        adapter.listAccessibleApps(connection, this.actor, page),
      );
      const bounded = boundList(
        readEntry.environment === 'production'
          ? result.apps.filter((app) => readEntry.sheetGeneration!.appIds.includes(app.appId))
          : result.apps,
        page?.pageSize,
      );
      await this.saveOperation(
        this.buildOperationRecord({
          operationId,
          correlationId,
          connectionAlias: connection,
          platform,
          appId: 'app-collection',
          policyResult: 'allowed-read-discovery',
          approvalState: 'not-required-for-discovery',
          typedOutcome: { status: 'discovered' },
          retryCount,
          durationMilliseconds: Date.now() - started,
        }),
      );
      return {
        apps: bounded.items,
        truncated: bounded.truncated || result.truncated,
        ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
      };
    } catch (error) {
      throw await this.saveFailedOperation(
        {
          operationId,
          correlationId,
          connectionAlias: connection,
          platform,
          appId: 'app-collection',
          policyResult: 'read-discovery-failed',
          approvalState: 'not-required-for-discovery',
          durationMilliseconds: Date.now() - started,
        },
        error,
      );
    }
  }

  async getAppCatalog(
    connection: ConnectionAlias,
    appId: string,
    variant: CatalogVariant = 'default',
    page?: PageRequest,
  ): Promise<CatalogResult> {
    const started = Date.now();
    const operationId = generateOperationId('discovery');
    const correlationId = this.correlationId();
    let platform: PlatformId = 'fixture';
    try {
      const readEntry = this.config.policy.assertReadAllowed(this.actor.actor, connection, appId);
      platform = readEntry.platform;
      const adapter = this.getAdapter(platform);
      await assertReadCapability(adapter, connection);
      const { value: result, retryCount } = await this.withBoundedRetry(() =>
        adapter.getSemanticCatalog(connection, appId, this.actor, variant, page),
      );
      const dimensions = boundList(result.dimensions, page?.pageSize);
      const measures = boundList(result.measures, page?.pageSize);
      await this.saveOperation(
        this.buildOperationRecord({
          operationId,
          correlationId,
          connectionAlias: connection,
          platform,
          appId,
          policyResult: 'allowed-read-discovery',
          approvalState: 'not-required-for-discovery',
          typedOutcome: { status: 'discovered' },
          retryCount,
          durationMilliseconds: Date.now() - started,
        }),
      );
      return {
        ...result,
        dimensions: dimensions.items,
        measures: measures.items,
        truncated: result.truncated || dimensions.truncated || measures.truncated,
      };
    } catch (error) {
      throw await this.saveFailedOperation(
        {
          operationId,
          correlationId,
          connectionAlias: connection,
          platform,
          appId,
          policyResult: 'read-discovery-failed',
          approvalState: 'not-required-for-discovery',
          durationMilliseconds: Date.now() - started,
        },
        error,
      );
    }
  }

  async listSheetObjects(
    connection: ConnectionAlias,
    appId: string,
    sheetId: string,
    page?: PageRequest,
  ): Promise<ListSheetObjectsResult> {
    const started = Date.now();
    const operationId = generateOperationId('discovery');
    const correlationId = this.correlationId();
    let platform: PlatformId = 'fixture';
    try {
      const readEntry = this.config.policy.assertReadAllowed(this.actor.actor, connection, appId);
      platform = readEntry.platform;
      const adapter = this.getAdapter(platform);
      await assertReadCapability(adapter, connection);
      const { value: result, retryCount } = await this.withBoundedRetry(() =>
        adapter.listSheetObjects(connection, appId, sheetId, this.actor, page),
      );
      const bounded = boundList(result.objects, page?.pageSize);
      await this.saveOperation(
        this.buildOperationRecord({
          operationId,
          correlationId,
          connectionAlias: connection,
          platform,
          appId,
          sheetId,
          policyResult: 'allowed-read-discovery',
          approvalState: 'not-required-for-discovery',
          typedOutcome: { status: 'discovered' },
          retryCount,
          durationMilliseconds: Date.now() - started,
        }),
      );
      return {
        objects: bounded.items as SheetObjectSummary[],
        truncated: bounded.truncated || result.truncated,
        ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
      };
    } catch (error) {
      throw await this.saveFailedOperation(
        {
          operationId,
          correlationId,
          connectionAlias: connection,
          platform,
          appId,
          sheetId,
          policyResult: 'read-discovery-failed',
          approvalState: 'not-required-for-discovery',
          durationMilliseconds: Date.now() - started,
        },
        error,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------

  async planVisualization(
    connection: ConnectionAlias,
    appId: string,
    sheetId: string | undefined,
    intent: ChartIntentInput,
  ): Promise<ChartPlanSummary> {
    const started = Date.now();
    const operationId = generateOperationId();
    const correlationId = this.correlationId();
    let platform: PlatformId = 'fixture';
    try {
      const resolved = this.resolveAdapterForConnection(connection);
      platform = resolved.platform;
      if (!resolved.visualizationSchemaProfile) {
        throw createError('INVALID_CHART_CONFIGURATION', {
          message: `Connection "${connection}" has no visualization schema profile.`,
        });
      }
      await assertReadCapability(resolved.adapter, connection);
      const { catalog, sheets } = await resolved.adapter.getCompilationContext(
        connection,
        appId,
        this.actor,
        'default',
      );
      const resolvedSheetId = this.resolveSheetId(sheets, sheetId);
      const plan = compileChartIntent({
        catalog,
        target: { connection, appId, sheetId: resolvedSheetId },
        platform,
        visualizationSchemaProfile: resolved.visualizationSchemaProfile,
        ...(resolved.visualizationSchemaVersion
          ? { visualizationSchemaVersion: resolved.visualizationSchemaVersion }
          : {}),
        intent,
        planTtlMs: this.planTtlMs,
      });

      await this.saveOperation(
        this.buildOperationRecord({
          operationId,
          correlationId,
          connectionAlias: connection,
          platform,
          appId,
          sheetId: resolvedSheetId,
          planHash: plan.planHash,
          policyResult: 'planned-pending-preview-or-approval',
          approvalState: 'not-required-for-planning',
          typedOutcome: { status: 'planned' },
          durationMilliseconds: Date.now() - started,
        }),
      );
      await this.plans.save({
        ownerActor: this.actor.actor,
        plan,
        operationId,
        correlationId,
        presentationTarget: intent.presentation.target ?? null,
      });

      return redactForOutput({
        operationId,
        planHash: plan.planHash,
        compilerVersion: plan.compilerVersion,
        target: plan.target,
        platform: plan.platform,
        chartType: plan.chartType,
        nativeChartType: plan.nativeChartType,
        resolved: plan.resolved,
        title: plan.title,
        riskClass: plan.riskClass,
        warnings: plan.warnings,
        diff: plan.diff,
        previewEligible: true,
        createdAt: plan.createdAt,
        expiresAt: plan.expiresAt,
      });
    } catch (error) {
      throw await this.saveFailedOperation(
        {
          operationId,
          correlationId,
          connectionAlias: connection,
          platform,
          appId,
          ...(sheetId ? { sheetId } : {}),
          policyResult: 'planning-failed',
          approvalState: 'not-required-for-planning',
          durationMilliseconds: Date.now() - started,
        },
        error,
      );
    }
  }

  private resolveSheetId(sheets: readonly SheetSummary[], requested: string | undefined): string {
    if (requested) {
      const match = sheets.find((sheet) => sheet.sheetId === requested);
      if (!match) {
        throw createError('NOT_FOUND', {
          message: `Sheet "${requested}" was not found.`,
          details: { sheetId: requested },
        });
      }
      return match.sheetId;
    }
    const writable = sheets.filter((sheet) => sheet.writeAllowed);
    if (writable.length === 1) {
      return writable[0]!.sheetId;
    }
    if (sheets.length === 1) {
      return sheets[0]!.sheetId;
    }
    throw createError('MALFORMED_REQUEST', {
      message: 'sheetId is required when an app has more than one candidate sheet.',
    });
  }

  private async getFreshPlan(planHash: string): Promise<StoredPlan> {
    const stored = await this.plans.get(this.actor.actor, planHash);
    if (!stored) {
      throw createError('PLAN_NOT_FOUND', { details: { planHash } });
    }
    if (Date.now() > Date.parse(stored.plan.expiresAt)) {
      throw createError('PLAN_STALE', { details: { planHash } });
    }
    return stored;
  }

  // ---------------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------------

  async previewVisualization(planHash: string, signal?: AbortSignal): Promise<PreviewSummary> {
    const started = Date.now();
    let stored: StoredPlan;
    try {
      stored = await this.getFreshPlan(planHash);
    } catch (error) {
      throw await this.saveUnresolvedFailedOperation(
        'preview-preflight-failed',
        'not-required-for-preview',
        started,
        error,
      );
    }
    const { plan, operationId, correlationId } = stored;
    const target = plan.target as Required<typeof plan.target>;
    let adapter: TargetAdapter;
    let release: () => void;
    try {
      ({ adapter } = this.resolveAdapterForConnection(target.connection));
      await assertPreviewCapability(adapter, target.connection);
      release = this.acquirePreviewSlot(target.connection);
    } catch (error) {
      throw await this.saveFailedOperation(
        {
          operationId,
          correlationId,
          connectionAlias: target.connection,
          platform: plan.platform,
          appId: target.appId,
          sheetId: target.sheetId,
          planHash,
          policyResult: 'preview-preflight-failed',
          approvalState: 'not-required-for-preview',
          durationMilliseconds: Date.now() - started,
        },
        error,
      );
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.previewTimeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();

    let retryCount = 0;
    let sessionObjectId: string | undefined;
    let creation: Promise<{ value: CreateSessionChartResult; retryCount: number }> | undefined;
    let preview: PreviewSummary | undefined;
    let failure: HarnessError | undefined;
    let cleanupOutcome = 'not-required';
    let finalized = false;
    try {
      if (controller.signal.aborted) throw createError('OPERATION_CANCELLED');
      creation = this.withBoundedRetry(() =>
        adapter.createSessionChart({ target, plan, actor: this.actor, signal: controller.signal }),
      );
      // A non-conforming transport may settle after abort. It must not be able to
      // leak the session it allocated merely because the bounded caller moved on.
      void creation
        .then(async ({ value }) => {
          if (finalized && value.sessionObjectId !== sessionObjectId) {
            await adapter.disposeSessionChart(target.connection, value.sessionObjectId);
          }
        })
        .catch(() => undefined);
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(createError(timedOut ? 'PREVIEW_TIMEOUT' : 'OPERATION_CANCELLED')),
          { once: true },
        );
      });
      const { value: sessionResult, retryCount: attempts } = await Promise.race([
        creation,
        aborted,
      ]);
      retryCount = attempts;
      sessionObjectId = sessionResult.sessionObjectId;

      const rows = sessionResult.layout.qHyperCube.qDataPages[0]?.qMatrix ?? [];
      if (controller.signal.aborted) {
        throw createError(timedOut ? 'PREVIEW_TIMEOUT' : 'OPERATION_CANCELLED');
      }
      preview = {
        operationId,
        planHash,
        status: 'previewed',
        preview: {
          dimensionLabels: plan.resolved.dimensions.map((dimension) => dimension.label),
          measureLabels: plan.resolved.measures.map((measure) => measure.label),
          rows: rows.map((row) =>
            row.map((cell) => (typeof cell.qNum === 'number' ? cell.qNum : cell.qText)),
          ),
          returnedRows: sessionResult.layout.bounded.returnedRows,
          maxRows: sessionResult.layout.bounded.maxRows,
          truncated: sessionResult.layout.bounded.truncated,
          ...(sessionResult.layout.bounded.continuation
            ? { continuation: sessionResult.layout.bounded.continuation }
            : {}),
        },
        render: adapter.renderDescriptor(target, sessionObjectId, operationId, 'preview'),
        warnings: plan.warnings,
      };
    } catch (error) {
      failure = controller.signal.aborted
        ? createError(timedOut ? 'PREVIEW_TIMEOUT' : 'OPERATION_CANCELLED')
        : toSafeUnexpectedError(error);
      if (controller.signal.aborted && !sessionObjectId && creation) {
        const allocated = await Promise.race([
          creation.then(({ value }) => value).catch(() => undefined),
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), PREVIEW_CLEANUP_GRACE_MS),
          ),
        ]);
        sessionObjectId = allocated?.sessionObjectId;
      }
    } finally {
      finalized = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      if (sessionObjectId) {
        cleanupOutcome = 'session-disposed';
        try {
          await adapter.disposeSessionChart(target.connection, sessionObjectId);
        } catch {
          cleanupOutcome = 'session-disposal-failed';
        }
      }
      release();
      const typedOutcome: TypedOutcome = failure
        ? {
            status: 'failed',
            code: failure.code,
            category: failure.category,
            retryable: failure.retryable,
            ...(failure.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: failure.retryAfterSeconds }
              : {}),
          }
        : { status: 'previewed' };
      await this.saveOperation(
        this.buildOperationRecord({
          operationId,
          correlationId,
          connectionAlias: target.connection,
          platform: plan.platform,
          appId: target.appId,
          sheetId: target.sheetId,
          planHash,
          policyResult: 'allowed-preview',
          approvalState: 'not-required-for-preview',
          typedOutcome,
          retryCount,
          durationMilliseconds: Date.now() - started,
          cleanupAttempted: Boolean(sessionObjectId),
          cleanupOutcome,
        }),
      );
    }
    if (failure) throw failure;
    return redactForOutput(preview!);
  }

  // ---------------------------------------------------------------------
  // Approval
  // ---------------------------------------------------------------------

  private approvalReviewContext(request: ApprovalRequestRecord): ApprovalReviewContext {
    if (request.reviewContext) return request.reviewContext;
    throw createError('PERMISSION_DENIED', {
      message: 'The approval request lacks durable review context and cannot be decided safely.',
    });
  }

  /** Creates a pending request. It deliberately cannot mint an apply token. */
  async requestApproval(planHash: string, note?: string): Promise<ApprovalRequestSummary> {
    const started = Date.now();
    let stored: StoredPlan;
    try {
      stored = await this.getFreshPlan(planHash);
    } catch (error) {
      throw await this.saveUnresolvedFailedOperation(
        'approval-request-denied',
        'not-issued',
        started,
        error,
      );
    }
    const { plan, operationId, correlationId } = stored;
    const target = plan.target as Required<typeof plan.target>;

    let request: ApprovalRequestRecord;
    try {
      this.config.policy.assertConnectionAllowed(target.connection);
      this.config.policy.assertMutationActorAllowed(this.actor.actor);
      request = await this.approvals.request({
        planHash,
        requestingActor: this.actor.actor,
        connectionAlias: target.connection,
        appId: target.appId,
        sheetId: target.sheetId,
        riskClass: plan.riskClass,
        ttlMs: this.approvalRequestTtlMs,
        reviewContext: {
          operationId,
          correlationId,
          platform: plan.platform,
          chartType: plan.chartType,
          title: plan.title,
          resolvedSummary: {
            dimensions: plan.resolved.dimensions.map((item) => item.label),
            measures: plan.resolved.measures.map((item) => item.label),
            filters: plan.resolved.filters.map((filter) => ({
              field: filter.label,
              values: filter.values,
            })),
          },
          warnings: plan.warnings,
          diff: plan.diff,
        },
        ...(note ? { note } : {}),
      });
    } catch (error) {
      throw await this.saveFailedOperation(
        {
          operationId,
          correlationId,
          connectionAlias: target.connection,
          platform: plan.platform,
          appId: target.appId,
          sheetId: target.sheetId,
          planHash,
          policyResult: 'approval-request-denied',
          approvalState: 'not-issued',
          durationMilliseconds: Date.now() - started,
        },
        error,
      );
    }

    await this.saveOperation(
      this.buildOperationRecord({
        operationId,
        correlationId,
        connectionAlias: target.connection,
        platform: plan.platform,
        appId: target.appId,
        sheetId: target.sheetId,
        planHash,
        policyResult: 'pending-authorized-decision',
        approvalState: 'pending',
        typedOutcome: { status: 'approval-requested' },
        durationMilliseconds: Date.now() - started,
      }),
    );

    return this.sanitizeApprovalRequest(request);
  }

  async approveApproval(requestId: string): Promise<ApprovalSummary> {
    const started = Date.now();
    let request: ApprovalRequestRecord | undefined;
    try {
      request = await this.approvals.getRequest(requestId);
    } catch (error) {
      throw await this.saveUnresolvedFailedOperation(
        'approval-decision-denied',
        'unknown',
        started,
        error,
      );
    }
    if (!request) {
      throw await this.saveUnresolvedFailedOperation(
        'approval-decision-denied',
        'not-found',
        started,
        createError('APPROVAL_REQUEST_NOT_FOUND'),
      );
    }
    const context = this.approvalReviewContext(request);
    let approval: ApprovalRecord;
    try {
      this.config.policy.assertReviewerActorAllowed(this.actor.actor);
      this.config.policy.assertReviewerSeparated(request.requestingActor, this.actor.actor);
      this.config.policy.assertConnectionAllowed(request.connectionAlias);
      approval = await this.approvals.approve(requestId, this.actor.actor, this.approvalTtlMs);
      await this.saveOperation(
        this.buildOperationRecord({
          operationId: context.operationId,
          correlationId: context.correlationId,
          connectionAlias: request.connectionAlias,
          platform: context.platform,
          appId: request.appId,
          sheetId: request.sheetId,
          planHash: request.planHash,
          policyResult: 'approved-by-independent-reviewer',
          approvalState: 'issued',
          typedOutcome: { status: 'approved' },
          durationMilliseconds: Date.now() - started,
        }),
      );
    } catch (error) {
      throw await this.saveFailedOperation(
        {
          operationId: reviewAuditOperationId(),
          correlationId: context.correlationId,
          connectionAlias: request.connectionAlias,
          platform: context.platform,
          appId: request.appId,
          sheetId: request.sheetId,
          planHash: request.planHash,
          policyResult: 'approval-decision-denied',
          approvalState: request.status,
          durationMilliseconds: Date.now() - started,
        },
        error,
      );
    }
    return redactForOutput({
      approvalToken: approval.approvalToken,
      planHash: request.planHash,
      actor: approval.actor,
      connection: request.connectionAlias,
      appId: request.appId,
      sheetId: request.sheetId,
      chartType: context.chartType,
      resolvedSummary: {
        dimensions: context.resolvedSummary.dimensions,
        measures: context.resolvedSummary.measures,
      },
      riskClass: request.riskClass,
      warnings: context.warnings,
      expiresAt: approval.expiresAt,
      singleUse: true,
      status: 'approved',
    } as ApprovalSummary);
  }

  async rejectApproval(requestId: string, reason?: string): Promise<ApprovalRequestSummary> {
    const started = Date.now();
    let request: ApprovalRequestRecord | undefined;
    try {
      request = await this.approvals.getRequest(requestId);
    } catch (error) {
      throw await this.saveUnresolvedFailedOperation(
        'rejection-decision-denied',
        'unknown',
        started,
        error,
      );
    }
    if (!request) {
      throw await this.saveUnresolvedFailedOperation(
        'rejection-decision-denied',
        'not-found',
        started,
        createError('APPROVAL_REQUEST_NOT_FOUND'),
      );
    }
    const context = this.approvalReviewContext(request);
    try {
      this.config.policy.assertReviewerActorAllowed(this.actor.actor);
      this.config.policy.assertReviewerSeparated(request.requestingActor, this.actor.actor);
      this.config.policy.assertConnectionAllowed(request.connectionAlias);
      const rejected = await this.approvals.reject(requestId, this.actor.actor, reason);
      await this.saveOperation(
        this.buildOperationRecord({
          operationId: context.operationId,
          correlationId: context.correlationId,
          connectionAlias: request.connectionAlias,
          platform: context.platform,
          appId: request.appId,
          sheetId: request.sheetId,
          planHash: request.planHash,
          policyResult: 'rejected-by-independent-reviewer',
          approvalState: 'rejected',
          typedOutcome: {
            status: 'failed',
            code: 'APPROVAL_REJECTED',
            category: 'approval',
            retryable: false,
          },
          durationMilliseconds: Date.now() - started,
        }),
      );
      return this.sanitizeApprovalRequest(rejected);
    } catch (error) {
      throw await this.saveFailedOperation(
        {
          operationId: reviewAuditOperationId(),
          correlationId: context.correlationId,
          connectionAlias: request.connectionAlias,
          platform: context.platform,
          appId: request.appId,
          sheetId: request.sheetId,
          planHash: request.planHash,
          policyResult: 'rejection-decision-denied',
          approvalState: request.status,
          durationMilliseconds: Date.now() - started,
        },
        error,
      );
    }
  }

  async getApprovalRequest(requestId: string): Promise<ApprovalRequestSummary> {
    const request = await this.approvals.getRequest(requestId);
    if (!request) throw createError('APPROVAL_REQUEST_NOT_FOUND');
    if (request.requestingActor !== this.actor.actor && request.decidedBy !== this.actor.actor) {
      try {
        this.config.policy.assertReviewerActorAllowed(this.actor.actor);
      } catch {
        throw createError('OPERATION_ACCESS_DENIED');
      }
    }
    return this.sanitizeApprovalRequest(request);
  }

  private sanitizeApprovalRequest(request: ApprovalRequestRecord): ApprovalRequestSummary {
    const context = this.approvalReviewContext(request);
    return redactForOutput({
      requestId: request.requestId,
      planHash: request.planHash,
      requestingActor: request.requestingActor,
      connection: request.connectionAlias,
      appId: request.appId,
      sheetId: request.sheetId,
      chartType: context.chartType,
      title: context.title,
      resolvedSummary: context.resolvedSummary,
      riskClass: request.riskClass,
      warnings: context.warnings,
      diff: context.diff,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      status:
        request.status === 'pending' && Date.now() > Date.parse(request.expiresAt)
          ? 'expired'
          : request.status,
      ...(request.decidedAt ? { decidedAt: request.decidedAt } : {}),
      ...(request.decidedBy ? { decidedBy: request.decidedBy } : {}),
      ...(request.rejectionReason ? { rejectionReason: request.rejectionReason } : {}),
      ...(request.note ? { note: request.note } : {}),
    });
  }

  // ---------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------

  async applyVisualization(
    planHash: string,
    approvalToken: string,
    idempotencyKey: string,
  ): Promise<ApplySummary> {
    const started = Date.now();
    let stored: StoredPlan;
    try {
      stored = await this.getFreshPlan(planHash);
    } catch (error) {
      throw await this.saveUnresolvedFailedOperation(
        'apply-preflight-denied',
        'not-consumed',
        started,
        error,
      );
    }
    const { plan, operationId, correlationId } = stored;
    const target = plan.target as Required<typeof plan.target>;

    const binding = {
      actor: this.actor.actor,
      connectionAlias: target.connection,
      appId: target.appId,
      sheetId: target.sheetId,
      planHash,
    };

    let adapter: TargetAdapter;
    let idempotencyStarted = false;
    let approvalConsumed = false;
    try {
      const lookup = await this.idempotency.lookup(idempotencyKey, binding);
      if (lookup.kind === 'replay') {
        await this.saveOperation(
          this.buildOperationRecord({
            operationId,
            correlationId,
            connectionAlias: target.connection,
            platform: plan.platform,
            appId: target.appId,
            sheetId: target.sheetId,
            planHash,
            policyResult: 'idempotent-result-replay',
            approvalState: 'already-consumed',
            typedOutcome: {
              status: 'replayed',
              originalOperationId: lookup.record.operationId,
              originalObjectId: (lookup.record.result as { objectId?: string } | undefined)
                ?.objectId,
            },
            durationMilliseconds: Date.now() - started,
            createdObjectId:
              (lookup.record.result as { objectId?: string } | undefined)?.objectId ?? null,
          }),
        );
        return redactForOutput(lookup.record.result as ApplySummary);
      }
      if (lookup.kind === 'conflict') {
        throw createError('IDEMPOTENCY_CONFLICT');
      }

      await this.approvals.assertValidForApply(approvalToken, binding);
      this.config.policy.assertConnectionAllowed(target.connection);
      this.config.policy.assertMutationActorAllowed(this.actor.actor);

      ({ adapter } = this.resolveAdapterForConnection(target.connection));
      await assertMutationCapability(adapter, target.connection);

      const { sheets } = await adapter.getCompilationContext(
        target.connection,
        target.appId,
        this.actor,
        'default',
      );
      const sheet = sheets.find((entry) => entry.sheetId === target.sheetId);
      if (!sheet) {
        throw createError('NOT_FOUND', { message: `Sheet "${target.sheetId}" was not found.` });
      }
      this.config.policy.assertSheetWritable(sheet.writeAllowed, target.sheetId);

      // This is intentionally the final policy gate before any mutation state is
      // begun or approval is consumed. All four scopes are evaluated together.
      this.config.policy.assertMutationTargetAllowed(
        target.connection,
        target.appId,
        target.sheetId,
        plan.chartType,
      );

      await this.idempotency.beginInProgress(idempotencyKey, binding, operationId);
      idempotencyStarted = true;
      await this.approvals.consume(approvalToken, idempotencyKey);
      approvalConsumed = true;
      await this.saveOperation(
        this.buildOperationRecord({
          operationId,
          correlationId,
          connectionAlias: target.connection,
          platform: plan.platform,
          appId: target.appId,
          sheetId: target.sheetId,
          planHash,
          policyResult: 'apply-reserved-before-adapter-mutation',
          approvalState: 'consumed',
          typedOutcome: { status: 'applying' },
          durationMilliseconds: Date.now() - started,
        }),
      );
    } catch (error) {
      const idempotencyState = idempotencyStarted
        ? await this.markIdempotencyFailed(idempotencyKey)
        : 'not-started';
      const safePreflightError =
        isHarnessError(error) && error.code === 'IDEMPOTENCY_CONFLICT'
          ? createError('IDEMPOTENCY_CONFLICT')
          : error;
      const safePrimary = this.safeApplyFailure(safePreflightError);
      const basePolicyResult = approvalConsumed
        ? 'apply-reservation-audit-failed'
        : 'apply-preflight-denied';
      const auditRecorded = await this.saveRecoveryOperation(
        this.buildOperationRecord({
          operationId,
          correlationId,
          connectionAlias: target.connection,
          platform: plan.platform,
          appId: target.appId,
          sheetId: target.sheetId,
          planHash,
          policyResult:
            idempotencyState === 'unconfirmed'
              ? `${basePolicyResult}-idempotency-state-unconfirmed`
              : basePolicyResult,
          approvalState: approvalConsumed ? 'consumed' : 'not-consumed',
          typedOutcome: {
            status: 'failed',
            code: safePrimary.code,
            category: safePrimary.category,
            retryable: safePrimary.retryable,
            ...(safePrimary.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: safePrimary.retryAfterSeconds }
              : {}),
          },
          durationMilliseconds: Date.now() - started,
        }),
      );
      throw this.applyFailureWithRecoveryEvidence(safePrimary, {
        idempotencyState,
        auditRecorded,
      });
    }

    let createdObjectId: string | undefined;
    let sheetAttachmentId: string | undefined;
    try {
      const persisted = await adapter.persistChart({
        target,
        plan,
        actor: this.actor,
        idempotencyKey,
      });
      createdObjectId = persisted.objectId;

      const attached = await adapter.attachChartToSheet({ target, objectId: persisted.objectId });
      sheetAttachmentId = attached.sheetAttachmentId;

      const verification = await adapter.verifyChart({ target, objectId: persisted.objectId });
      if (!verification.verified) {
        throw createError('PARTIAL_APPLY', {
          details: { createdObjectId, reason: 'verification-failed' },
        });
      }

      const result: ApplySummary = {
        operationId,
        planHash,
        status: 'verified',
        objectId: persisted.objectId,
        sheetAttachmentId,
        verified: true,
        render: adapter.renderDescriptor(target, persisted.objectId, operationId, 'persisted'),
        warnings: plan.warnings,
      };

      await this.idempotency.complete(idempotencyKey, result);
      await this.saveOperation(
        this.buildOperationRecord({
          operationId,
          correlationId,
          connectionAlias: target.connection,
          platform: plan.platform,
          appId: target.appId,
          sheetId: target.sheetId,
          planHash,
          policyResult: 'allowed-designated-development-sheet',
          approvalState: 'consumed',
          typedOutcome: { status: 'verified' },
          durationMilliseconds: Date.now() - started,
          cleanupAttempted: false,
          cleanupOutcome: 'not-required',
          createdObjectId: persisted.objectId,
          sheetAttachmentId,
        }),
      );

      return redactForOutput(result);
    } catch (error) {
      const safeError = this.safeApplyFailure(error);

      if (!createdObjectId) {
        const idempotencyState = await this.markIdempotencyFailed(idempotencyKey);
        const policyResult =
          idempotencyState === 'unconfirmed'
            ? 'allowed-designated-development-sheet-idempotency-state-unconfirmed'
            : 'allowed-designated-development-sheet';
        const auditRecorded = await this.saveRecoveryOperation(
          this.buildOperationRecord({
            operationId,
            correlationId,
            connectionAlias: target.connection,
            platform: plan.platform,
            appId: target.appId,
            sheetId: target.sheetId,
            planHash,
            policyResult,
            approvalState: 'consumed',
            typedOutcome: { status: 'failed', code: safeError.code, category: safeError.category },
            durationMilliseconds: Date.now() - started,
          }),
        );
        throw this.applyFailureWithRecoveryEvidence(safeError, {
          idempotencyState,
          auditRecorded,
        });
      }

      let cleanupOutcome: 'cleanup-complete' | 'cleanup-failed';
      try {
        const cleanup = await adapter.cleanupObject({
          target,
          objectId: createdObjectId,
          sheetAttachmentId,
        });
        cleanupOutcome = cleanup.outcome;
      } catch {
        cleanupOutcome = 'cleanup-failed';
      }

      const idempotencyState = await this.markIdempotencyFailed(idempotencyKey);
      const policyResult =
        idempotencyState === 'unconfirmed'
          ? 'allowed-designated-development-sheet-idempotency-state-unconfirmed'
          : 'allowed-designated-development-sheet';
      const cleanupRequired = cleanupOutcome !== 'cleanup-complete';
      const auditRecorded = await this.saveRecoveryOperation(
        this.buildOperationRecord({
          operationId,
          correlationId,
          connectionAlias: target.connection,
          platform: plan.platform,
          appId: target.appId,
          sheetId: target.sheetId,
          planHash,
          policyResult,
          approvalState: 'consumed',
          typedOutcome: {
            status: cleanupOutcome === 'cleanup-complete' ? 'failed' : 'cleanup-required',
            code: 'PARTIAL_APPLY',
            category: 'mutation',
            cleanupRequired,
          },
          durationMilliseconds: Date.now() - started,
          cleanupAttempted: true,
          cleanupOutcome,
          createdObjectId,
          sheetAttachmentId: sheetAttachmentId ?? null,
        }),
      );
      throw createError('PARTIAL_APPLY', {
        details: {
          createdObjectId,
          cleanupRequired,
          idempotencyState,
          auditRecorded,
          primaryFailureCode: safeError.code,
        },
      });
    }
  }

  // ---------------------------------------------------------------------
  // Operation status
  // ---------------------------------------------------------------------

  async getOperation(operationId: string): Promise<OperationRecord> {
    const current = await this.config.operations.get(operationId);
    if (!current) throw createError('NOT_FOUND', { details: { operationId } });
    const actorParticipated = await this.config.operations.getForActor(
      operationId,
      this.actor.actor,
    );
    if (!actorParticipated) {
      throw createError('OPERATION_ACCESS_DENIED', { details: { operationId } });
    }
    const publicRecord = Object.fromEntries(
      Object.entries(current).filter(
        ([key]) => !['sheetManifest', 'sheetManifestIntegrity', 'sheetPreview'].includes(key),
      ),
    ) as unknown as OperationRecord;
    return redactForOutput(publicRecord);
  }
}

export type { HarnessError };
