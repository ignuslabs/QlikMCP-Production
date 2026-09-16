/**
 * Explicit live G6 probe. This file intentionally does not match Vitest's `*.test.ts` pattern.
 * Run only after platform-administrator evidence is available:
 *
 *   npx tsx test/live/windowsG6.live.ts
 *
 * The process fails closed when any required flag, target, readiness input, or secret is absent.
 * It never prints target identifiers, hosts, credentials, SDK errors, or provider response bodies.
 */
import { EnvironmentWindowsSecretProvider } from '../../src/adapters/windows/environmentWindowsSecretProvider.js';
import { QlikWindowsEngineSessionFactory } from '../../src/adapters/windows/qlikWindowsEngineSession.js';
import { WindowsAdapter } from '../../src/adapters/windows/windowsAdapter.js';
import { chartIntentSchema } from '../../src/compiler/chartIntentSchema.js';
import { compileChartIntent } from '../../src/compiler/compiler.js';
import { isHarnessError } from '../../src/domain/errors.js';
import type { ActorContext, ResolvedChartPlan } from '../../src/domain/types.js';
import type { AppSummary } from '../../src/adapters/targetAdapter.js';
import type { CatalogDefinition } from '../../src/catalog/catalogTypes.js';

const MAX_DISCOVERY_PAGES = 100;
const PAGE_SIZE = 100;

class LiveProbeError extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
    this.name = 'LiveProbeError';
  }
}

interface LiveProbeConfig {
  readonly connection: string;
  readonly serverAlias: string;
  readonly virtualProxyAlias?: string;
  readonly authMode: 'proxy-session' | 'trusted-backend';
  readonly discoveryAppId: string;
  readonly appId: string;
  readonly sheetId: string;
  readonly readinessExpiresAt: string;
  readonly actor: ActorContext;
  readonly executeWrite: boolean;
}

interface ProbeOutcome {
  readonly discoveredApps: number;
  readonly catalogFields: number;
  readonly catalogMasterItems: number;
  readonly sheetObjectsObserved: number;
  readonly previewReturnedRows: number;
  readonly previewDisposed: true;
  readonly writeExecuted: boolean;
  readonly writeVerified: boolean;
  readonly cleanupVerified: boolean;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new LiveProbeError(`CONFIG_MISSING_${name}`);
  return value;
}

function requiredFlag(name: string): void {
  if (requiredEnvironment(name) !== '1') {
    throw new LiveProbeError(`CONFIG_FLAG_${name}_MUST_EQUAL_1`);
  }
}

function requiredTrue(name: string): void {
  if (requiredEnvironment(name).toLowerCase() !== 'true') {
    throw new LiveProbeError(`CONFIG_FLAG_${name}_MUST_EQUAL_TRUE`);
  }
}

function optionalBooleanFlag(name: string): boolean {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new LiveProbeError(`CONFIG_FLAG_${name}_MUST_EQUAL_0_OR_1`);
}

function loadConfig(): LiveProbeConfig {
  requiredFlag('QLIK_WINDOWS_LIVE_G6');
  requiredFlag('QLIK_WINDOWS_TLS_TRUST_CONFIRMED');
  requiredTrue('QLIK_WINDOWS_READINESS_APPROVED');
  requiredTrue('QLIK_WINDOWS_READINESS_CAN_READ');
  requiredTrue('QLIK_WINDOWS_READINESS_CAN_PREVIEW');
  requiredEnvironment('QLIK_WINDOWS_ADMIN_EVIDENCE_REF');
  const executeWrite = optionalBooleanFlag('QLIK_WINDOWS_LIVE_ALLOW_WRITE');
  if (executeWrite) {
    requiredTrue('QLIK_WINDOWS_READINESS_CAN_WRITE_DESIGNATED_SHEET');
    requiredTrue('QLIK_WINDOWS_READINESS_CLEANUP_VERIFIED');
  }
  const authModeValue = requiredEnvironment('QLIK_WINDOWS_AUTH_MODE');
  if (authModeValue !== 'proxy-session' && authModeValue !== 'trusted-backend') {
    throw new LiveProbeError('CONFIG_INVALID_QLIK_WINDOWS_AUTH_MODE');
  }
  const readinessExpiresAt = requiredEnvironment('QLIK_WINDOWS_READINESS_EXPIRES_AT');
  const expiresAt = Date.parse(readinessExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new LiveProbeError('CONFIG_WINDOWS_READINESS_EXPIRED');
  }
  const virtualProxyAlias = process.env.QLIK_WINDOWS_VIRTUAL_PROXY_ALIAS?.trim();
  if (authModeValue === 'proxy-session' && !virtualProxyAlias) {
    throw new LiveProbeError('CONFIG_MISSING_QLIK_WINDOWS_VIRTUAL_PROXY_ALIAS');
  }
  if (authModeValue === 'trusted-backend' && virtualProxyAlias) {
    throw new LiveProbeError('CONFIG_TRUSTED_BACKEND_CANNOT_USE_VIRTUAL_PROXY');
  }
  return {
    connection: requiredEnvironment('QLIK_WINDOWS_CONNECTION_ALIAS'),
    serverAlias: requiredEnvironment('QLIK_WINDOWS_SERVER_ALIAS'),
    ...(virtualProxyAlias ? { virtualProxyAlias } : {}),
    authMode: authModeValue,
    discoveryAppId: requiredEnvironment('QLIK_WINDOWS_DISCOVERY_APP_ID'),
    appId: requiredEnvironment('QLIK_WINDOWS_WRITE_APP_ID'),
    sheetId: requiredEnvironment('QLIK_WINDOWS_WRITE_SHEET_ID'),
    readinessExpiresAt,
    actor: {
      actor: requiredEnvironment('QLIK_WINDOWS_LIVE_ACTOR'),
      hostClientId: requiredEnvironment('QLIK_WINDOWS_LIVE_HOST_CLIENT_ID'),
    },
    executeWrite,
  };
}

function uniqueCatalogLabel(catalog: CatalogDefinition, role: 'dimension' | 'measure'): string {
  const master = catalog.masterItems.find(
    (candidate) =>
      candidate.kind === role &&
      catalog.masterItems.filter((item) => item.label === candidate.label).length === 1,
  );
  if (master) return master.label;
  const candidates = catalog.fields.filter((field) => field.role === role);
  const match = candidates.find(
    (candidate) =>
      catalog.fields.filter((field) => field.label === candidate.label).length === 1 &&
      !catalog.masterItems.some((item) => item.label === candidate.label),
  );
  if (!match) throw new LiveProbeError(`CATALOG_HAS_NO_UNIQUE_${role.toUpperCase()}_FIELD`);
  return match.label;
}

function buildProbePlan(
  catalog: CatalogDefinition,
  target: { readonly connection: string; readonly appId: string; readonly sheetId: string },
): ResolvedChartPlan {
  const intent = chartIntentSchema.parse({
    analysis: {
      dimensions: [uniqueCatalogLabel(catalog, 'dimension')],
      measures: [uniqueCatalogLabel(catalog, 'measure')],
    },
    presentation: {
      preferredChartType: 'bar',
      title: 'G6 governed adapter probe',
      topN: 5,
    },
    mode: 'preview',
  });
  return compileChartIntent({ catalog, target, platform: 'windows', intent });
}

async function listAllApps(
  adapter: WindowsAdapter,
  config: LiveProbeConfig,
): Promise<AppSummary[]> {
  const apps: AppSummary[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
    const result = await adapter.listAccessibleApps(config.connection, config.actor, {
      pageSize: PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    });
    apps.push(...result.apps);
    if (!result.nextPageToken) return apps;
    pageToken = result.nextPageToken;
  }
  throw new LiveProbeError('DISCOVERY_PAGE_BOUND_EXCEEDED');
}

async function executeOptionalWrite(
  adapter: WindowsAdapter,
  config: LiveProbeConfig,
  target: { readonly connection: string; readonly appId: string; readonly sheetId: string },
  plan: ResolvedChartPlan,
): Promise<{ readonly verified: boolean; readonly cleanupVerified: boolean }> {
  if (!config.executeWrite) return { verified: false, cleanupVerified: false };
  let objectId: string | undefined;
  let sheetAttachmentId: string | undefined;
  let verified = false;
  let primaryFailure: unknown;
  let cleanupVerified = false;
  try {
    const persisted = await adapter.persistChart({
      target,
      plan,
      actor: config.actor,
      idempotencyKey: `g6-live-${plan.planHash}`,
    });
    objectId = persisted.objectId;
    const attached = await adapter.attachChartToSheet({ target, objectId });
    sheetAttachmentId = attached.sheetAttachmentId;
    verified = (await adapter.verifyChart({ target, objectId })).verified;
    if (!verified) throw new LiveProbeError('PERSISTED_OBJECT_VERIFICATION_FAILED');
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (objectId) {
      const cleanup = await adapter.cleanupObject({
        target,
        objectId,
        ...(sheetAttachmentId ? { sheetAttachmentId } : {}),
      });
      cleanupVerified = cleanup.outcome === 'cleanup-complete';
    }
  }
  if (!cleanupVerified) throw new LiveProbeError('PERSISTED_OBJECT_CLEANUP_FAILED');
  if (primaryFailure) throw primaryFailure;
  if (sheetAttachmentId) {
    const afterCleanup = await adapter.listSheetObjects(
      config.connection,
      config.appId,
      config.sheetId,
      config.actor,
      { pageSize: PAGE_SIZE },
    );
    if (afterCleanup.objects.some((object) => object.objectId === sheetAttachmentId)) {
      throw new LiveProbeError('SHEET_CHILD_REMAINS_AFTER_CLEANUP');
    }
  }
  return { verified, cleanupVerified };
}

async function runProbe(): Promise<ProbeOutcome> {
  const config = loadConfig();
  const target = {
    connection: config.connection,
    appId: config.appId,
    sheetId: config.sheetId,
  };
  const adapter = new WindowsAdapter(
    {
      connection: config.connection,
      serverAlias: config.serverAlias,
      ...(config.virtualProxyAlias ? { virtualProxyAlias: config.virtualProxyAlias } : {}),
      authMode: config.authMode,
      discoveryAppId: config.discoveryAppId,
      writeTarget: target,
      readiness: {
        approved: true,
        expiresAt: config.readinessExpiresAt,
        canRead: true,
        canPreview: true,
        canWriteDesignatedSheet: config.executeWrite,
        cleanupVerified: config.executeWrite,
      },
    },
    {
      secrets: new EnvironmentWindowsSecretProvider({ connection: config.connection }),
      sessions: new QlikWindowsEngineSessionFactory(),
    },
  );
  const capabilities = await adapter.getEnvironmentCapabilities(config.connection);
  if (!capabilities.configured || !capabilities.canRead || !capabilities.canPreview) {
    throw new LiveProbeError('CAPABILITY_PROBE_FAILED');
  }
  const apps = await listAllApps(adapter, config);
  if (!apps.some((app) => app.appId === config.appId)) {
    throw new LiveProbeError('DESIGNATED_APP_NOT_DISCOVERABLE');
  }
  const context = await adapter.getCompilationContext(
    config.connection,
    config.appId,
    config.actor,
  );
  if (!context.sheets.some((sheet) => sheet.sheetId === config.sheetId)) {
    throw new LiveProbeError('DESIGNATED_SHEET_NOT_DISCOVERABLE');
  }
  await adapter.getSemanticCatalog(config.connection, config.appId, config.actor, 'default', {
    pageSize: PAGE_SIZE,
  });
  const sheetObjects = await adapter.listSheetObjects(
    config.connection,
    config.appId,
    config.sheetId,
    config.actor,
    { pageSize: PAGE_SIZE },
  );
  const plan = buildProbePlan(context.catalog, target);
  const previewController = new AbortController();
  const previewTimeout = setTimeout(() => previewController.abort(), 30_000);
  let sessionObjectId: string | undefined;
  let previewReturnedRows: number | undefined;
  try {
    const preview = await adapter.createSessionChart({
      target,
      plan,
      actor: config.actor,
      signal: previewController.signal,
    });
    sessionObjectId = preview.sessionObjectId;
    previewReturnedRows = preview.layout.bounded.returnedRows;
    if (previewReturnedRows > preview.layout.bounded.maxRows) {
      throw new LiveProbeError('PREVIEW_ROW_BOUND_EXCEEDED');
    }
  } finally {
    clearTimeout(previewTimeout);
    if (sessionObjectId) {
      await adapter.disposeSessionChart(config.connection, sessionObjectId);
    }
  }
  if (!sessionObjectId || previewReturnedRows === undefined) {
    throw new LiveProbeError('PREVIEW_SESSION_NOT_CREATED');
  }
  const write = await executeOptionalWrite(adapter, config, target, plan);
  return {
    discoveredApps: apps.length,
    catalogFields: context.catalog.fields.length,
    catalogMasterItems: context.catalog.masterItems.length,
    sheetObjectsObserved: sheetObjects.objects.length,
    previewReturnedRows,
    previewDisposed: true,
    writeExecuted: config.executeWrite,
    writeVerified: write.verified,
    cleanupVerified: write.cleanupVerified,
  };
}

function safeFailureCode(error: unknown): string {
  if (error instanceof LiveProbeError) return error.safeCode;
  if (isHarnessError(error)) return error.code;
  return 'UNEXPECTED_FAILURE';
}

void runProbe()
  .then((outcome) => {
    process.stdout.write(
      `${JSON.stringify({ gate: 'G6', status: 'passed', live: true, ...outcome })}\n`,
    );
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ gate: 'G6', status: 'failed', live: true, code: safeFailureCode(error) })}\n`,
    );
    process.exitCode = 1;
  });
