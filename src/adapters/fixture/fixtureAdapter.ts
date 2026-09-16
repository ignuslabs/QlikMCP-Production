import { createHash } from 'node:crypto';
import {
  assertSheetPlacement,
  containsProperties,
  placementsOverlap,
  samePlacement,
} from '../sheetLayout.js';
import { createError, type TypedFailureCode } from '../../domain/errors.js';
import { generateObjectId } from '../../domain/ids.js';
import { resolveFieldCardinality } from '../../catalog/cardinality.js';
import { FixtureRepository, assertCatalogNotEmpty } from './fixtureRepository.js';
import { buildDeterministicLayout } from './sampleData.js';
import type {
  EnsureSheetRequest,
  EnsureSheetResult,
  VerifySheetRequest,
  VerifySheetResult,
  SheetPlacement,
  SheetSummary,
  AppSummary,
  AttachChartRequest,
  AttachChartResult,
  CapabilityProbeResult,
  CatalogResult,
  CleanupRequest,
  CleanupResult,
  CreateSessionChartRequest,
  CreateSessionChartResult,
  ListAppsResult,
  ListSheetObjectsResult,
  PageRequest,
  PersistChartRequest,
  PersistChartResult,
  SheetObjectSummary,
  TargetAdapter,
  VerifyChartRequest,
  VerifyChartResult,
} from '../targetAdapter.js';
import type {
  ActorContext,
  ConnectionAlias,
  PlatformId,
  RenderDescriptor,
  TargetRef,
} from '../../domain/types.js';
import type { CatalogVariant } from '../../catalog/catalogTypes.js';

/**
 * A scripted, one-shot (by default) failure a test can queue for a specific
 * adapter method. This is the fixture-safe adapter's only "test hook"; it is
 * never reachable through an MCP tool schema and Cloud/Windows adapters have
 * no equivalent (their failures come from never being configured).
 */
export interface ScheduledFault {
  readonly method:
    | 'listAccessibleApps'
    | 'getSemanticCatalog'
    | 'listSheetObjects'
    | 'createSessionChart'
    | 'ensureSheet'
    | 'verifySheet'
    | 'persistChart'
    | 'attachChartToSheet'
    | 'verifyChart';
  readonly errorCode: TypedFailureCode;
  readonly retryAfterSeconds?: number;
  timesRemaining?: number;
}

export interface FixtureAdapterOptions {
  readonly fixturesDir?: string;
  readonly faults?: ScheduledFault[];
}

interface PersistedObjectRecord {
  readonly target: Required<TargetRef>;
  readonly nativeChartType: string;
  readonly title: string;
  readonly planProperties: Readonly<Record<string, unknown>>;
  readonly placement?: SheetPlacement;
  sheetAttachmentId?: string;
}

/**
 * The deterministic, in-memory, fixture-safe `TargetAdapter`. It loads the
 * shared read-only fixture contract from `test/fixtures/catalog.json` and
 * simulates the full create -> attach -> verify -> cleanup lifecycle purely
 * in memory. It is the only adapter whose mutation path can actually run in
 * this repository, and only against the two development connection aliases
 * (`cloud-dev`, `windows-dev`) defined by that fixture.
 */
export class FixtureAdapter implements TargetAdapter {
  readonly platform: PlatformId = 'fixture';

  private readonly repo: FixtureRepository;
  private readonly faults: ScheduledFault[];
  private readonly sessionObjects = new Map<string, Required<TargetRef>>();
  private readonly persistedObjects = new Map<string, PersistedObjectRecord>();
  private readonly generatedSheets = new Map<
    string,
    {
      readonly target: Required<TargetRef>;
      readonly title: string;
      readonly fingerprint: string;
      readonly actor: ActorContext;
    }
  >();

  constructor(options: FixtureAdapterOptions = {}) {
    this.repo = new FixtureRepository(options.fixturesDir);
    this.faults = options.faults ? [...options.faults] : [];
  }

  private sheetKey(target: Required<TargetRef>): string {
    return JSON.stringify([target.connection, target.appId, target.sheetId]);
  }

  private assertSheet(connection: string, appId: string, sheetId: string): void {
    this.repo.assertApp(connection, appId);
    if (!this.generatedSheets.has(this.sheetKey({ connection, appId, sheetId })))
      this.repo.assertSheet(connection, appId, sheetId);
  }

  private sheetSummaries(connection: string, appId: string): readonly SheetSummary[] {
    const target = this.repo.assertApp(connection, appId);
    return [
      ...target.sheets.map((sheet) => ({
        sheetId: sheet.id,
        name: sheet.name,
        writeAllowed: sheet.writeAllowed,
      })),
      ...[...this.generatedSheets.values()]
        .filter((sheet) => sheet.target.connection === connection && sheet.target.appId === appId)
        .map((sheet) => ({ sheetId: sheet.target.sheetId, name: sheet.title, writeAllowed: true })),
    ];
  }

  private consumeFault(method: ScheduledFault['method']): void {
    const index = this.faults.findIndex((fault) => fault.method === method);
    if (index === -1) {
      return;
    }
    const fault = this.faults[index]!;
    const remaining = (fault.timesRemaining ?? 1) - 1;
    if (remaining <= 0) {
      this.faults.splice(index, 1);
    } else {
      this.faults[index] = { ...fault, timesRemaining: remaining };
    }
    throw createError(
      fault.errorCode,
      fault.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: fault.retryAfterSeconds }
        : undefined,
    );
  }

  async getEnvironmentCapabilities(connection: ConnectionAlias): Promise<CapabilityProbeResult> {
    const target = this.repo.getTarget(connection);
    const canWrite = target.sheets.some((sheet) => sheet.writeAllowed);
    return {
      platform: target.platform,
      connection,
      configured: true,
      canRead: true,
      canPreview: true,
      canWriteDesignatedSheet: canWrite,
      cleanupVerified: true,
      reason:
        'Deterministic fixture-safe adapter for local/offline development; non-production only.',
    };
  }

  async listAccessibleApps(
    connection: ConnectionAlias,
    _actor: ActorContext,
    _page?: PageRequest,
  ): Promise<ListAppsResult> {
    this.consumeFault('listAccessibleApps');
    const target = this.repo.getTarget(connection);
    const app: AppSummary = {
      appId: target.app.id,
      name: target.app.name,
      connection,
      platform: target.platform,
      environment: target.environment,
    };
    return { apps: [app], truncated: false };
  }

  async getSemanticCatalog(
    connection: ConnectionAlias,
    appId: string,
    _actor: ActorContext,
    variant: CatalogVariant = 'default',
    _page?: PageRequest,
  ): Promise<CatalogResult> {
    this.consumeFault('getSemanticCatalog');
    this.repo.assertApp(connection, appId);
    const catalog = this.repo.getCatalog(connection, appId, variant);
    assertCatalogNotEmpty(catalog);
    return {
      appId,
      connection,
      catalogId: catalog.catalogId,
      dimensions: catalog.fields.filter((field) => field.role === 'dimension'),
      measures: catalog.fields.filter((field) => field.role === 'measure'),
      masterItems: catalog.masterItems,
      sheets: this.sheetSummaries(connection, appId),
      chartTypes: catalog.chartSupport,
      truncated: false,
    };
  }

  async getCompilationContext(
    connection: ConnectionAlias,
    appId: string,
    _actor: ActorContext,
    variant: CatalogVariant = 'default',
  ) {
    this.repo.assertApp(connection, appId);
    const catalog = this.repo.getCatalog(connection, appId, variant);
    assertCatalogNotEmpty(catalog);
    return {
      catalog,
      sheets: this.sheetSummaries(connection, appId),
    };
  }

  async listSheetObjects(
    connection: ConnectionAlias,
    appId: string,
    sheetId: string,
    _actor: ActorContext,
    _page?: PageRequest,
  ): Promise<ListSheetObjectsResult> {
    this.consumeFault('listSheetObjects');
    this.assertSheet(connection, appId, sheetId);
    const objects: SheetObjectSummary[] = [];
    for (const [objectId, record] of this.persistedObjects) {
      if (
        record.sheetAttachmentId &&
        record.target.connection === connection &&
        record.target.appId === appId &&
        record.target.sheetId === sheetId
      ) {
        objects.push({ objectId, type: record.nativeChartType, title: record.title });
      }
    }
    return { objects, truncated: false };
  }

  async createSessionChart(request: CreateSessionChartRequest): Promise<CreateSessionChartResult> {
    request.signal.throwIfAborted();
    this.consumeFault('createSessionChart');
    const { target, plan } = request;
    this.assertSheet(target.connection, target.appId, target.sheetId);
    const catalog = this.repo.getCatalog(target.connection, target.appId, 'default');

    const cardinalities = plan.resolved.dimensions.map((dimension) =>
      resolveFieldCardinality(catalog, dimension),
    );
    const built = buildDeterministicLayout({
      dimensions: plan.resolved.dimensions,
      measures: plan.resolved.measures,
      dimensionBands: cardinalities.map((entry) => entry.band),
      dimensionMaxDistinct: cardinalities.map((entry) => entry.maxDistinctValues),
      resultLimit: plan.resultLimit,
    });

    const sessionObjectId = generateObjectId('session-object');
    this.sessionObjects.set(sessionObjectId, target);

    return {
      sessionObjectId,
      layout: {
        objectId: sessionObjectId,
        objectType: plan.nativeChartType,
        title: plan.title,
        qInfo: { type: plan.nativeChartType, id: sessionObjectId },
        qHyperCube: built.qHyperCube,
        bounded: built.bounded,
      },
    };
  }

  async disposeSessionChart(_connection: ConnectionAlias, sessionObjectId: string): Promise<void> {
    this.sessionObjects.delete(sessionObjectId);
  }

  canCreateSheetsInApp(connection: ConnectionAlias, appId: string): boolean {
    try {
      this.repo.assertApp(connection, appId);
      return true;
    } catch {
      return false;
    }
  }

  async ensureSheet(request: EnsureSheetRequest): Promise<EnsureSheetResult> {
    this.consumeFault('ensureSheet');
    this.repo.assertApp(request.target.connection, request.target.appId);
    if (
      !/^qlikai-[A-Za-z0-9_-]{1,180}$/.test(request.target.sheetId) ||
      !request.title.trim() ||
      request.title.length > 200
    ) {
      throw createError('MALFORMED_REQUEST');
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          request.target,
          request.title,
          request.actor.actor,
          request.idempotencyKey,
        ]),
      )
      .digest('hex');
    const key = this.sheetKey(request.target);
    const existing = this.generatedSheets.get(key);
    if (existing && existing.fingerprint !== fingerprint) throw createError('IDEMPOTENCY_CONFLICT');
    if (!existing)
      this.generatedSheets.set(key, {
        target: request.target,
        title: request.title,
        fingerprint,
        actor: request.actor,
      });
    return { sheetId: request.target.sheetId, created: !existing };
  }

  async verifySheet(request: VerifySheetRequest): Promise<VerifySheetResult> {
    this.consumeFault('verifySheet');
    const sheet = this.generatedSheets.get(this.sheetKey(request.target));
    const objectIds = [...this.persistedObjects]
      .filter(
        ([, record]) =>
          this.sheetKey(record.target) === this.sheetKey(request.target) &&
          record.sheetAttachmentId,
      )
      .map(([id]) => id);
    const verified = Boolean(
      sheet &&
      sheet.title === request.title &&
      sheet.actor.actor === request.actor.actor &&
      objectIds.length === request.objectIds.length &&
      new Set(request.objectIds).size === request.objectIds.length &&
      request.objectIds.every((id) => objectIds.includes(id)),
    );
    return { verified, objectIds };
  }

  async persistChart(request: PersistChartRequest): Promise<PersistChartResult> {
    this.consumeFault('persistChart');
    const { target, plan } = request;
    this.assertSheet(target.connection, target.appId, target.sheetId);
    const objectId = request.objectId ?? generateObjectId('object');
    if (request.placement) assertSheetPlacement(request.placement);
    const previous = this.persistedObjects.get(objectId);
    if (previous) {
      if (
        this.sheetKey(previous.target) !== this.sheetKey(target) ||
        !containsProperties(previous.planProperties, plan.propertyProposal) ||
        (request.placement &&
          (!previous.placement || !samePlacement(previous.placement, request.placement)))
      )
        throw createError('IDEMPOTENCY_CONFLICT');
      return { objectId };
    }
    if (
      request.placement &&
      [...this.persistedObjects.values()].some(
        (record) =>
          this.sheetKey(record.target) === this.sheetKey(target) &&
          record.placement &&
          placementsOverlap(record.placement, request.placement!),
      )
    ) {
      throw createError('MALFORMED_REQUEST', {
        message: 'The chart placement overlaps another chart.',
      });
    }
    this.persistedObjects.set(objectId, {
      target,
      nativeChartType: plan.nativeChartType,
      title: plan.title,
      planProperties: plan.propertyProposal,
      ...(request.placement ? { placement: request.placement } : {}),
    });
    return { objectId };
  }

  async attachChartToSheet(request: AttachChartRequest): Promise<AttachChartResult> {
    this.consumeFault('attachChartToSheet');
    const record = this.persistedObjects.get(request.objectId);
    if (!record || this.sheetKey(record.target) !== this.sheetKey(request.target)) {
      throw createError('NOT_FOUND', {
        message: 'The object to attach does not exist in this session.',
      });
    }
    if (
      request.placement &&
      (!record.placement || !samePlacement(record.placement, request.placement))
    )
      throw createError('IDEMPOTENCY_CONFLICT');
    const sheetAttachmentId = record.sheetAttachmentId ?? generateObjectId('attachment');
    record.sheetAttachmentId = sheetAttachmentId;
    return { sheetAttachmentId };
  }

  async verifyChart(request: VerifyChartRequest): Promise<VerifyChartResult> {
    this.consumeFault('verifyChart');
    const record = this.persistedObjects.get(request.objectId);
    return {
      verified: Boolean(
        record &&
        record.sheetAttachmentId &&
        this.sheetKey(record.target) === this.sheetKey(request.target) &&
        (!request.plan ||
          containsProperties(record.planProperties, request.plan.propertyProposal)) &&
        (!request.placement ||
          (record.placement && samePlacement(record.placement, request.placement))),
      ),
    };
  }

  async cleanupObject(request: CleanupRequest): Promise<CleanupResult> {
    const record = this.persistedObjects.get(request.objectId);
    if (record && this.sheetKey(record.target) !== this.sheetKey(request.target))
      throw createError('PERMISSION_DENIED');
    this.persistedObjects.delete(request.objectId);
    return { attempted: true, outcome: 'cleanup-complete' };
  }

  renderDescriptor(
    target: Required<TargetRef>,
    objectId: string,
    operationId: string,
    mode: 'preview' | 'persisted',
  ): RenderDescriptor {
    return {
      rendering: 'qlik-embed',
      connectionAlias: target.connection,
      appId: target.appId,
      objectId,
      operationId,
      mode,
    };
  }
}
