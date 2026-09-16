import { z } from 'zod';
import { chartIntentSchema } from '../compiler/chartIntentSchema.js';
import {
  compileChartIntent,
  COMPILER_VERSION,
  CHART_INTENT_VERSION,
  DEFAULT_PLAN_TTL_MS,
} from '../compiler/compiler.js';
import { parseChartTypeId } from '../compiler/chartTypeRegistry.js';
import {
  assertMutationCapability,
  assertPreviewCapability,
  assertReadCapability,
} from '../adapters/capabilityProbe.js';
import type {
  CreateSessionChartRequest,
  CreateSessionChartResult,
  SheetMutationWriter,
  TargetAdapter,
} from '../adapters/targetAdapter.js';
import { computePlanHash } from '../domain/ids.js';
import { createError, isHarnessError, toSafeUnexpectedError } from '../domain/errors.js';
import { redactForOutput } from '../domain/redaction.js';
import type {
  ActorContext,
  OperationRecord,
  PlatformId,
  ResolvedChartPlan,
} from '../domain/types.js';
import type {
  SheetExecutionSummary,
  SheetManifest,
  SheetPlanSummary,
  SheetPosition,
  SheetPreviewSummary,
} from '../domain/sheetTypes.js';
import type { PolicyEngine } from '../policy/policy.js';
import type { StoredPlan } from '../policy/planStore.js';
import type { IdempotencyBindingParams, IdempotencyLookup } from '../policy/idempotencyStore.js';
import type { OperationStore } from '../policy/operationStore.js';

export const sheetIntentSchema = z
  .object({
    connection: z.string().trim().min(1).max(100),
    appId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(120),
    charts: z.array(chartIntentSchema).min(1).max(12),
  })
  .strict();
export type SheetIntentInput = z.infer<typeof sheetIntentSchema>;

interface SheetServiceConfig {
  readonly actor: ActorContext;
  readonly adapters: Readonly<Partial<Record<PlatformId, TargetAdapter>>>;
  readonly policy: PolicyEngine;
  readonly operations: OperationStore;
  readonly getPlan: (hash: string) => Promise<StoredPlan | undefined>;
  readonly savePlan: (
    stored: Pick<StoredPlan, 'plan' | 'operationId' | 'correlationId' | 'presentationTarget'>,
  ) => Promise<void>;
  readonly saveOperation: (record: OperationRecord) => Promise<void>;
  readonly idempotency: {
    lookup(
      key: string,
      binding: IdempotencyBindingParams,
    ): IdempotencyLookup | Promise<IdempotencyLookup>;
    beginInProgress(
      key: string,
      binding: IdempotencyBindingParams,
      operationId: string,
    ): void | Promise<void>;
    complete(key: string, result: unknown): void | Promise<void>;
  };
  readonly planTtlMs?: number;
  readonly previewTimeoutMs?: number;
  readonly acquirePreviewSlot: (connection: string) => () => void;
}

/** Twelve bounded cells on Qlik's 24-column, 12-row grid; stable input order is visual order. */
export function sheetPositions(count: number): readonly SheetPosition[] {
  if (!Number.isInteger(count) || count < 1 || count > 12) throw createError('MALFORMED_REQUEST');
  const columns = count === 1 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const top = Math.floor((row * 12) / rows);
    return {
      col: (index % columns) * (24 / columns),
      row: top,
      colspan: 24 / columns,
      rowspan: Math.floor(((row + 1) * 12) / rows) - top,
    };
  });
}

function definitionHash(
  manifest: Omit<SheetManifest, 'planHash' | 'createdAt' | 'expiresAt'>,
  actor: string,
): string {
  return computePlanHash({
    actor,
    definition: {
      version: manifest.version,
      compilerVersion: manifest.compilerVersion,
      catalogHash: manifest.catalogHash,
      title: manifest.title,
      target: manifest.target,
      platform: manifest.platform,
      sourceSheetId: manifest.sourceSheetId,
      charts: manifest.charts,
    },
  });
}

function operationIdFor(planHash: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(planHash)) throw createError('PLAN_NOT_FOUND');
  return `sheet-${planHash.slice(7)}`;
}

/** Sheet state uses the existing durable plan, operation and conditional idempotency repositories. */
export class SheetService {
  constructor(private readonly config: SheetServiceConfig) {}

  private scope(manifest: Pick<SheetManifest, 'target' | 'charts'>) {
    const entry = this.config.policy.assertSheetGenerationAllowed(
      this.config.actor.actor,
      manifest.target.connection,
      manifest.target.appId,
      manifest.charts.map((chart) => chart.chartType),
    );
    const adapter = this.config.adapters[entry.platform];
    if (!adapter) throw createError('NOT_CONFIGURED');
    return { entry, adapter };
  }

  private audit(
    manifest: SheetManifest,
    status: OperationRecord['typedOutcome']['status'],
    operationId = operationIdFor(manifest.planHash),
  ): OperationRecord {
    return {
      recordVersion: '1.0.0',
      recordType: 'sanitized-operation-audit',
      operationId,
      timestamp: new Date().toISOString(),
      correlationId: operationIdFor(manifest.planHash),
      requestingPrincipal: this.config.actor.actor,
      hostClientId: this.config.actor.hostClientId,
      connectionAlias: manifest.target.connection,
      platform: manifest.platform,
      target: { appId: manifest.target.appId, sheetId: manifest.target.sheetId },
      effectiveQlikIdentityClass: `${manifest.platform}-scoped-sheet-workload`,
      intentVersion: CHART_INTENT_VERSION,
      compilerVersion: COMPILER_VERSION,
      planHash: manifest.planHash,
      policyResult: 'explicit-scoped-sheet-generation',
      approvalState: 'server-policy-grant',
      typedOutcome: { status },
      retryCount: 0,
      durationMilliseconds: 0,
      cleanupAttempted: false,
      cleanupOutcome: 'not-required',
      createdObjectId: null,
      traceReference: `correlation:${operationIdFor(manifest.planHash)}`,
      redaction: {
        rawPayloadsRemoved: true,
        sensitiveValuesRemoved: true,
        credentialMaterialPresent: false,
      },
    };
  }

  private async manifest(planHash: string, fresh = true): Promise<SheetManifest> {
    const record = await this.config.operations.get(operationIdFor(planHash));
    if (
      !record ||
      record.requestingPrincipal !== this.config.actor.actor ||
      !record.sheetManifest ||
      record.sheetManifest.planHash !== planHash
    )
      throw createError('PLAN_NOT_FOUND');
    const manifest = record.sheetManifest;
    const positions = sheetPositions(manifest.charts.length);
    if (
      manifest.version !== 1 ||
      !manifest.title ||
      !manifest.compilerVersion ||
      !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !Number.isFinite(Date.parse(manifest.expiresAt)) ||
      Date.parse(manifest.expiresAt) < Date.parse(manifest.createdAt) ||
      record.sheetManifestIntegrity !== computePlanHash(manifest) ||
      definitionHash(manifest, this.config.actor.actor) !== planHash ||
      manifest.charts.some(
        (chart, index) =>
          computePlanHash(chart.position) !== computePlanHash(positions[index]) ||
          chart.objectId !==
            `${manifest.target.sheetId.replace('qlikai-sheet-', 'qlikai-chart-')}-${index + 1}`,
      )
    )
      throw createError('PLAN_NOT_FOUND', {
        message: 'Stored sheet plan failed integrity verification.',
      });
    if (
      fresh &&
      (manifest.compilerVersion !== COMPILER_VERSION ||
        Date.now() >= Date.parse(manifest.expiresAt))
    )
      throw createError('PLAN_STALE');
    this.scope(manifest);
    return manifest;
  }

  private async chartPlans(manifest: SheetManifest): Promise<readonly ResolvedChartPlan[]> {
    const { entry } = this.scope(manifest);
    return Promise.all(
      manifest.charts.map(async (chart) => {
        const stored = await this.config.getPlan(chart.planHash);
        if (
          !stored ||
          stored.plan.visualizationSchemaProfile !== entry.visualizationSchemaProfile ||
          (entry.visualizationSchemaVersion !== undefined &&
            stored.plan.visualizationSchemaVersion !== entry.visualizationSchemaVersion) ||
          stored.plan.title !== chart.title ||
          stored.plan.chartType !== chart.chartType ||
          stored.plan.planHash !== chart.planHash ||
          stored.plan.compilerVersion !== manifest.compilerVersion ||
          stored.plan.platform !== manifest.platform ||
          stored.plan.riskClass !== 'standard' ||
          stored.plan.target.sheetId !== manifest.target.sheetId ||
          stored.plan.target.connection !== manifest.target.connection ||
          stored.plan.target.appId !== manifest.target.appId
        )
          throw createError('PLAN_NOT_FOUND');
        return stored.plan;
      }),
    );
  }

  async plan(input: SheetIntentInput): Promise<SheetPlanSummary> {
    const parsed = sheetIntentSchema.safeParse(input);
    if (!parsed.success) throw createError('MALFORMED_REQUEST');
    const intent = parsed.data;
    const chartTypes = intent.charts.map((chart) =>
      parseChartTypeId(chart.presentation.preferredChartType),
    );
    const entry = this.config.policy.assertSheetGenerationAllowed(
      this.config.actor.actor,
      intent.connection,
      intent.appId,
      chartTypes,
    );
    const adapter = this.config.adapters[entry.platform];
    if (!adapter || !entry.visualizationSchemaProfile) throw createError('NOT_CONFIGURED');
    if (
      !adapter.ensureSheet ||
      !adapter.verifySheet ||
      !adapter.canCreateSheetsInApp?.(intent.connection, intent.appId)
    )
      throw createError('PERMISSION_DENIED', {
        message: 'The adapter must explicitly authorize new-sheet creation in this app.',
      });
    await assertReadCapability(adapter, intent.connection);
    const { catalog, sheets } = await adapter.getCompilationContext(
      intent.connection,
      intent.appId,
      this.config.actor,
      'default',
    );
    const sourceSheet = sheets.find((sheet) => sheet.writeAllowed) ?? sheets[0];
    if (!sourceSheet)
      throw createError('NOT_FOUND', {
        message: 'Sheet previews require an existing readable source sheet in the app.',
      });
    const seedHash = computePlanHash({
      version: 1,
      compilerVersion: COMPILER_VERSION,
      actor: this.config.actor.actor,
      intent,
      catalog,
      sourceSheetId: sourceSheet.sheetId,
      profile: entry.visualizationSchemaProfile,
      schemaVersion: entry.visualizationSchemaVersion ?? null,
    });
    const target = {
      connection: intent.connection,
      appId: intent.appId,
      sheetId: `qlikai-sheet-${seedHash.slice(7, 31)}`,
    };
    const now = new Date();
    const plans = intent.charts.map((chart) =>
      compileChartIntent({
        catalog,
        target,
        platform: entry.platform,
        visualizationSchemaProfile: entry.visualizationSchemaProfile,
        ...(entry.visualizationSchemaVersion
          ? { visualizationSchemaVersion: entry.visualizationSchemaVersion }
          : {}),
        intent: chart,
        now,
        planTtlMs: this.config.planTtlMs ?? DEFAULT_PLAN_TTL_MS,
      }),
    );
    if (plans.some((plan) => plan.riskClass !== 'standard'))
      throw createError('PERMISSION_DENIED', {
        message: 'Autonomous sheet generation permits standard-risk chart plans only.',
      });
    const positions = sheetPositions(plans.length);
    const definition = {
      version: 1 as const,
      compilerVersion: COMPILER_VERSION,
      catalogHash: computePlanHash(catalog),
      title: intent.title,
      target,
      platform: entry.platform,
      sourceSheetId: sourceSheet.sheetId,
      charts: plans.map((plan, index) => ({
        planHash: plan.planHash,
        objectId: `qlikai-chart-${seedHash.slice(7, 31)}-${index + 1}`,
        title: plan.title,
        chartType: plan.chartType,
        position: positions[index]!,
      })),
    };
    const planHash = definitionHash(definition, this.config.actor.actor);
    const operationId = operationIdFor(planHash);
    const previous = await this.config.operations.get(operationId);
    if (previous?.sheetManifest && Date.now() < Date.parse(previous.sheetManifest.expiresAt)) {
      const manifest = await this.manifest(planHash);
      return redactForOutput({
        ...manifest,
        operationId,
        status: 'planned',
        executionMode: 'scoped-autonomous',
      });
    }
    const manifest: SheetManifest = {
      ...definition,
      planHash,
      createdAt: now.toISOString(),
      expiresAt: plans[0]!.expiresAt,
    };
    // Persist child plans before publishing their manifest. No native properties cross the MCP boundary.
    await Promise.all(
      plans.map((plan, index) =>
        this.config.savePlan({
          plan,
          operationId: `${operationId}-chart-${index + 1}`,
          correlationId: operationId,
          presentationTarget: intent.charts[index]!.presentation.target ?? null,
        }),
      ),
    );
    await this.config.saveOperation({
      ...this.audit(manifest, 'planned'),
      sheetManifest: manifest,
      sheetManifestIntegrity: computePlanHash(manifest),
    });
    return redactForOutput({
      ...manifest,
      operationId,
      status: 'planned',
      executionMode: 'scoped-autonomous',
    });
  }

  async preview(planHash: string, signal?: AbortSignal): Promise<SheetPreviewSummary> {
    const manifest = await this.manifest(planHash);
    const release = this.config.acquirePreviewSlot(manifest.target.connection);
    const pending = new Set<Promise<void>>();
    try {
      return await this.previewReserved(manifest, pending, signal);
    } finally {
      // An uncooperative provider keeps its admission slot until its late session is disposed.
      if (pending.size) void Promise.allSettled([...pending]).then(release);
      else release();
    }
  }

  private async previewReserved(
    manifest: SheetManifest,
    pending: Set<Promise<void>>,
    signal?: AbortSignal,
  ): Promise<SheetPreviewSummary> {
    const planHash = manifest.planHash;
    const { adapter } = this.scope(manifest);
    await assertPreviewCapability(adapter, manifest.target.connection);
    const plans = await this.chartPlans(manifest);
    const deadline = AbortSignal.timeout(this.config.previewTimeoutMs ?? 15_000);
    const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const charts: SheetPreviewSummary['charts'][number][] = [];
    // Sequential bounded sessions limit QIX concurrency and clean each preview before starting the next.
    for (const [index, plan] of plans.entries()) {
      const session = await this.previewSession(
        adapter,
        {
          target: { ...manifest.target, sheetId: manifest.sourceSheetId },
          plan,
          actor: this.config.actor,
          signal: combinedSignal,
        },
        pending,
        signal,
      );
      try {
        if (
          session.layout.objectType !== plan.nativeChartType ||
          session.layout.qHyperCube.qMeasureInfo.length !== plan.resolved.measures.length ||
          session.layout.qHyperCube.qDimensionInfo.length !== plan.resolved.dimensions.length
        )
          throw createError('PARTIAL_APPLY', {
            message: 'Preview layout does not match the compiled chart plan.',
          });
        charts.push({
          objectId: manifest.charts[index]!.objectId,
          returnedRows: session.layout.bounded.returnedRows,
          truncated: session.layout.bounded.truncated,
        });
      } finally {
        await adapter.disposeSessionChart(manifest.target.connection, session.sessionObjectId);
      }
    }
    const summary: SheetPreviewSummary = {
      operationId: `${operationIdFor(planHash)}-preview`,
      planHash,
      status: 'previewed',
      charts,
      verifiedAt: new Date().toISOString(),
    };
    await this.config.saveOperation({
      ...this.audit(manifest, 'previewed', summary.operationId),
      sheetPreview: summary,
    });
    return summary;
  }

  private async previewSession(
    adapter: TargetAdapter,
    request: CreateSessionChartRequest,
    pending: Set<Promise<void>>,
    callerSignal?: AbortSignal,
  ): Promise<CreateSessionChartResult> {
    if (request.signal.aborted)
      throw createError(callerSignal?.aborted ? 'OPERATION_CANCELLED' : 'PREVIEW_TIMEOUT');
    let abandoned = false;
    let onAbort: () => void = () => undefined;
    const result = adapter.createSessionChart(request);
    const lifecycle = result.then(
      async (session) => {
        if (abandoned)
          await adapter.disposeSessionChart(request.target.connection, session.sessionObjectId);
      },
      () => undefined,
    );
    pending.add(lifecycle);
    void lifecycle.then(
      () => pending.delete(lifecycle),
      () => pending.delete(lifecycle),
    );
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        abandoned = true;
        reject(createError(callerSignal?.aborted ? 'OPERATION_CANCELLED' : 'PREVIEW_TIMEOUT'));
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted) onAbort();
    });
    try {
      return await Promise.race([result, aborted]);
    } finally {
      request.signal.removeEventListener('abort', onAbort);
    }
  }

  private binding(manifest: SheetManifest): IdempotencyBindingParams {
    return {
      actor: this.config.actor.actor,
      connectionAlias: manifest.target.connection,
      appId: manifest.target.appId,
      sheetId: manifest.target.sheetId,
      planHash: manifest.planHash,
    };
  }

  private attemptKey(manifest: SheetManifest, attempt: number): string {
    return `sheet-attempt:${manifest.planHash}:${attempt}`;
  }

  async apply(
    planHash: string,
    idempotencyKey: string,
    attempt = 0,
    signal?: AbortSignal,
  ): Promise<SheetExecutionSummary> {
    const started = Date.now();
    if (signal?.aborted) throw createError('OPERATION_CANCELLED');
    if (
      !idempotencyKey.trim() ||
      idempotencyKey.length > 200 ||
      !Number.isInteger(attempt) ||
      attempt < 0 ||
      attempt > 20
    )
      throw createError('MALFORMED_REQUEST');
    const manifest = await this.manifest(planHash);
    const { adapter } = this.scope(manifest);
    const binding = this.binding(manifest);
    const attemptKey = this.attemptKey(manifest, attempt);
    const externalKey = `sheet-request:${idempotencyKey}`;
    const requestBinding = await this.config.idempotency.lookup(externalKey, binding);
    if (requestBinding.kind === 'conflict') throw createError('IDEMPOTENCY_CONFLICT');
    if (requestBinding.kind === 'miss') {
      await this.config.idempotency.beginInProgress(externalKey, binding, operationIdFor(planHash));
      await this.config.idempotency.complete(externalKey, { planHash });
    }
    const stableRequestKey = `sheet-original-request:${planHash}`;
    const requestHash = computePlanHash(idempotencyKey);
    const stableRequest = await this.config.idempotency.lookup(stableRequestKey, binding);
    if (
      stableRequest.kind === 'conflict' ||
      (stableRequest.kind === 'replay' &&
        (stableRequest.record.result as { requestHash: string }).requestHash !== requestHash)
    )
      throw createError('IDEMPOTENCY_CONFLICT');
    if (stableRequest.kind === 'miss') {
      if (attempt !== 0) throw createError('IDEMPOTENCY_CONFLICT');
      await this.config.idempotency.beginInProgress(
        stableRequestKey,
        binding,
        operationIdFor(planHash),
      );
      await this.config.idempotency.complete(stableRequestKey, { requestHash });
    }
    const existing = await this.config.idempotency.lookup(attemptKey, binding);
    if (existing.kind === 'replay') return existing.record.result as SheetExecutionSummary;
    if (existing.kind === 'conflict')
      throw createError('IDEMPOTENCY_CONFLICT', {
        message:
          'This attempt is still in progress or its outcome is uncertain. Verify the sheet before any further action.',
      });
    if (attempt > 0) {
      const previous = await this.config.idempotency.lookup(
        this.attemptKey(manifest, attempt - 1),
        binding,
      );
      if (
        previous.kind !== 'replay' ||
        (previous.record.result as SheetExecutionSummary).nextAttempt !== attempt
      )
        throw createError('IDEMPOTENCY_CONFLICT', {
          message: 'Resume requires the nextAttempt returned by the preceding partial attempt.',
        });
    }
    const preview = await this.config.operations.get(`${operationIdFor(planHash)}-preview`);
    if (
      preview?.requestingPrincipal !== this.config.actor.actor ||
      preview.sheetPreview?.charts.length !== manifest.charts.length ||
      Date.parse(preview.sheetPreview.verifiedAt) < Date.parse(manifest.createdAt)
    )
      throw createError('PERMISSION_DENIED', {
        message: 'Every chart must pass a fresh sheet preview before creation.',
      });
    if (!adapter.ensureSheet || !adapter.verifySheet)
      throw createError('NOT_CONFIGURED', {
        message: 'The configured adapter does not support new-sheet creation and verification.',
      });
    await assertMutationCapability(adapter, manifest.target.connection);
    const current = await adapter.getCompilationContext(
      manifest.target.connection,
      manifest.target.appId,
      this.config.actor,
      'default',
    );
    if (computePlanHash(current.catalog) !== manifest.catalogHash)
      throw createError('PLAN_STALE', {
        message:
          'The app catalog changed after planning; replan and preview before creating the sheet.',
      });
    const plans = await this.chartPlans(manifest);
    this.scope(manifest);
    if (signal?.aborted) throw createError('OPERATION_CANCELLED');
    await this.config.idempotency.beginInProgress(
      attemptKey,
      binding,
      `${operationIdFor(planHash)}-attempt-${attempt}`,
    );
    const charts: { objectId: string; verified: boolean }[] = [];
    let errorCode: string | undefined;
    try {
      await this.config.saveOperation(
        this.audit(manifest, 'applying', `${operationIdFor(planHash)}-attempt-${attempt}`),
      );
      const writeCharts = async (writer: SheetMutationWriter) => {
        const sheet = await writer.ensureSheet({
          target: manifest.target,
          title: manifest.title,
          actor: this.config.actor,
          idempotencyKey: manifest.planHash,
        });
        if (sheet.sheetId !== manifest.target.sheetId) throw createError('PARTIAL_APPLY');
        for (const [index, chart] of manifest.charts.entries()) {
          if (signal?.aborted) throw createError('OPERATION_CANCELLED');
          this.scope(manifest);
          const plan = plans[index]!;
          const persisted = await writer.persistChart({
            target: manifest.target,
            plan,
            actor: this.config.actor,
            idempotencyKey: `${manifest.planHash}:${index}`,
            objectId: chart.objectId,
            placement: chart.position,
          });
          if (persisted.objectId !== chart.objectId) throw createError('PARTIAL_APPLY');
          await writer.attachChartToSheet({
            target: manifest.target,
            objectId: chart.objectId,
            placement: chart.position,
          });
          const verification = await writer.verifyChart({
            target: manifest.target,
            objectId: chart.objectId,
            plan,
            placement: chart.position,
          });
          charts.push({ objectId: chart.objectId, verified: verification.verified });
          if (!verification.verified) throw createError('PARTIAL_APPLY');
        }
      };
      if (adapter.withSheetMutationSession) {
        await adapter.withSheetMutationSession(
          { target: manifest.target, actor: this.config.actor, ...(signal ? { signal } : {}) },
          writeCharts,
        );
      } else {
        await writeCharts({
          ensureSheet: adapter.ensureSheet.bind(adapter),
          persistChart: adapter.persistChart.bind(adapter),
          attachChartToSheet: adapter.attachChartToSheet.bind(adapter),
          verifyChart: adapter.verifyChart.bind(adapter),
        });
      }
      const verifiedSheet = await adapter.verifySheet({
        target: manifest.target,
        title: manifest.title,
        objectIds: manifest.charts.map((chart) => chart.objectId),
        actor: this.config.actor,
      });
      if (!verifiedSheet.verified) throw createError('PARTIAL_APPLY');
    } catch (error) {
      if (
        isHarnessError(error) &&
        error.code === 'IDEMPOTENCY_CONFLICT' &&
        error.details?.outcome === 'uncertain'
      ) {
        // A native write may still be completing. Never release its durable
        // reservation or invent a retry receipt before reconciliation.
        try {
          await this.config.saveOperation({
            ...this.audit(manifest, 'failed', `${operationIdFor(planHash)}-attempt-${attempt}`),
            typedOutcome: { status: 'failed', code: error.code, cleanupRequired: true },
            cleanupOutcome: 'reconciliation-required',
            durationMilliseconds: Date.now() - started,
          });
        } catch {
          // The in-progress claim stays authoritative if audit persistence fails.
        }
        throw error;
      }
      errorCode = toSafeUnexpectedError(error).code;
    }
    const verified =
      !errorCode &&
      charts.length === manifest.charts.length &&
      charts.every((chart) => chart.verified);
    const summary: SheetExecutionSummary = {
      operationId: `${operationIdFor(planHash)}-attempt-${attempt}`,
      planHash,
      sheetId: manifest.target.sheetId,
      status: verified ? 'verified' : 'partial',
      verified,
      charts,
      verifiedAt: new Date().toISOString(),
      attempt,
      ...(!verified && attempt < 20 ? { nextAttempt: attempt + 1 } : {}),
      ...(errorCode ? { errorCode } : {}),
      durationMilliseconds: Date.now() - started,
    };
    await this.config.idempotency.complete(attemptKey, summary);
    await this.config.saveOperation({
      ...this.audit(manifest, verified ? 'verified' : 'failed', summary.operationId),
      typedOutcome: {
        status: verified ? 'verified' : 'failed',
        ...(errorCode ? { code: errorCode } : {}),
      },
      durationMilliseconds: summary.durationMilliseconds,
      createdObjectId: manifest.target.sheetId,
    });
    return summary;
  }

  async verify(planHash: string): Promise<SheetExecutionSummary> {
    const started = Date.now();
    const manifest = await this.manifest(planHash, false);
    const { adapter } = this.scope(manifest);
    await assertReadCapability(adapter, manifest.target.connection);
    if (!adapter.verifySheet) throw createError('NOT_CONFIGURED');
    const plans = await this.chartPlans(manifest);
    const charts = [];
    for (const [index, chart] of manifest.charts.entries()) {
      try {
        const result = await adapter.verifyChart({
          target: manifest.target,
          objectId: chart.objectId,
          plan: plans[index]!,
          placement: chart.position,
        });
        charts.push({ objectId: chart.objectId, verified: result.verified });
      } catch {
        charts.push({ objectId: chart.objectId, verified: false });
      }
    }
    let sheetVerified = false;
    try {
      sheetVerified = (
        await adapter.verifySheet({
          target: manifest.target,
          title: manifest.title,
          objectIds: manifest.charts.map((chart) => chart.objectId),
          actor: this.config.actor,
        })
      ).verified;
    } catch {
      /* Missing/changed sheet is negative evidence, never successful verification. */
    }
    const verified = sheetVerified && charts.every((chart) => chart.verified);
    const result: SheetExecutionSummary = {
      operationId: `${operationIdFor(planHash)}-verify`,
      planHash,
      sheetId: manifest.target.sheetId,
      status: verified ? 'verified' : 'partial',
      verified,
      charts,
      verifiedAt: new Date().toISOString(),
      attempt: 0,
      durationMilliseconds: Date.now() - started,
    };
    await this.config.saveOperation(
      this.audit(manifest, verified ? 'verified' : 'failed', result.operationId),
    );
    return result;
  }
}
