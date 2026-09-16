import type {
  CatalogChartSupport,
  CatalogDefinition,
  CatalogField,
  CatalogMasterItem,
  CatalogVariant,
} from '../catalog/catalogTypes.js';
import type {
  ActorContext,
  ConnectionAlias,
  PlatformId,
  RenderDescriptor,
  ResolvedChartPlan,
  TargetRef,
} from '../domain/types.js';

/**
 * The injectable target adapter contract (see docs/02-platform-support-matrix.md).
 * Cloud/Windows/Fixture adapters implement this identical interface so the
 * MCP facade, policy engine, and compiler never depend on a target-specific
 * detail. Adapters own authentication, transport, and error mapping; they
 * never make policy decisions.
 */

export interface CapabilityProbeResult {
  readonly platform: PlatformId;
  readonly connection: ConnectionAlias;
  /** True once readiness evidence/configuration exists for this connection (never true for Cloud/Windows in this repo). */
  readonly configured: boolean;
  readonly canRead: boolean;
  readonly canPreview: boolean;
  readonly canWriteDesignatedSheet: boolean;
  readonly cleanupVerified: boolean;
  readonly reason: string;
}

export interface PageRequest {
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface AppSummary {
  readonly appId: string;
  readonly name: string;
  readonly connection: ConnectionAlias;
  readonly platform: PlatformId;
  readonly environment: string;
}

export interface ListAppsResult {
  readonly apps: readonly AppSummary[];
  readonly truncated: boolean;
  readonly nextPageToken?: string;
}

export interface SheetSummary {
  readonly sheetId: string;
  readonly name: string;
  readonly writeAllowed: boolean;
}

export interface CatalogResult {
  readonly appId: string;
  readonly connection: ConnectionAlias;
  readonly catalogId: string;
  readonly dimensions: readonly CatalogField[];
  readonly measures: readonly CatalogField[];
  readonly masterItems: readonly CatalogMasterItem[];
  readonly sheets: readonly SheetSummary[];
  readonly chartTypes: readonly CatalogChartSupport[];
  readonly truncated: boolean;
  readonly nextPageToken?: string;
}

export interface SheetObjectSummary {
  readonly objectId: string;
  readonly type: string;
  readonly title: string;
}

export interface ListSheetObjectsResult {
  readonly objects: readonly SheetObjectSummary[];
  readonly truncated: boolean;
  readonly nextPageToken?: string;
}

export interface QixMatrixCell {
  readonly qText: string;
  readonly qNum?: number | 'NaN';
}

export interface QixDataPage {
  readonly qMatrix: readonly (readonly QixMatrixCell[])[];
  readonly qRowCount?: number;
  readonly continuation?: string;
}

export interface QixHyperCube {
  readonly qSize: { readonly qcx: number; readonly qcy: number };
  readonly qMode: 'S' | 'K' | 'T';
  readonly qDimensionInfo: readonly {
    readonly qFallbackTitle: string;
    readonly qCardinal?: number;
  }[];
  readonly qMeasureInfo: readonly { readonly qFallbackTitle: string }[];
  readonly qDataPages: readonly QixDataPage[];
}

export interface BoundedResultMeta {
  readonly returnedRows: number;
  readonly maxRows: number;
  readonly truncated: boolean;
  readonly rawDataIncluded: false;
  readonly continuation?: string;
}

export interface SessionChartLayout {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly qInfo: { readonly type: string; readonly id: string };
  readonly qHyperCube: QixHyperCube;
  readonly bounded: BoundedResultMeta;
}

export interface CreateSessionChartRequest {
  readonly target: Required<TargetRef>;
  readonly plan: ResolvedChartPlan;
  readonly actor: ActorContext;
  /** Aborted when the caller cancels or the server's bounded preview deadline expires. */
  readonly signal: AbortSignal;
}

export interface CreateSessionChartResult {
  readonly sessionObjectId: string;
  readonly layout: SessionChartLayout;
}

/** Native Qlik sheet grid coordinates; every value is a bounded integer. */
export interface SheetPlacement {
  readonly col: number;
  readonly row: number;
  readonly colspan: number;
  readonly rowspan: number;
}

export interface EnsureSheetRequest {
  readonly target: Required<TargetRef>;
  readonly title: string;
  readonly actor: ActorContext;
  readonly idempotencyKey: string;
}

export interface EnsureSheetResult {
  readonly sheetId: string;
  readonly created: boolean;
}

export interface VerifySheetRequest {
  readonly target: Required<TargetRef>;
  readonly title: string;
  readonly objectIds: readonly string[];
  readonly actor: ActorContext;
}

export interface VerifySheetResult {
  readonly verified: boolean;
  readonly objectIds: readonly string[];
}

/** A single attempt's exact principal and native target; never a cross-request session cache. */
export interface SheetMutationScope {
  readonly target: Required<TargetRef>;
  readonly actor: ActorContext;
  readonly signal?: AbortSignal;
}

/** Capabilities exposed only for the lifetime of one native sheet apply attempt. */
export interface SheetMutationWriter {
  ensureSheet(request: EnsureSheetRequest): Promise<EnsureSheetResult>;
  persistChart(request: PersistChartRequest): Promise<PersistChartResult>;
  attachChartToSheet(request: AttachChartRequest): Promise<AttachChartResult>;
  verifyChart(request: VerifyChartRequest): Promise<VerifyChartResult>;
}

export interface PersistChartRequest {
  readonly objectId?: string;
  readonly placement?: SheetPlacement;
  readonly target: Required<TargetRef>;
  readonly plan: ResolvedChartPlan;
  readonly actor: ActorContext;
  readonly idempotencyKey: string;
}

export interface PersistChartResult {
  readonly objectId: string;
}

export interface AttachChartRequest {
  readonly placement?: SheetPlacement;
  readonly target: Required<TargetRef>;
  readonly objectId: string;
}

export interface AttachChartResult {
  readonly sheetAttachmentId: string;
}

export interface VerifyChartRequest {
  readonly plan?: ResolvedChartPlan;
  readonly placement?: SheetPlacement;
  readonly target: Required<TargetRef>;
  readonly objectId: string;
}

export interface VerifyChartResult {
  readonly verified: boolean;
}

export interface CleanupRequest {
  readonly target: Required<TargetRef>;
  readonly objectId: string;
  readonly sheetAttachmentId?: string;
}

export interface CleanupResult {
  readonly attempted: true;
  readonly outcome: 'cleanup-complete' | 'cleanup-failed';
}

export interface CompilationContext {
  readonly catalog: CatalogDefinition;
  readonly sheets: readonly SheetSummary[];
}

export interface TargetAdapter {
  readonly platform: PlatformId;

  getEnvironmentCapabilities(connection: ConnectionAlias): Promise<CapabilityProbeResult>;

  listAccessibleApps(
    connection: ConnectionAlias,
    actor: ActorContext,
    page?: PageRequest,
  ): Promise<ListAppsResult>;

  /**
   * Returns the full catalog definition (including sensitive/hidden-metadata
   * exclusion examples) and sheet list used *server-side* by the compiler
   * and policy engine. Never exposed directly through an MCP tool output;
   * `getSemanticCatalog` above is the public, already-filtered projection.
   */
  getCompilationContext(
    connection: ConnectionAlias,
    appId: string,
    actor: ActorContext,
    variant?: CatalogVariant,
  ): Promise<CompilationContext>;

  getSemanticCatalog(
    connection: ConnectionAlias,
    appId: string,
    actor: ActorContext,
    variant?: CatalogVariant,
    page?: PageRequest,
  ): Promise<CatalogResult>;

  listSheetObjects(
    connection: ConnectionAlias,
    appId: string,
    sheetId: string,
    actor: ActorContext,
    page?: PageRequest,
  ): Promise<ListSheetObjectsResult>;

  createSessionChart(request: CreateSessionChartRequest): Promise<CreateSessionChartResult>;

  disposeSessionChart(connection: ConnectionAlias, sessionObjectId: string): Promise<void>;

  /** Non-secret provider app scope; independent of current live readiness. */
  canCreateSheetsInApp?(connection: ConnectionAlias, appId: string): boolean;

  /** Available only where explicit app-scoped sheet creation is supported. */
  ensureSheet?(request: EnsureSheetRequest): Promise<EnsureSheetResult>;

  verifySheet?(request: VerifySheetRequest): Promise<VerifySheetResult>;

  /** Caller must leave an attempt in-progress if this throws outcome="uncertain". */
  withSheetMutationSession?<T>(
    scope: SheetMutationScope,
    run: (writer: SheetMutationWriter) => Promise<T>,
  ): Promise<T>;

  persistChart(request: PersistChartRequest): Promise<PersistChartResult>;

  attachChartToSheet(request: AttachChartRequest): Promise<AttachChartResult>;

  verifyChart(request: VerifyChartRequest): Promise<VerifyChartResult>;

  cleanupObject(request: CleanupRequest): Promise<CleanupResult>;

  renderDescriptor(
    target: Required<TargetRef>,
    objectId: string,
    operationId: string,
    mode: 'preview' | 'persisted',
  ): RenderDescriptor;
}
