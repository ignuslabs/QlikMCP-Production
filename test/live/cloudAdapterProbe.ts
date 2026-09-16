import 'dotenv/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileChartIntent } from '../../src/compiler/compiler.js';
import { createError, isHarnessError } from '../../src/domain/errors.js';
import type { ActorContext, TargetRef } from '../../src/domain/types.js';
import { createCloudRuntimeAdapter } from '../../src/adapters/cloud/cloudRuntime.js';
import type { CloudRuntimeEnvironment } from '../../src/adapters/cloud/cloudRuntime.js';
import { PolicyEngine } from '../../src/policy/policy.js';
import { FileApprovalStore } from '../../src/policy/approvalStore.js';
import { FileIdempotencyStore } from '../../src/policy/idempotencyStore.js';
import { FileOperationStore } from '../../src/policy/operationStore.js';
import { OperationService } from '../../src/server/operationService.js';
import {
  assertCloudTablePlan,
  assertUsableCloudPreviewLayoutAndDispose,
  CloudPreviewLayoutContractError,
  CLOUD_TABLE_NATIVE_TYPE,
  CLOUD_TABLE_SCHEMA_VERSION,
  CLOUD_VISUALIZATION_SCHEMA_PROFILE,
  hasNumberOrder,
  parseCloudProbeFieldLabel,
  summarizeCloudProbeInputContract,
} from './cloudTableContract.js';
import {
  preserveFailureAfterCleanup,
  RetainedObjectCleanupRequiredError,
  RetainedObjectFailureAfterConfirmedCleanupError,
} from './cloudProbeFailure.js';
import {
  cloudLiveProbeError,
  liveProbeDiagnostics,
  liveProbeStage,
} from './cloudProbeDiagnostics.js';
import { createCloudLiveReporter } from './cloudLiveLogging.js';

type ProbeGate = 'G4' | 'G5';

type G5PersistentLifecycle = {
  readonly approvedBySeparateActor: true;
  readonly created: true;
  readonly attached: true;
  readonly verified: true;
  readonly idempotentReplay: true;
  readonly cleanup: 'cleanup-complete' | 'retained';
  readonly retainedObject?: {
    readonly objectId: string;
    readonly objectType: string;
    readonly propertyVersion: string;
    readonly layoutType: string;
    readonly title: string;
  };
};

const MAX_DISCOVERY_PAGES = 100;
const DISCOVERY_PAGE_SIZE = 100;
const reporter = createCloudLiveReporter('readiness-probe');
const loggedStage = reporter.stage;

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function requiredEnvironment(name: string): string {
  const value = nonEmpty(process.env[name]);
  if (!value) {
    throw createError('NOT_CONFIGURED', {
      message: `The live Cloud probe requires the ${name} deployment setting.`,
    });
  }
  return value;
}

function readGate(): ProbeGate {
  const gate = nonEmpty(process.env.QLIK_CLOUD_LIVE_PROBE)?.toUpperCase();
  if (gate !== 'G4' && gate !== 'G5') {
    throw createError('NOT_CONFIGURED', {
      message: 'Explicitly set QLIK_CLOUD_LIVE_PROBE to G4 or G5 to run this live probe.',
    });
  }
  return gate;
}

function readRetainPersistentObject(gate: ProbeGate): boolean {
  const retain = nonEmpty(process.env.QLIK_CLOUD_LIVE_RETAIN_OBJECT);
  if (!retain) return false;
  if (gate !== 'G5' || retain !== 'true') {
    throw createError('NOT_CONFIGURED', {
      message:
        'Set QLIK_CLOUD_LIVE_RETAIN_OBJECT=true only with the explicit G5 retained-object probe.',
    });
  }
  return true;
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

async function assertTargetAppIsDiscoverable(
  adapter: NonNullable<ReturnType<typeof createCloudRuntimeAdapter>>,
  target: Required<TargetRef>,
  actor: ActorContext,
): Promise<number> {
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let pageIndex = 0; pageIndex < MAX_DISCOVERY_PAGES; pageIndex += 1) {
    const page = await adapter.listAccessibleApps(target.connection, actor, {
      pageSize: DISCOVERY_PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    });
    if (page.apps.some((app) => app.appId === target.appId)) return pageIndex + 1;
    if (!page.truncated || !page.nextPageToken) break;
    if (seenTokens.has(page.nextPageToken)) {
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'Cloud app discovery returned a repeated continuation token.',
      });
    }
    seenTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }

  throw createError('NOT_FOUND', {
    message: 'The designated Cloud probe app was not found within the bounded discovery scan.',
  });
}

async function assertRetainedObjectIsCloudTable(
  adapter: NonNullable<ReturnType<typeof createCloudRuntimeAdapter>>,
  target: Required<TargetRef>,
  actor: ActorContext,
  objectId: string,
): Promise<{ readonly type: string }> {
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let pageIndex = 0; pageIndex < MAX_DISCOVERY_PAGES; pageIndex += 1) {
    const page = await adapter.listSheetObjects(
      target.connection,
      target.appId,
      target.sheetId,
      actor,
      { pageSize: DISCOVERY_PAGE_SIZE, ...(pageToken ? { pageToken } : {}) },
    );
    const retainedObject = page.objects.find((object) => object.objectId === objectId);
    if (retainedObject) {
      if (retainedObject.type !== CLOUD_TABLE_NATIVE_TYPE) {
        throw cloudLiveProbeError(
          'PERSISTED_OBJECT_CONTRACT_MISMATCH',
          'retained-discovery',
          { objectFound: true, objectTypeMatches: false },
          'The retained Cloud object does not use the expected native type.',
        );
      }
      return { type: retainedObject.type };
    }
    if (!page.truncated || !page.nextPageToken) break;
    if (seenTokens.has(page.nextPageToken)) {
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'Cloud sheet-object discovery returned a repeated continuation token.',
      });
    }
    seenTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }

  throw cloudLiveProbeError(
    'PERSISTED_OBJECT_NOT_FOUND',
    'retained-discovery',
    { objectFound: false },
    'The retained Cloud object was not found in the bounded sheet-object scan.',
  );
}

function safeFailureCode(error: unknown): string {
  if (isHarnessError(error)) return error.code;
  if (error && typeof error === 'object') {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  }
  return 'LIVE_CLOUD_PROBE_FAILED';
}

async function executeGovernedG5Workflow(params: {
  readonly adapter: NonNullable<ReturnType<typeof createCloudRuntimeAdapter>>;
  readonly target: Required<TargetRef>;
  readonly requester: ActorContext;
  readonly reviewer: ActorContext;
  readonly dimensionLabel: string;
  readonly measureLabel: string;
  readonly retainPersistentObject: boolean;
  readonly chartTitle: string;
}): Promise<G5PersistentLifecycle> {
  if (params.requester.actor === params.reviewer.actor) {
    throw createError('PERMISSION_DENIED', {
      message: 'The live Cloud G5 requester and reviewer must be distinct actors.',
    });
  }
  const stateDirectory = mkdtempSync(path.join(tmpdir(), 'qlik-cloud-g5-'));
  const approvalPath = path.join(stateDirectory, 'approvals.json');
  const idempotencyPath = path.join(stateDirectory, 'idempotency.json');
  const operationPath = path.join(stateDirectory, 'operations.json');
  const policyConfig = {
    allowedEnvironments: ['development'],
    connections: {
      [params.target.connection]: {
        alias: params.target.connection,
        platform: 'cloud' as const,
        visualizationSchemaProfile: CLOUD_VISUALIZATION_SCHEMA_PROFILE,
        environment: 'development',
        allowedApps: { [params.target.appId]: [params.target.sheetId] },
        allowedChartTypes: ['table' as const],
      },
    },
    mutationActors: new Set([params.requester.actor]),
    reviewerActors: new Set([params.reviewer.actor]),
  };
  const requesterService = new OperationService({
    actor: params.requester,
    adapters: { cloud: params.adapter },
    policy: new PolicyEngine(policyConfig),
    approvals: new FileApprovalStore(approvalPath),
    idempotency: new FileIdempotencyStore(idempotencyPath),
    operations: new FileOperationStore(operationPath),
  });
  let applied: Awaited<ReturnType<OperationService['applyVisualization']>> | undefined;
  let retainedObject = false;
  try {
    const planned = await loggedStage('compile', () =>
      requesterService.planVisualization(
        params.target.connection,
        params.target.appId,
        params.target.sheetId,
        {
          analysis: {
            dimensions: [params.dimensionLabel],
            measures: [params.measureLabel],
          },
          presentation: {
            preferredChartType: 'table',
            title: params.chartTitle,
            topN: 10,
          },
          mode: 'preview-then-apply',
        },
      ),
    );
    if (planned.nativeChartType !== CLOUD_TABLE_NATIVE_TYPE) {
      throw createError('INVALID_CHART_CONFIGURATION', {
        message: 'The governed Cloud G5 plan did not resolve to sn-table.',
      });
    }
    const pending = await loggedStage('approval', () =>
      requesterService.requestApproval(planned.planHash, 'Live non-production G5 readiness probe'),
    );
    const reviewerService = new OperationService({
      actor: params.reviewer,
      adapters: { cloud: params.adapter },
      policy: new PolicyEngine(policyConfig),
      approvals: new FileApprovalStore(approvalPath),
      idempotency: new FileIdempotencyStore(idempotencyPath),
      operations: new FileOperationStore(operationPath),
    });
    const review = await reviewerService.getApprovalRequest(pending.requestId);
    if (
      review.planHash !== planned.planHash ||
      review.chartType !== 'table' ||
      review.resolvedSummary.dimensions[0] !== params.dimensionLabel ||
      review.resolvedSummary.measures[0] !== params.measureLabel
    ) {
      throw createError('APPROVAL_PLAN_HASH_MISMATCH');
    }
    const approval = await loggedStage('approval', () =>
      reviewerService.approveApproval(pending.requestId),
    );
    const idempotencyKey = `live-cloud-g5-${planned.planHash}`;
    applied = await loggedStage('persist', () =>
      requesterService.applyVisualization(planned.planHash, approval.approvalToken, idempotencyKey),
    );
    const replay = await loggedStage('replay', () =>
      requesterService.applyVisualization(planned.planHash, approval.approvalToken, idempotencyKey),
    );
    if (replay.objectId !== applied.objectId || replay.operationId !== applied.operationId) {
      throw createError('IDEMPOTENCY_CONFLICT');
    }
    if (params.retainPersistentObject) {
      const reopenedAttachment = await loggedStage('retained-attachment', () =>
        params.adapter.attachChartToSheet({
          target: params.target,
          objectId: applied!.objectId,
        }),
      );
      if (reopenedAttachment.sheetAttachmentId !== applied.objectId) {
        throw cloudLiveProbeError(
          'PERSISTED_OBJECT_VERIFICATION_FAILED',
          'retained-attachment',
          { attachmentIdMatches: false },
          'The reopened object attachment does not match the persisted object.',
        );
      }
      const reopenedVerification = await loggedStage('retained-verification', () =>
        params.adapter.verifyChart({
          target: params.target,
          objectId: applied!.objectId,
        }),
      );
      if (!reopenedVerification.verified) {
        throw cloudLiveProbeError(
          'PERSISTED_OBJECT_VERIFICATION_FAILED',
          'retained-verification',
          { attachmentIdMatches: true, reopenedVerificationPassed: false },
          'The reopened object did not pass persistent verification.',
        );
      }
      const observedRetainedObject = await loggedStage('retained-discovery', () =>
        assertRetainedObjectIsCloudTable(
          params.adapter,
          params.target,
          params.requester,
          applied!.objectId,
        ),
      );
      const retainedContract = await loggedStage('retained-contract', () =>
        params.adapter.inspectVisualizationContract(
          params.target.connection,
          params.target.appId,
          applied!.objectId,
        ),
      );
      const retainedChecks = {
        propertyNativeKindMatches: retainedContract.propertyType === CLOUD_TABLE_NATIVE_TYPE,
        propertyVersionMatches: retainedContract.propertyVersion === CLOUD_TABLE_SCHEMA_VERSION,
        rootSortingAbsent: !retainedContract.hasRootSorting,
        columnOrderMatches: hasNumberOrder(retainedContract.qColumnOrder, [0, 1]),
        interColumnSortOrderMatches: hasNumberOrder(retainedContract.qInterColumnSortOrder, [1, 0]),
        propertyDimensionCountMatches: retainedContract.propertyDimensionCount === 1,
        propertyMeasureCountMatches: retainedContract.propertyMeasureCount === 1,
        layoutNativeKindMatches: retainedContract.layoutType === CLOUD_TABLE_NATIVE_TYPE,
        layoutVisualizationMatches:
          retainedContract.layoutVisualization === CLOUD_TABLE_NATIVE_TYPE,
        layoutDimensionInfoCountMatches: retainedContract.layoutDimensionInfoCount === 1,
        layoutMeasureInfoCountMatches: retainedContract.layoutMeasureInfoCount === 1,
        cubeColumnCountMatches: retainedContract.cubeColumnCount === 2,
        cubeRowCountPositive: (retainedContract.cubeRowCount ?? 0) > 0,
        firstPageRowPresent: retainedContract.firstPageRowCount > 0,
        fullWidthRowPresent: retainedContract.fullWidthRowCount > 0,
        usableMeasureRowPresent: retainedContract.usableMeasureRowCount > 0,
        layoutErrorAbsent: !retainedContract.hasLayoutError,
      };
      if (Object.values(retainedChecks).some((passed) => !passed)) {
        throw cloudLiveProbeError(
          'PERSISTED_OBJECT_CONTRACT_MISMATCH',
          'retained-contract',
          retainedChecks,
          'The reopened retained object does not match the pinned native contract.',
        );
      }
      retainedObject = true;
      return {
        approvedBySeparateActor: true,
        created: true,
        attached: true,
        verified: true,
        idempotentReplay: true,
        cleanup: 'retained',
        retainedObject: {
          objectId: applied.objectId,
          objectType: observedRetainedObject.type,
          propertyVersion: retainedContract.propertyVersion!,
          layoutType: retainedContract.layoutType!,
          title: params.chartTitle,
        },
      };
    }
    const cleanup = await loggedStage('cleanup', () =>
      params.adapter.cleanupObject({
        target: params.target,
        objectId: applied!.objectId,
        sheetAttachmentId: applied!.sheetAttachmentId,
      }),
    );
    if (cleanup.outcome !== 'cleanup-complete') {
      throw createError('PARTIAL_APPLY');
    }
    return {
      approvedBySeparateActor: true,
      created: true,
      attached: true,
      verified: true,
      idempotentReplay: true,
      cleanup: 'cleanup-complete',
    };
  } catch (error) {
    if (applied && !retainedObject) {
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

async function main(): Promise<void> {
  const { gate, retainPersistentObject, connection, appId, sheetId } = await loggedStage(
    'configuration',
    () => {
      const configuredGate = readGate();
      return {
        gate: configuredGate,
        retainPersistentObject: readRetainPersistentObject(configuredGate),
        connection: requiredEnvironment('QLIK_CLOUD_CONNECTION_ALIAS'),
        appId: requiredEnvironment('QLIK_CLOUD_WRITE_APP_ID'),
        sheetId: requiredEnvironment('QLIK_CLOUD_WRITE_SHEET_ID'),
      };
    },
    (configured) => ({ gate: configured.gate, retain: configured.retainPersistentObject }),
  );
  const dimensionInput = parseCloudProbeFieldLabel(
    'dimension',
    process.env.QLIK_CLOUD_PROBE_DIMENSION,
  );
  const measureInput = parseCloudProbeFieldLabel('measure', process.env.QLIK_CLOUD_PROBE_MEASURE);
  const dimensionLabel = dimensionInput.value;
  const measureLabel = measureInput.value;
  const target: Required<TargetRef> = { connection, appId, sheetId };
  const actor: ActorContext = {
    actor: nonEmpty(process.env.QLIK_CLOUD_PROBE_ACTOR) ?? 'live-cloud-probe',
    hostClientId: 'live-cloud-probe',
  };

  const adapter = createCloudRuntimeAdapter(runtimeEnvironment(), {
    clientSecrets: async (requestedConnection) => {
      if (requestedConnection !== connection) throw createError('NOT_CONFIGURED');
      return requiredEnvironment('QLIK_CLOUD_OAUTH_CLIENT_SECRET');
    },
  });
  if (!adapter) throw createError('NOT_CONFIGURED');

  const capabilities = await loggedStage(
    'readiness',
    () => adapter.getEnvironmentCapabilities(connection),
    (result) => ({
      configured: result.configured,
      canRead: result.canRead,
      canPreview: result.canPreview,
      canWrite: result.canWriteDesignatedSheet,
      cleanupVerified: result.cleanupVerified,
    }),
  );
  if (!capabilities.configured || !capabilities.canRead || !capabilities.canPreview) {
    throw createError('NOT_CONFIGURED', {
      message: 'Current approved Cloud G4 readiness evidence is required for this live probe.',
    });
  }
  if (gate === 'G5' && (!capabilities.canWriteDesignatedSheet || !capabilities.cleanupVerified)) {
    throw createError('NOT_CONFIGURED', {
      message: 'Current approved Cloud write and cleanup evidence is required for the G5 probe.',
    });
  }

  const discoveryPages = await loggedStage('discovery', () =>
    assertTargetAppIsDiscoverable(adapter, target, actor),
  );
  const compilation = await loggedStage('catalog', () =>
    adapter.getCompilationContext(connection, appId, actor),
  );
  const semanticPage = await loggedStage('catalog', () =>
    adapter.getSemanticCatalog(connection, appId, actor, 'default', { pageSize: 100 }),
  );
  if (!compilation.sheets.some((sheet) => sheet.sheetId === sheetId)) {
    throw createError('NOT_FOUND', {
      message: 'The designated Cloud probe sheet was not found in the app catalog.',
    });
  }
  const sheetObjects = await adapter.listSheetObjects(connection, appId, sheetId, actor, {
    pageSize: 100,
  });

  const plan = await loggedStage('compile', () =>
    compileChartIntent({
      catalog: compilation.catalog,
      target,
      platform: 'cloud',
      visualizationSchemaProfile: CLOUD_VISUALIZATION_SCHEMA_PROFILE,
      intent: {
        analysis: { dimensions: [dimensionLabel], measures: [measureLabel] },
        presentation: {
          preferredChartType: 'table',
          title: 'Qlik AI Harness live readiness probe',
          topN: 10,
        },
        mode: gate === 'G5' ? 'preview-then-apply' : 'preview',
      },
    }),
  );
  assertCloudTablePlan(plan);
  const inputContract = summarizeCloudProbeInputContract(plan, dimensionInput, measureInput);

  const previewController = new AbortController();
  const preview = await loggedStage('preview-create', () =>
    adapter.createSessionChart({ target, plan, actor, signal: previewController.signal }),
  );
  const previewDiagnostics = await loggedStage(
    'preview-validate',
    () =>
      assertUsableCloudPreviewLayoutAndDispose({
        plan,
        preview,
        inputContract,
        dispose: () => adapter.disposeSessionChart(connection, preview.sessionObjectId),
      }),
    (diagnostics) => ({ passed: diagnostics.passed, ...diagnostics.checks }),
  );

  let persistentLifecycle: G5PersistentLifecycle | undefined;

  if (gate === 'G5') {
    const chartTitle = retainPersistentObject
      ? `Qlik AI Harness retained G5 probe ${new Date().toISOString()}`
      : 'Qlik AI Harness governed G5 probe';
    persistentLifecycle = await executeGovernedG5Workflow({
      adapter,
      target,
      requester: actor,
      reviewer: {
        actor: requiredEnvironment('QLIK_CLOUD_PROBE_REVIEWER'),
        hostClientId: 'live-cloud-reviewer',
      },
      dimensionLabel,
      measureLabel,
      retainPersistentObject,
      chartTitle,
    });
  }

  process.stdout.write(
    `${JSON.stringify({
      status: gate === 'G5' ? 'workflow-component-passed' : 'passed',
      gate,
      fullGatePassed: gate === 'G4',
      connection,
      target: { appId, sheetId },
      appDiscovered: true,
      discoveryPages,
      catalog: {
        visibleFieldCount: compilation.catalog.fields.length,
        visibleMasterItemCount: compilation.catalog.masterItems.length,
        sheetCount: compilation.sheets.length,
        firstPageTruncated: semanticPage.truncated,
      },
      sheetObjects: {
        firstPageCount: sheetObjects.objects.length,
        firstPageTruncated: sheetObjects.truncated,
      },
      inputContract,
      preview: {
        evaluated: true,
        objectType: preview.layout.objectType,
        returnedRows: preview.layout.bounded.returnedRows,
        disposedOnOwningSession: true,
        layoutDiagnostics: previewDiagnostics,
      },
      visualizationSchema: {
        logicalChartType: plan.chartType,
        profile: plan.visualizationSchemaProfile,
        version: plan.visualizationSchemaVersion,
        qlikInAppVisualizationId: plan.nativeChartType,
      },
      ...(persistentLifecycle ? { persistentLifecycle } : {}),
      ...(persistentLifecycle?.retainedObject
        ? {
            retainedObject: {
              appId,
              sheetId,
              ...persistentLifecycle.retainedObject,
            },
          }
        : {}),
      ...(gate === 'G5' ? { remainingRequiredCheck: 'live-qlik-embed-browser-smoke' } : {}),
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
          ...(error.primaryStage ? { primaryStage: error.primaryStage } : {}),
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
      kind: 'live-probe-result',
      status: 'failed',
      code,
      ...(stage ? { stage } : {}),
      ...(liveProbeDiagnostics(error) ? { diagnostics: liveProbeDiagnostics(error) } : {}),
      ...(error instanceof CloudPreviewLayoutContractError
        ? { layoutDiagnostics: error.diagnostics }
        : {}),
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
