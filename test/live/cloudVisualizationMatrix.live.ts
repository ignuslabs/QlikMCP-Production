import 'dotenv/config';

import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCloudRuntimeAdapter } from '../../src/adapters/cloud/cloudRuntime.js';
import type { CloudRuntimeEnvironment } from '../../src/adapters/cloud/cloudRuntime.js';
import type { CloudAdapter } from '../../src/adapters/cloud/cloudAdapter.js';
import { VISUALIZATION_REGISTRY } from '../../src/compiler/chartTypeRegistry.js';
import { createError, isHarnessError } from '../../src/domain/errors.js';
import {
  CHART_TYPE_IDS,
  type ActorContext,
  type ChartTypeId,
  type TargetRef,
} from '../../src/domain/types.js';
import { FileApprovalStore } from '../../src/policy/approvalStore.js';
import { FileIdempotencyStore } from '../../src/policy/idempotencyStore.js';
import { FileOperationStore } from '../../src/policy/operationStore.js';
import { PolicyEngine } from '../../src/policy/policy.js';
import { OperationService } from '../../src/server/operationService.js';
import {
  cloudLiveProbeError,
  liveProbeDiagnostics,
  liveProbeStage,
} from './cloudProbeDiagnostics.js';
import {
  preserveFailureAfterCleanup,
  RetainedObjectCleanupRequiredError,
  RetainedObjectFailureAfterConfirmedCleanupError,
} from './cloudProbeFailure.js';
import { assertRetainedManifestSlotAvailable } from './cloudRetainedManifest.js';
import { createCloudLiveReporter } from './cloudLiveLogging.js';

type MatrixAction = 'verify-cleanup' | 'retain' | 'cleanup' | 'reconcile';

interface VisualizationCase {
  readonly chartType: ChartTypeId;
  readonly dimensions: readonly string[];
  readonly measures: readonly string[];
  readonly target?: number;
}

interface RetainedManifest {
  readonly version: 1;
  readonly connection: string;
  readonly appId: string;
  readonly sheetId: string;
  readonly chartType: ChartTypeId;
  readonly nativeType: string;
  readonly objectId: string;
  readonly operationId: string;
  readonly objectIdSha256: string;
  readonly baselineObjectCount: number;
  readonly createdAt: string;
}

interface MatrixCaseEvidence {
  readonly chartType: ChartTypeId;
  readonly nativeType: string;
  readonly propertyVersion: string;
  readonly previewReturnedRows: number;
  readonly persistedReturnedRows: number;
  readonly idempotentReplay: true;
  readonly cleanup: 'cleanup-complete' | 'retained';
  readonly objectIdSha256: string;
  readonly operationId?: string;
}

const reporter = createCloudLiveReporter('visualization-matrix');
const MANIFEST_PATH = path.resolve(
  process.cwd(),
  '.qlik-ai-harness',
  'cloud-browser',
  'retained-object.json',
);
const MAX_DISCOVERY_PAGES = 100;
const PAGE_SIZE = 100;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,180}$/;

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function requiredEnvironment(name: string): string {
  const value = nonEmpty(process.env[name]);
  if (!value) {
    throw createError('NOT_CONFIGURED', {
      message: `The live Cloud visualization matrix requires the ${name} deployment setting.`,
    });
  }
  return value;
}

function runtimeEnvironment(): CloudRuntimeEnvironment {
  return {
    QLIK_CLOUD_CONNECTION_ALIAS: process.env.QLIK_CLOUD_CONNECTION_ALIAS,
    QLIK_CLOUD_TENANT_HOST: process.env.QLIK_CLOUD_TENANT_HOST,
    QLIK_CLOUD_TENANT_ALIAS: process.env.QLIK_CLOUD_TENANT_ALIAS,
    QLIK_CLOUD_REGION_ALIAS: process.env.QLIK_CLOUD_REGION_ALIAS,
    QLIK_CLOUD_OAUTH_CLIENT_ID: process.env.QLIK_CLOUD_OAUTH_CLIENT_ID,
    QLIK_CLOUD_ENVIRONMENT: process.env.QLIK_CLOUD_ENVIRONMENT,
    QLIK_CLOUD_WRITE_APP_ID: process.env.QLIK_CLOUD_WRITE_APP_ID,
    QLIK_CLOUD_WRITE_SHEET_ID: process.env.QLIK_CLOUD_WRITE_SHEET_ID,
    QLIK_CLOUD_READINESS_APPROVED: process.env.QLIK_CLOUD_READINESS_APPROVED,
    QLIK_CLOUD_READINESS_EXPIRES_AT: process.env.QLIK_CLOUD_READINESS_EXPIRES_AT,
    QLIK_CLOUD_READINESS_CAN_READ: process.env.QLIK_CLOUD_READINESS_CAN_READ,
    QLIK_CLOUD_READINESS_CAN_PREVIEW: process.env.QLIK_CLOUD_READINESS_CAN_PREVIEW,
    QLIK_CLOUD_READINESS_CAN_WRITE_DESIGNATED_SHEET:
      process.env.QLIK_CLOUD_READINESS_CAN_WRITE_DESIGNATED_SHEET,
    QLIK_CLOUD_READINESS_CLEANUP_VERIFIED: process.env.QLIK_CLOUD_READINESS_CLEANUP_VERIFIED,
  };
}

function readAction(): MatrixAction {
  const action = nonEmpty(process.env.QLIK_CLOUD_MATRIX_ACTION) ?? 'verify-cleanup';
  if (
    action !== 'verify-cleanup' &&
    action !== 'retain' &&
    action !== 'cleanup' &&
    action !== 'reconcile'
  ) {
    throw createError('NOT_CONFIGURED', {
      message: 'QLIK_CLOUD_MATRIX_ACTION must be verify-cleanup, retain, cleanup, or reconcile.',
    });
  }
  return action;
}

function readSelectedChartType(): ChartTypeId | undefined {
  const requested = nonEmpty(process.env.QLIK_CLOUD_MATRIX_CHART_TYPE)?.toLowerCase();
  if (!requested) return undefined;
  if (!(CHART_TYPE_IDS as readonly string[]).includes(requested)) {
    throw createError('NOT_CONFIGURED', {
      message: 'QLIK_CLOUD_MATRIX_CHART_TYPE is not in the bounded visualization registry.',
    });
  }
  return requested as ChartTypeId;
}

function buildCases(): readonly VisualizationCase[] {
  const region = requiredEnvironment('QLIK_CLOUD_PROBE_DIMENSION');
  const date = nonEmpty(process.env.QLIK_CLOUD_MATRIX_DATE_DIMENSION) ?? 'OrderDate';
  const revenue = requiredEnvironment('QLIK_CLOUD_PROBE_MEASURE');
  const secondary = nonEmpty(process.env.QLIK_CLOUD_MATRIX_SECONDARY_MEASURE) ?? 'Sum(Cost)';
  const gaugeTarget = Number(process.env.QLIK_CLOUD_MATRIX_GAUGE_TARGET ?? '20000');
  if (!Number.isFinite(gaugeTarget) || gaugeTarget <= 0) {
    throw createError('NOT_CONFIGURED', {
      message: 'QLIK_CLOUD_MATRIX_GAUGE_TARGET must be a positive finite number.',
    });
  }
  return [
    { chartType: 'bar', dimensions: [region], measures: [revenue] },
    { chartType: 'line', dimensions: [date], measures: [revenue] },
    { chartType: 'scatter', dimensions: [region], measures: [revenue, secondary] },
    { chartType: 'table', dimensions: [region], measures: [revenue] },
    { chartType: 'kpi', dimensions: [], measures: [revenue] },
    { chartType: 'gauge', dimensions: [], measures: [revenue], target: gaugeTarget },
    { chartType: 'treemap', dimensions: [region], measures: [revenue] },
    { chartType: 'pie', dimensions: [region], measures: [revenue] },
    { chartType: 'combo', dimensions: [region], measures: [revenue, secondary] },
  ];
}

function safeFailureCode(error: unknown): string {
  if (isHarnessError(error)) return error.code;
  if (error && typeof error === 'object') {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  }
  return 'LIVE_CLOUD_MATRIX_FAILED';
}

function objectHash(objectId: string): string {
  return createHash('sha256').update(objectId).digest('hex');
}

async function listAllSheetObjects(
  adapter: CloudAdapter,
  target: Required<TargetRef>,
  actor: ActorContext,
): Promise<ReadonlyMap<string, string>> {
  const objects = new Map<string, string>();
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_DISCOVERY_PAGES; pageIndex += 1) {
    const page = await adapter.listSheetObjects(
      target.connection,
      target.appId,
      target.sheetId,
      actor,
      { pageSize: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) },
    );
    for (const object of page.objects) objects.set(object.objectId, object.type);
    if (!page.truncated || !page.nextPageToken) return objects;
    if (seenTokens.has(page.nextPageToken)) {
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'Cloud sheet-object discovery returned a repeated continuation token.',
      });
    }
    seenTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
  throw createError('CAPACITY_EXHAUSTED', {
    message: 'Cloud sheet-object discovery exceeded its bounded page limit.',
  });
}

function validatePreview(
  rows: readonly (readonly (string | number)[])[],
  returnedRows: number,
  expectedColumns: number,
  measureStart: number,
  measureCount: number,
): Readonly<Record<string, boolean | number>> {
  const fullWidthRows = rows.filter((row) => row.length === expectedColumns);
  const usableMeasureRows = fullWidthRows.filter((row) =>
    Array.from({ length: measureCount }, (_, index) => row[measureStart + index]).every(
      (value) =>
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.trim().length > 0),
    ),
  );
  return {
    returnedRowsPositive: returnedRows > 0,
    returnedRowsMatch: returnedRows === rows.length,
    fullWidthRowCount: fullWidthRows.length,
    usableMeasureRowCount: usableMeasureRows.length,
    fullWidthRowPresent: fullWidthRows.length > 0,
    usableMeasureRowPresent: usableMeasureRows.length > 0,
  };
}

function assertChecks(
  checks: Readonly<Record<string, boolean | number>>,
  code:
    | 'ENGINE_LAYOUT_CONTRACT_FAILED'
    | 'PERSISTED_OBJECT_VERIFICATION_FAILED'
    | 'PERSISTED_OBJECT_CONTRACT_MISMATCH',
  stage: 'preview-validate' | 'retained-verification' | 'retained-contract',
): void {
  const failed = Object.entries(checks).some(([, value]) =>
    typeof value === 'boolean' ? !value : value <= 0,
  );
  if (!failed) return;
  throw cloudLiveProbeError(code, stage, checks, 'A live visualization contract check failed.');
}

function createServices(
  adapter: CloudAdapter,
  target: Required<TargetRef>,
  requester: ActorContext,
  reviewer: ActorContext,
  stateDirectory: string,
): { readonly requesterService: OperationService; readonly reviewerService: OperationService } {
  const approvalPath = path.join(stateDirectory, 'approvals.json');
  const idempotencyPath = path.join(stateDirectory, 'idempotency.json');
  const operationPath = path.join(stateDirectory, 'operations.json');
  const policy = () =>
    new PolicyEngine({
      allowedEnvironments: ['development'],
      connections: {
        [target.connection]: {
          alias: target.connection,
          platform: 'cloud' as const,
          visualizationSchemaProfile: 'qlik-cloud-current' as const,
          environment: 'development',
          allowedApps: { [target.appId]: [target.sheetId] },
          allowedChartTypes: [...CHART_TYPE_IDS],
        },
      },
      mutationActors: new Set([requester.actor]),
      reviewerActors: new Set([reviewer.actor]),
    });
  return {
    requesterService: new OperationService({
      actor: requester,
      adapters: { cloud: adapter },
      policy: policy(),
      approvals: new FileApprovalStore(approvalPath),
      idempotency: new FileIdempotencyStore(idempotencyPath),
      operations: new FileOperationStore(operationPath),
    }),
    reviewerService: new OperationService({
      actor: reviewer,
      adapters: { cloud: adapter },
      policy: policy(),
      approvals: new FileApprovalStore(approvalPath),
      idempotency: new FileIdempotencyStore(idempotencyPath),
      operations: new FileOperationStore(operationPath),
    }),
  };
}

function writeManifest(manifest: RetainedManifest): void {
  const directory = path.dirname(MANIFEST_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${MANIFEST_PATH}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, MANIFEST_PATH);
  chmodSync(MANIFEST_PATH, 0o600);
}

function readManifest(target: Required<TargetRef>): RetainedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    throw createError('NOT_CONFIGURED', {
      message: 'No valid retained-object manifest is available for exact cleanup.',
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw createError('NOT_CONFIGURED', { message: 'The retained-object manifest is invalid.' });
  }
  const value = parsed as Partial<RetainedManifest>;
  const validChart =
    typeof value.chartType === 'string' &&
    (CHART_TYPE_IDS as readonly string[]).includes(value.chartType);
  if (
    value.version !== 1 ||
    value.connection !== target.connection ||
    value.appId !== target.appId ||
    value.sheetId !== target.sheetId ||
    !validChart ||
    typeof value.nativeType !== 'string' ||
    value.nativeType !==
      VISUALIZATION_REGISTRY[value.chartType as ChartTypeId]?.profiles['qlik-cloud-current']
        .qlikInAppVisualizationId ||
    typeof value.objectId !== 'string' ||
    !SAFE_IDENTIFIER.test(value.objectId) ||
    typeof value.operationId !== 'string' ||
    !SAFE_IDENTIFIER.test(value.operationId) ||
    value.objectIdSha256 !== objectHash(value.objectId) ||
    typeof value.baselineObjectCount !== 'number' ||
    !Number.isSafeInteger(value.baselineObjectCount) ||
    typeof value.createdAt !== 'string'
  ) {
    throw createError('NOT_CONFIGURED', { message: 'The retained-object manifest is invalid.' });
  }
  return value as RetainedManifest;
}

async function runCase(params: {
  readonly adapter: CloudAdapter;
  readonly target: Required<TargetRef>;
  readonly requester: ActorContext;
  readonly reviewer: ActorContext;
  readonly visualization: VisualizationCase;
  readonly retain: boolean;
}): Promise<MatrixCaseEvidence> {
  const baseline = await reporter.stage('discovery', () =>
    listAllSheetObjects(params.adapter, params.target, params.requester),
  );
  const stateDirectory = mkdtempSync(path.join(tmpdir(), 'qlik-cloud-matrix-'));
  const { requesterService, reviewerService } = createServices(
    params.adapter,
    params.target,
    params.requester,
    params.reviewer,
    stateDirectory,
  );
  let applied: Awaited<ReturnType<OperationService['applyVisualization']>> | undefined;
  let retained = false;
  try {
    const planned = await reporter.stage('compile', () =>
      requesterService.planVisualization(
        params.target.connection,
        params.target.appId,
        params.target.sheetId,
        {
          analysis: {
            dimensions: [...params.visualization.dimensions],
            measures: [...params.visualization.measures],
          },
          presentation: {
            preferredChartType: params.visualization.chartType,
            title: `Qlik AI Harness native ${params.visualization.chartType} verification`,
            topN: 10,
            ...(params.visualization.target !== undefined
              ? { target: params.visualization.target }
              : {}),
          },
          mode: 'preview-then-apply',
        },
      ),
    );
    const expectedNativeType =
      VISUALIZATION_REGISTRY[params.visualization.chartType].profiles['qlik-cloud-current']
        .qlikInAppVisualizationId;
    if (planned.nativeChartType !== expectedNativeType) {
      throw createError('INVALID_CHART_CONFIGURATION', {
        message: 'The matrix plan did not resolve to the registered Cloud native type.',
      });
    }

    const preview = await reporter.stage('preview-create', () =>
      requesterService.previewVisualization(planned.planHash),
    );
    const previewChecks = validatePreview(
      preview.preview.rows,
      preview.preview.returnedRows,
      params.visualization.dimensions.length + params.visualization.measures.length,
      params.visualization.dimensions.length,
      params.visualization.measures.length,
    );
    reporter.debug('preview-validate', previewChecks);
    assertChecks(previewChecks, 'ENGINE_LAYOUT_CONTRACT_FAILED', 'preview-validate');

    const pending = await reporter.stage('approval', () =>
      requesterService.requestApproval(planned.planHash, 'Live nine-type native matrix'),
    );
    const review = await reviewerService.getApprovalRequest(pending.requestId);
    if (
      review.planHash !== planned.planHash ||
      review.chartType !== params.visualization.chartType ||
      review.resolvedSummary.dimensions.length !== params.visualization.dimensions.length ||
      review.resolvedSummary.measures.length !== params.visualization.measures.length
    ) {
      throw createError('APPROVAL_PLAN_HASH_MISMATCH');
    }
    const approval = await reporter.stage('approval', () =>
      reviewerService.approveApproval(pending.requestId),
    );
    const idempotencyKey = `cloud-native-matrix-${planned.planHash}`;
    applied = await reporter.stage('persist', () =>
      requesterService.applyVisualization(planned.planHash, approval.approvalToken, idempotencyKey),
    );
    const replay = await reporter.stage('replay', () =>
      requesterService.applyVisualization(planned.planHash, approval.approvalToken, idempotencyKey),
    );
    if (replay.objectId !== applied.objectId || replay.operationId !== applied.operationId) {
      throw createError('IDEMPOTENCY_CONFLICT');
    }

    const attachment = await reporter.stage('retained-attachment', () =>
      params.adapter.attachChartToSheet({
        target: params.target,
        objectId: applied!.objectId,
      }),
    );
    const verification = await reporter.stage('retained-verification', () =>
      params.adapter.verifyChart({ target: params.target, objectId: applied!.objectId }),
    );
    assertChecks(
      {
        attachmentIdMatches: attachment.sheetAttachmentId === applied.objectId,
        reopenedVerificationPassed: verification.verified,
      },
      'PERSISTED_OBJECT_VERIFICATION_FAILED',
      'retained-verification',
    );

    const inventory = await reporter.stage('retained-discovery', () =>
      listAllSheetObjects(params.adapter, params.target, params.requester),
    );
    const contract = await reporter.stage('retained-contract', () =>
      params.adapter.inspectVisualizationContract(
        params.target.connection,
        params.target.appId,
        applied!.objectId,
      ),
    );
    const expectedColumns =
      params.visualization.dimensions.length + params.visualization.measures.length;
    const contractChecks: Readonly<Record<string, boolean | number>> = {
      objectFoundOnSheet: inventory.has(applied.objectId),
      inventoryNativeKindMatches: inventory.get(applied.objectId) === expectedNativeType,
      propertyNativeKindMatches: contract.propertyType === expectedNativeType,
      propertyVersionMatches:
        contract.propertyVersion ===
        VISUALIZATION_REGISTRY[params.visualization.chartType].qlikDevSpecVersion,
      rootSortingAbsent: !contract.hasRootSorting,
      propertyDimensionCountMatches:
        contract.propertyDimensionCount === params.visualization.dimensions.length,
      propertyMeasureCountMatches:
        contract.propertyMeasureCount === params.visualization.measures.length,
      layoutNativeKindMatches: contract.layoutType === expectedNativeType,
      layoutVisualizationMatches: contract.layoutVisualization === expectedNativeType,
      layoutDimensionInfoCountMatches:
        contract.layoutDimensionInfoCount === params.visualization.dimensions.length,
      layoutMeasureInfoCountMatches:
        contract.layoutMeasureInfoCount === params.visualization.measures.length,
      cubeColumnCountMatches: contract.cubeColumnCount === expectedColumns,
      cubeRowCountPositive: (contract.cubeRowCount ?? 0) > 0,
      firstPageRowCount: contract.firstPageRowCount,
      fullWidthRowCount: contract.fullWidthRowCount,
      usableMeasureRowCount: contract.usableMeasureRowCount,
      layoutErrorAbsent: !contract.hasLayoutError,
      ...(params.visualization.chartType === 'table'
        ? {
            tableColumnOrderMatches:
              JSON.stringify(contract.qColumnOrder) ===
              JSON.stringify(Array.from({ length: expectedColumns }, (_, index) => index)),
            tableSortOrderStartsWithFirstMeasure:
              contract.qInterColumnSortOrder[0] === params.visualization.dimensions.length,
          }
        : {}),
    };
    reporter.debug('retained-contract', contractChecks);
    assertChecks(contractChecks, 'PERSISTED_OBJECT_CONTRACT_MISMATCH', 'retained-contract');

    const evidence: MatrixCaseEvidence = {
      chartType: params.visualization.chartType,
      nativeType: expectedNativeType,
      propertyVersion: VISUALIZATION_REGISTRY[params.visualization.chartType].qlikDevSpecVersion,
      previewReturnedRows: preview.preview.returnedRows,
      persistedReturnedRows: contract.firstPageRowCount,
      idempotentReplay: true,
      cleanup: params.retain ? 'retained' : 'cleanup-complete',
      objectIdSha256: objectHash(applied.objectId),
      ...(params.retain ? { operationId: applied.operationId } : {}),
    };

    if (params.retain) {
      writeManifest({
        version: 1,
        connection: params.target.connection,
        appId: params.target.appId,
        sheetId: params.target.sheetId,
        chartType: params.visualization.chartType,
        nativeType: expectedNativeType,
        objectId: applied.objectId,
        operationId: applied.operationId,
        objectIdSha256: evidence.objectIdSha256,
        baselineObjectCount: baseline.size,
        createdAt: new Date().toISOString(),
      });
      retained = true;
      return evidence;
    }

    const cleanup = await reporter.stage('cleanup', () =>
      params.adapter.cleanupObject({
        target: params.target,
        objectId: applied!.objectId,
        sheetAttachmentId: applied!.sheetAttachmentId,
      }),
    );
    if (cleanup.outcome !== 'cleanup-complete') {
      throw cloudLiveProbeError(
        'PERSISTED_OBJECT_VERIFICATION_FAILED',
        'cleanup',
        { cleanupConfirmed: false },
        'Exact-object cleanup was not confirmed.',
      );
    }
    const afterCleanup = await reporter.stage('discovery', () =>
      listAllSheetObjects(params.adapter, params.target, params.requester),
    );
    const cleanupChecks = {
      objectAbsent: !afterCleanup.has(applied.objectId),
      unrelatedObjectCountUnchanged: afterCleanup.size === baseline.size,
      exactBaselineRestored:
        afterCleanup.size === baseline.size &&
        [...baseline].every(([objectId, type]) => afterCleanup.get(objectId) === type),
    };
    reporter.debug('cleanup', cleanupChecks);
    if (Object.values(cleanupChecks).some((passed) => !passed)) {
      throw cloudLiveProbeError(
        'PERSISTED_OBJECT_VERIFICATION_FAILED',
        'cleanup',
        cleanupChecks,
        'Post-cleanup inventory did not return to its exact baseline.',
      );
    }
    applied = undefined;
    return evidence;
  } catch (error) {
    if (applied && !retained) {
      await preserveFailureAfterCleanup({
        primaryError: error,
        primaryCode: safeFailureCode(error),
        primaryStage: reporter.failureStage(error) ?? liveProbeStage(error),
        primaryDiagnostics: liveProbeDiagnostics(error),
        target: params.target,
        objectId: applied.objectId,
        sheetAttachmentId: applied.sheetAttachmentId,
        cleanup: (request) => params.adapter.cleanupObject(request),
      });
    }
    throw error;
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

async function cleanupRetained(
  adapter: CloudAdapter,
  target: Required<TargetRef>,
  actor: ActorContext,
): Promise<void> {
  const manifest = readManifest(target);
  const before = await reporter.stage('discovery', () =>
    listAllSheetObjects(adapter, target, actor),
  );
  if (before.get(manifest.objectId) !== manifest.nativeType) {
    throw cloudLiveProbeError(
      'PERSISTED_OBJECT_NOT_FOUND',
      'retained-discovery',
      { exactObjectAndTypeFound: false },
      'The exact retained object was not found for cleanup.',
    );
  }
  const cleanup = await reporter.stage('cleanup', () =>
    adapter.cleanupObject({
      target,
      objectId: manifest.objectId,
      sheetAttachmentId: manifest.objectId,
    }),
  );
  const after = await reporter.stage('discovery', () =>
    listAllSheetObjects(adapter, target, actor),
  );
  const checks = {
    cleanupConfirmed: cleanup.outcome === 'cleanup-complete',
    exactObjectAbsent: !after.has(manifest.objectId),
    objectCountDecrementedOnce: after.size + 1 === before.size,
  };
  reporter.debug('cleanup', checks);
  if (Object.values(checks).some((passed) => !passed)) {
    throw new RetainedObjectCleanupRequiredError(
      'PERSISTED_OBJECT_VERIFICATION_FAILED',
      'cleanup',
      target,
      manifest.objectId,
    );
  }
  rmSync(MANIFEST_PATH, { force: true });
  process.stdout.write(
    `${JSON.stringify({
      kind: 'cloud-native-matrix-result',
      status: 'passed',
      action: 'cleanup',
      chartType: manifest.chartType,
      nativeType: manifest.nativeType,
      objectIdSha256: manifest.objectIdSha256,
      cleanup: 'cleanup-complete',
      completedAt: new Date().toISOString(),
    })}\n`,
  );
}

async function reconcileMatrixObjects(
  adapter: CloudAdapter,
  target: Required<TargetRef>,
  requester: ActorContext,
  reviewer: ActorContext,
): Promise<void> {
  const before = await reporter.stage('discovery', () =>
    listAllSheetObjects(adapter, target, requester),
  );
  const stateDirectory = mkdtempSync(path.join(tmpdir(), 'qlik-cloud-matrix-reconcile-'));
  try {
    const { requesterService } = createServices(
      adapter,
      target,
      requester,
      reviewer,
      stateDirectory,
    );
    const plannedTargets = new Map<string, string>();
    for (const visualization of buildCases()) {
      const planned = await reporter.stage('compile', () =>
        requesterService.planVisualization(target.connection, target.appId, target.sheetId, {
          analysis: {
            dimensions: [...visualization.dimensions],
            measures: [...visualization.measures],
          },
          presentation: {
            preferredChartType: visualization.chartType,
            title: `Qlik AI Harness native ${visualization.chartType} verification`,
            topN: 10,
            ...(visualization.target !== undefined ? { target: visualization.target } : {}),
          },
          mode: 'preview-then-apply',
        }),
      );
      const objectId = `native-${planned.nativeChartType}-${planned.planHash.slice(7, 19)}`;
      if (!SAFE_IDENTIFIER.test(objectId) || !SAFE_IDENTIFIER.test(planned.nativeChartType)) {
        throw createError('INVALID_CHART_CONFIGURATION', {
          message: 'A matrix plan did not produce a bounded native object identity.',
        });
      }
      plannedTargets.set(objectId, planned.nativeChartType);
    }
    if (plannedTargets.size !== CHART_TYPE_IDS.length) {
      throw createError('INVALID_CHART_CONFIGURATION', {
        message: 'The matrix plans did not produce one distinct object identity per chart type.',
      });
    }

    const typeMismatches = [...plannedTargets].filter(
      ([objectId, expectedType]) => before.has(objectId) && before.get(objectId) !== expectedType,
    );
    if (typeMismatches.length > 0) {
      throw cloudLiveProbeError(
        'PERSISTED_OBJECT_CONTRACT_MISMATCH',
        'retained-contract',
        { deterministicIdentityTypeMismatches: typeMismatches.length },
        'A deterministic matrix object identity is attached with an unexpected native type.',
      );
    }

    const presentTargets = [...plannedTargets].filter(([objectId]) => before.has(objectId));
    for (const [objectId] of presentTargets) {
      const cleanup = await reporter.stage('cleanup', () =>
        adapter.cleanupObject({
          target,
          objectId,
          sheetAttachmentId: objectId,
        }),
      );
      if (cleanup.outcome !== 'cleanup-complete') {
        throw new RetainedObjectCleanupRequiredError(
          'PERSISTED_OBJECT_VERIFICATION_FAILED',
          'cleanup',
          target,
          objectId,
        );
      }
    }

    const after = await reporter.stage('discovery', () =>
      listAllSheetObjects(adapter, target, requester),
    );
    const unrelatedBaseline = new Map(
      [...before].filter(([objectId]) => !plannedTargets.has(objectId)),
    );
    const remainingTargets = [...plannedTargets].filter(([objectId]) => after.has(objectId));
    const removedTargets = presentTargets.filter(([objectId]) => !after.has(objectId));
    const newlyAppearedTargets = remainingTargets.filter(([objectId]) => !before.has(objectId));
    const unrelatedUnchanged =
      after.size === unrelatedBaseline.size &&
      [...unrelatedBaseline].every(([objectId, type]) => after.get(objectId) === type);
    const checks = {
      deterministicTargetCount: plannedTargets.size,
      removedTargetCount: removedTargets.length,
      newlyAppearedTargetCount: newlyAppearedTargets.length,
      allDeterministicTargetsAbsent: remainingTargets.length === 0,
      unrelatedObjectsUnchanged: unrelatedUnchanged,
    };
    reporter.debug('cleanup', checks);
    if (remainingTargets.length > 0 || !unrelatedUnchanged) {
      throw new RetainedObjectCleanupRequiredError(
        'PERSISTED_OBJECT_VERIFICATION_FAILED',
        'cleanup',
        target,
        remainingTargets[0]?.[0] ?? presentTargets[0]?.[0] ?? 'matrix-reconciliation',
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        kind: 'cloud-native-matrix-result',
        status: 'passed',
        action: 'reconcile',
        deterministicTargetCount: plannedTargets.size,
        removedTargetCount: removedTargets.length,
        newlyAppearedTargetCount: newlyAppearedTargets.length,
        removedObjectIdSha256: removedTargets.map(([objectId]) => objectHash(objectId)).sort(),
        unrelatedObjectCount: unrelatedBaseline.size,
        cleanup: 'cleanup-complete',
        completedAt: new Date().toISOString(),
      })}\n`,
    );
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const action = readAction();
  if (action === 'retain') assertRetainedManifestSlotAvailable(MANIFEST_PATH);
  const connection = requiredEnvironment('QLIK_CLOUD_CONNECTION_ALIAS');
  const target: Required<TargetRef> = {
    connection,
    appId: requiredEnvironment('QLIK_CLOUD_WRITE_APP_ID'),
    sheetId: requiredEnvironment('QLIK_CLOUD_WRITE_SHEET_ID'),
  };
  const requester: ActorContext = {
    actor: nonEmpty(process.env.QLIK_CLOUD_PROBE_ACTOR) ?? 'live-cloud-matrix-requester',
    hostClientId: 'live-cloud-matrix',
  };
  const reviewer: ActorContext = {
    actor: requiredEnvironment('QLIK_CLOUD_PROBE_REVIEWER'),
    hostClientId: 'live-cloud-matrix-reviewer',
  };
  if (requester.actor === reviewer.actor) throw createError('PERMISSION_DENIED');
  const adapter = createCloudRuntimeAdapter(runtimeEnvironment(), {
    clientSecrets: async (requestedConnection) => {
      if (requestedConnection !== connection) throw createError('NOT_CONFIGURED');
      return requiredEnvironment('QLIK_CLOUD_OAUTH_CLIENT_SECRET');
    },
  });
  if (!adapter) throw createError('NOT_CONFIGURED');

  const capabilities = await reporter.stage('readiness', () =>
    adapter.getEnvironmentCapabilities(connection),
  );
  if (
    !capabilities.configured ||
    !capabilities.canRead ||
    !capabilities.canPreview ||
    !capabilities.canWriteDesignatedSheet ||
    !capabilities.cleanupVerified
  ) {
    throw createError('NOT_CONFIGURED', {
      message: 'Current approved Cloud read, preview, write, and cleanup evidence is required.',
    });
  }
  if (action === 'cleanup') {
    await cleanupRetained(adapter, target, requester);
    return;
  }
  if (action === 'reconcile') {
    await reconcileMatrixObjects(adapter, target, requester, reviewer);
    return;
  }

  const selected = readSelectedChartType();
  if (action === 'retain' && !selected) {
    throw createError('NOT_CONFIGURED', {
      message: 'Retain mode requires one explicit QLIK_CLOUD_MATRIX_CHART_TYPE.',
    });
  }
  const cases = buildCases().filter((entry) => !selected || entry.chartType === selected);
  const evidence: MatrixCaseEvidence[] = [];
  for (const visualization of cases) {
    evidence.push(
      await runCase({
        adapter,
        target,
        requester,
        reviewer,
        visualization,
        retain: action === 'retain',
      }),
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      kind: 'cloud-native-matrix-result',
      status: action === 'retain' ? 'browser-evidence-required' : 'passed',
      action,
      supportedTypeCount: CHART_TYPE_IDS.length,
      testedTypeCount: evidence.length,
      cases: evidence,
      ...(action === 'retain' ? { retainedManifest: MANIFEST_PATH } : {}),
      completedAt: new Date().toISOString(),
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  const code = safeFailureCode(error);
  const stage = reporter.failureStage(error) ?? liveProbeStage(error);
  reporter.terminal(code, stage, {
    ...(error instanceof RetainedObjectCleanupRequiredError
      ? {
          primaryCode: error.primaryCode,
          cleanupAttempted: error.cleanupAttempted,
          cleanupSucceeded: error.cleanupSucceeded,
        }
      : {}),
    ...(error instanceof RetainedObjectFailureAfterConfirmedCleanupError
      ? {
          cleanupAttempted: error.cleanupAttempted,
          cleanupSucceeded: error.cleanupSucceeded,
        }
      : {}),
  });
  process.stderr.write(
    `${JSON.stringify({
      kind: 'cloud-native-matrix-result',
      status: 'failed',
      code,
      ...(stage ? { stage } : {}),
      ...(liveProbeDiagnostics(error) ? { diagnostics: liveProbeDiagnostics(error) } : {}),
      ...(error instanceof RetainedObjectCleanupRequiredError
        ? {
            primaryCode: error.primaryCode,
            ...(error.primaryStage ? { primaryStage: error.primaryStage } : {}),
            cleanupAttempted: error.cleanupAttempted,
            cleanupSucceeded: error.cleanupSucceeded,
            cleanupRequired: error.cleanupRequired,
          }
        : {}),
      ...(error instanceof RetainedObjectFailureAfterConfirmedCleanupError
        ? {
            cleanupAttempted: error.cleanupAttempted,
            cleanupSucceeded: error.cleanupSucceeded,
          }
        : {}),
    })}\n`,
  );
  process.exitCode = 1;
});
