import { createHash, randomUUID } from 'node:crypto';
import {
  withCloudSheetMutationSession,
  type CloudSheetMutationLease,
} from './cloudSheetMutationSession.js';
import {
  containsProperties,
  isSheetPlacement,
  matchesSheetCellBounds,
  NATIVE_SHEET_LAYOUT,
  SHEET_ROWS,
  MAX_SHEET_OBJECTS,
  placementsOverlap,
  SHEET_COLUMNS,
} from '../sheetLayout.js';
import { createError, isHarnessError } from '../../domain/errors.js';
import type { TypedFailureCode } from '../../domain/errors.js';
import type {
  CatalogChartSupport,
  CatalogDefinition,
  CatalogField,
  CatalogFieldCardinality,
  CatalogMasterItem,
  CatalogVariant,
} from '../../catalog/catalogTypes.js';
import type {
  ActorContext,
  ConnectionAlias,
  PlatformId,
  RenderDescriptor,
  ResolvedChartPlan,
  TargetRef,
} from '../../domain/types.js';
import type { CloudHostConfigFactory } from './cloudOAuth.js';
import type {
  CloudCatalogSnapshot,
  CloudFieldMetadata,
  CloudQlikClient,
  CloudSdkAppSession,
} from './qlikApiCloudClient.js';
import type {
  EnsureSheetRequest,
  EnsureSheetResult,
  VerifySheetRequest,
  VerifySheetResult,
  AttachChartRequest,
  AttachChartResult,
  CapabilityProbeResult,
  CatalogResult,
  CompilationContext,
  CleanupRequest,
  CleanupResult,
  CreateSessionChartRequest,
  CreateSessionChartResult,
  ListAppsResult,
  ListSheetObjectsResult,
  PageRequest,
  PersistChartRequest,
  PersistChartResult,
  QixMatrixCell,
  SessionChartLayout,
  SheetSummary,
  SheetMutationScope,
  SheetMutationWriter,
  TargetAdapter,
  VerifyChartRequest,
  VerifyChartResult,
} from '../targetAdapter.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_COMPILATION_ITEMS = 5_000;
const MAX_PREVIEW_ROWS = 100;
const MAX_PREVIEW_COLUMNS = 20;
const STACKED_FETCH_WIDTH = 30;
const MAX_OPEN_PREVIEW_SESSIONS = 64;
const QIX_PERMISSION_CODES = new Set([5, 401, 403, 22007, 22016, 4203, 4230]);
const QIX_NOT_FOUND_CODES = new Set([2, 404, 1003, 2001, 3003, 19004, 22005, 4204]);
const QIX_CAPACITY_CODES = new Set([6, 19, 22, 22008, 4240]);
const QIX_MALFORMED_CODES = new Set([-32700, -32602, -32600, 8, 9, 400, 422, 22003, 4202]);
const BLOCKED_METADATA_TAGS = new Set([
  'confidential',
  'hidden',
  'internal',
  'personal',
  'pii',
  'restricted',
  'secret',
  'sensitive',
  'system',
]);

const NUMERIC_TAGS = new Set(['fixed', 'integer', 'money', 'numeric', 'real']);

const CLOUD_CHART_SUPPORT: readonly CatalogChartSupport[] = [
  {
    type: 'barchart',
    enabled: true,
    maxDimensionCardinalityBand: 'high',
    boundedResultRows: 50,
  },
  { type: 'linechart', enabled: true, requiresSemanticType: 'date' },
  { type: 'scatterplot', enabled: true, requiresNumericMeasures: 2 },
  { type: 'table', enabled: true, boundedResultRows: 100 },
  { type: 'kpi', enabled: true, requiresMeasures: 1 },
  { type: 'gauge', enabled: true, requiresTarget: true },
  { type: 'treemap', enabled: true, maxDimensionCardinalityBand: 'medium' },
  { type: 'piechart', enabled: true, maxDimensionCardinalityBand: 'low' },
  { type: 'combochart', enabled: true, maxDimensionCount: 1 },
];

/** The non-secret readiness record for the only Cloud write target. */
export interface CloudWriteTarget {
  readonly connection: ConnectionAlias;
  readonly appId: string;
  readonly sheetId: string;
}

/** Platform-admin-owned, non-secret result of the live Cloud readiness runbook. */
export interface CloudReadinessEvidence {
  readonly approved: boolean;
  readonly expiresAt: string;
  readonly canRead: boolean;
  readonly canPreview: boolean;
  readonly canWriteDesignatedSheet: boolean;
  readonly cleanupVerified: boolean;
}

/** Public routing values only. Credential material is deliberately absent. */
export interface CloudAdapterConfig {
  readonly connection?: ConnectionAlias;
  readonly tenantHost?: string;
  readonly tenantAlias?: string;
  readonly regionAlias?: string;
  readonly oauthClientId?: string;
  readonly environment?: string;
  readonly writeTarget?: CloudWriteTarget;
  /** Explicit additional app scope for managed sheet creation; empty by default. */
  readonly sheetCreationAppIds?: readonly string[];
  readonly readiness?: CloudReadinessEvidence;
}

export interface CloudAdapterDependencies {
  readonly hostConfigs: CloudHostConfigFactory;
  readonly qlik: CloudQlikClient;
  readonly now?: () => Date;
  readonly identityFactory?: () => string;
  /** Test/deployment seams may shorten, but never extend, the bounded attempt/close deadlines. */
  readonly mutationTimeoutMs?: number;
  readonly mutationCloseTimeoutMs?: number;
}

/** Bounded, data-free schema evidence used only by the explicit live Cloud probe. */
export interface CloudVisualizationContractSnapshot {
  readonly objectId: string;
  readonly propertyType: string | null;
  readonly propertyVersion: string | null;
  readonly hasRootSorting: boolean;
  readonly qColumnOrder: readonly number[];
  readonly qInterColumnSortOrder: readonly number[];
  readonly propertyDimensionCount: number;
  readonly propertyMeasureCount: number;
  readonly layoutType: string | null;
  readonly layoutVisualization: string | null;
  readonly layoutDimensionInfoCount: number;
  readonly layoutMeasureInfoCount: number;
  readonly cubeColumnCount: number | null;
  readonly cubeRowCount: number | null;
  readonly firstPageRowCount: number;
  readonly fullWidthRowCount: number;
  readonly usableMeasureRowCount: number;
  readonly hasLayoutError: boolean;
}

interface PreviewLease {
  readonly connection: ConnectionAlias;
  readonly appId: string;
  readonly session: CloudSdkAppSession;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function boundedNumberArray(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length > MAX_PREVIEW_COLUMNS) return [];
  return value.every((entry) => typeof entry === 'number' && Number.isInteger(entry)) ? value : [];
}

function boundedPageSize(page: PageRequest | undefined): number {
  const requested = page?.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw createError('MALFORMED_REQUEST', { message: 'pageSize must be a positive integer.' });
  }
  return Math.min(requested, MAX_PAGE_SIZE);
}

function offsetToken(kind: 'catalog' | 'sheet', offset: number): string {
  return `${kind}:${offset}`;
}

function readOffset(token: string | undefined, kind: 'catalog' | 'sheet'): number {
  if (!token) return 0;
  const match = new RegExp(`^${kind}:(\\d{1,8})$`).exec(token);
  const offset = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw createError('MALFORMED_REQUEST', { message: 'The page token is invalid for this list.' });
  }
  return offset;
}

function readRestCursor(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const containsControlCharacter = [...token].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f;
  });
  if (token.length > 2_048 || containsControlCharacter) {
    throw createError('MALFORMED_REQUEST', { message: 'The app page token is invalid.' });
  }
  return token;
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 20);
  return `${prefix}-${digest}`;
}

function normalizedTags(tags: readonly string[]): readonly string[] {
  return tags.map((tag) => tag.trim().toLowerCase().replace(/^\$/, ''));
}

function tagsOf(field: CloudFieldMetadata): ReadonlySet<string> {
  return new Set(normalizedTags(field.tags));
}

function tagsAreVisible(tags: readonly string[]): boolean {
  return !normalizedTags(tags).some((tag) => BLOCKED_METADATA_TAGS.has(tag));
}

function semanticType(tags: ReadonlySet<string>): string {
  if (tags.has('timestamp')) return 'timestamp';
  if (tags.has('date')) return 'date';
  if (tags.has('time')) return 'time';
  if (tags.has('key')) return 'identifier';
  if ([...NUMERIC_TAGS].some((tag) => tags.has(tag))) return 'numeric';
  return 'text';
}

function assertDefaultVariant(variant: CatalogVariant | undefined): void {
  if (variant && variant !== 'default') {
    throw createError('MALFORMED_REQUEST', {
      message: 'Synthetic catalog variants are unavailable on a live Qlik Cloud target.',
    });
  }
}

function cardinalityOf(
  cardinal: number | undefined,
  role: CatalogField['role'],
): CatalogFieldCardinality {
  if (role === 'measure') return { band: 'continuous' };
  if (cardinal === undefined || cardinal > 1_000) {
    return {
      band: 'high',
      ...(cardinal !== undefined ? { maxDistinctValues: cardinal } : {}),
    };
  }
  return {
    band: cardinal <= 50 ? 'low' : 'medium',
    maxDistinctValues: cardinal,
  };
}

function mapField(field: CloudFieldMetadata): CatalogField | undefined {
  if (
    !field.name.trim() ||
    field.hidden ||
    field.system ||
    field.definitionOnly ||
    !tagsAreVisible(field.tags)
  )
    return undefined;
  const tags = tagsOf(field);
  const type = semanticType(tags);
  const role: CatalogField['role'] = field.implicitMeasure ? 'measure' : 'dimension';
  return {
    id: stableId('cloud-field', field.name),
    label: field.name,
    role,
    semanticType: type,
    cardinality: cardinalityOf(field.cardinal, role),
    visible: true,
  };
}

function mapMasterItem(
  item: CloudCatalogSnapshot['masterItems'][number],
): CatalogMasterItem | undefined {
  if (!item.id.trim() || !item.title.trim() || !tagsAreVisible(item.tags)) return undefined;
  const tags = new Set(normalizedTags(item.tags));
  return {
    id: item.id,
    label: item.title,
    kind: item.kind,
    semanticType: item.kind === 'measure' ? 'numeric' : semanticType(tags),
    visible: true,
  };
}

function cloudErrorStatus(error: unknown): number {
  const candidate = recordOf(error);
  if (!candidate) return 0;
  if (typeof candidate.status === 'number') return candidate.status;
  const response = recordOf(candidate.response);
  if (typeof response?.status === 'number') return response.status;
  const data = recordOf(candidate.data);
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const first = recordOf(errors[0]);
  return typeof first?.status === 'number' ? first.status : Number(first?.status ?? 0);
}

function cloudErrorCode(error: unknown): string {
  const candidate = recordOf(error);
  if (!candidate) return '';
  const data = recordOf(candidate.data);
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const first = recordOf(errors[0]);
  const raw = candidate.code ?? first?.code ?? candidate.name;
  return typeof raw === 'string' ? raw.toUpperCase() : String(raw ?? '').toUpperCase();
}

function cloudNumericErrorCode(error: unknown): number | undefined {
  const candidate = recordOf(error);
  if (!candidate) return undefined;
  if (typeof candidate.code === 'number') return candidate.code;
  const original = recordOf(candidate.original);
  if (typeof original?.code === 'number') return original.code;
  const data = recordOf(candidate.data);
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const first = recordOf(errors[0]);
  return typeof first?.code === 'number' ? first.code : undefined;
}

function mapCloudError(error: unknown): never {
  if (isHarnessError(error)) throw error;
  const status = cloudErrorStatus(error);
  const code = cloudErrorCode(error);
  const numericCode = cloudNumericErrorCode(error);
  let mapped: TypedFailureCode = 'TRANSIENT_UNAVAILABLE';
  if (numericCode === 15 || numericCode === 22001 || code.includes('CANCEL')) {
    mapped = 'OPERATION_CANCELLED';
  } else if (
    status === 401 ||
    status === 403 ||
    (numericCode !== undefined && QIX_PERMISSION_CODES.has(numericCode)) ||
    code.includes('AUTH') ||
    code.includes('FORBIDDEN') ||
    code.includes('ACCESS_DENIED') ||
    code.includes('NO_ACCESS')
  ) {
    mapped = 'PERMISSION_DENIED';
  } else if (
    status === 404 ||
    (numericCode !== undefined && QIX_NOT_FOUND_CODES.has(numericCode)) ||
    code.includes('NOT_FOUND')
  ) {
    mapped = 'NOT_FOUND';
  } else if (
    status === 429 ||
    numericCode === 429 ||
    numericCode === 4205 ||
    code.includes('RATE')
  ) {
    mapped = 'RATE_LIMITED';
  } else if (
    (numericCode !== undefined && QIX_CAPACITY_CODES.has(numericCode)) ||
    code.includes('CAPACITY') ||
    code.includes('SESSION_LIMIT') ||
    code.includes('TOO_MANY') ||
    code.includes('ENGINE_BUSY')
  ) {
    mapped = 'CAPACITY_EXHAUSTED';
  } else if (
    (numericCode !== undefined && QIX_MALFORMED_CODES.has(numericCode)) ||
    code.includes('MALFORMED') ||
    code.includes('INVALID_ARGUMENT') ||
    (status >= 400 && status < 500)
  ) {
    mapped = 'MALFORMED_REQUEST';
  }
  throw createError(mapped, {
    message: 'The Qlik Cloud operation failed; sensitive transport details were removed.',
  });
}

function abortError(signal: AbortSignal): void {
  if (signal.aborted) throw createError('OPERATION_CANCELLED');
}

function chartProperties(
  plan: ResolvedChartPlan,
  objectId?: string,
): Readonly<Record<string, unknown>> {
  const properties = plan.propertyProposal;
  const cube = recordOf(properties.qHyperCubeDef) ?? {};
  const info = recordOf(properties.qInfo) ?? {};
  const width = Math.min(
    Math.max(plan.resolved.dimensions.length + plan.resolved.measures.length, 1),
    MAX_PREVIEW_COLUMNS,
  );
  const height = Math.min(Math.max(plan.resultLimit, 1), MAX_PREVIEW_ROWS);
  return {
    ...properties,
    qInfo: { ...info, qType: plan.nativeChartType, ...(objectId ? { qId: objectId } : {}) },
    qHyperCubeDef: {
      ...cube,
      qMode: cube.qMode === 'K' ? 'K' : cube.qMode === 'T' ? 'T' : 'S',
      qInitialDataFetch: [
        {
          qTop: 0,
          qLeft: 0,
          qHeight: height,
          qWidth: cube.qMode === 'K' ? STACKED_FETCH_WIDTH : width,
        },
      ],
    },
  };
}

function qixCell(value: unknown): QixMatrixCell {
  const cell = recordOf(value) ?? {};
  const numeric = typeof cell.qNum === 'number' ? cell.qNum : undefined;
  const qText =
    typeof cell.qText === 'string'
      ? cell.qText
      : numeric !== undefined && Number.isFinite(numeric)
        ? String(numeric)
        : '';
  return {
    qText,
    ...(numeric !== undefined ? { qNum: Number.isFinite(numeric) ? numeric : 'NaN' } : {}),
  };
}

function qixTreeCell(value: unknown): QixMatrixCell {
  const cell = recordOf(value) ?? {};
  const numeric = typeof cell.qValue === 'number' ? cell.qValue : undefined;
  const qText =
    typeof cell.qText === 'string'
      ? cell.qText
      : numeric !== undefined && Number.isFinite(numeric)
        ? String(numeric)
        : '';
  return {
    qText,
    ...(numeric !== undefined ? { qNum: Number.isFinite(numeric) ? numeric : 'NaN' } : {}),
  };
}

function boundedTreeRows(
  rawNodes: readonly unknown[],
  dimensionCount: number,
  measureCount: number,
  maxRows: number,
): readonly (readonly QixMatrixCell[])[] {
  const rows: QixMatrixCell[][] = [];
  let visitedNodes = 0;
  const maxNodes = Math.max(maxRows * Math.max(dimensionCount + 1, 2), maxRows);
  const visit = (rawNode: unknown, path: readonly QixMatrixCell[]): void => {
    if (rows.length >= maxRows || visitedNodes >= maxNodes) return;
    visitedNodes += 1;
    const node = recordOf(rawNode) ?? {};
    const isRoot = node.qType === 'R';
    const nextPath = isRoot ? path : [...path, qixTreeCell(node)];
    const children = Array.isArray(node.qNodes) ? node.qNodes : [];
    if (children.length > 0) {
      for (const child of children) visit(child, nextPath);
      return;
    }
    const values = Array.isArray(node.qValues) ? node.qValues : [];
    if (nextPath.length >= dimensionCount && values.length >= measureCount) {
      rows.push([
        ...nextPath.slice(nextPath.length - dimensionCount),
        ...values.slice(0, measureCount).map(qixTreeCell),
      ]);
    }
  };
  for (const node of rawNodes) visit(node, []);
  return rows;
}

function boundedStackRows(
  rawPages: readonly unknown[],
  dimensionCount: number,
  measureCount: number,
  maxRows: number,
): readonly (readonly QixMatrixCell[])[] {
  const rows: QixMatrixCell[][] = [];
  let visitedNodes = 0;
  const maxNodes = Math.max(maxRows * Math.max(dimensionCount + measureCount + 1, 3), maxRows);
  const visit = (rawNode: unknown, dimensions: readonly QixMatrixCell[]): void => {
    if (rows.length >= maxRows || visitedNodes >= maxNodes) return;
    visitedNodes += 1;
    const node = recordOf(rawNode) ?? {};
    const children = Array.isArray(node.qSubNodes) ? node.qSubNodes : [];
    if (node.qType === 'R') {
      for (const child of children) visit(child, dimensions);
      return;
    }
    if (dimensions.length >= dimensionCount) return;
    const nextDimensions = [...dimensions, qixTreeCell(node)];
    if (nextDimensions.length === dimensionCount) {
      const measures = children.slice(0, measureCount).map(qixTreeCell);
      if (measures.length === measureCount) rows.push([...nextDimensions, ...measures]);
      return;
    }
    for (const child of children) visit(child, nextDimensions);
  };
  for (const page of rawPages) {
    const data = recordOf(page)?.qData;
    if (!Array.isArray(data)) continue;
    for (const node of data) visit(node, []);
  }
  return rows;
}

function sessionLayout(
  rawLayout: unknown,
  objectId: string,
  plan: ResolvedChartPlan,
  rawTreeNodes: readonly unknown[] = [],
): SessionChartLayout {
  const layout = recordOf(rawLayout) ?? {};
  const info = recordOf(layout.qInfo);
  const cube = recordOf(layout.qHyperCube);
  const size = recordOf(cube?.qSize);
  if (
    !info ||
    info.qId !== objectId ||
    typeof info.qType !== 'string' ||
    !info.qType.trim() ||
    !cube ||
    !size ||
    typeof size.qcx !== 'number' ||
    !Number.isFinite(size.qcx) ||
    size.qcx < 0 ||
    typeof size.qcy !== 'number' ||
    !Number.isFinite(size.qcy) ||
    size.qcy < 0 ||
    (!Array.isArray(cube.qDataPages) &&
      cube.qMode !== 'T' &&
      !(cube.qMode === 'K' && Array.isArray(cube.qStackedDataPages)))
  ) {
    throw createError('TRANSIENT_UNAVAILABLE', {
      message: 'Qlik Engine did not return a complete evaluated preview layout.',
    });
  }
  if (layout.qError || cube.qError || cube.qCalcCondMsg) {
    throw createError('TRANSIENT_UNAVAILABLE', {
      message: 'Qlik Engine did not evaluate the bounded preview object.',
    });
  }
  const pages = Array.isArray(cube.qDataPages) ? cube.qDataPages : [];
  const firstPage = recordOf(pages[0]) ?? {};
  const rawMatrix = Array.isArray(firstPage.qMatrix) ? firstPage.qMatrix : [];
  const rawStackedPages = Array.isArray(cube.qStackedDataPages) ? cube.qStackedDataPages : [];
  const maxRows = Math.min(Math.max(plan.resultLimit, 1), MAX_PREVIEW_ROWS);
  const matrix =
    cube.qMode === 'T'
      ? boundedTreeRows(
          rawTreeNodes,
          plan.resolved.dimensions.length,
          plan.resolved.measures.length,
          maxRows,
        )
      : cube.qMode === 'K'
        ? boundedStackRows(
            rawStackedPages,
            plan.resolved.dimensions.length,
            plan.resolved.measures.length,
            maxRows,
          )
        : rawMatrix
            .slice(0, maxRows)
            .map((row) =>
              (Array.isArray(row) ? row : []).slice(0, MAX_PREVIEW_COLUMNS).map(qixCell),
            );
  const totalRows = size.qcy;
  const totalColumns = size.qcx;
  const truncated =
    totalRows > matrix.length ||
    (cube.qMode === 'T'
      ? rawTreeNodes.length > matrix.length
      : cube.qMode === 'K'
        ? totalRows > matrix.length
        : rawMatrix.length > matrix.length);
  const continuation = truncated ? `preview:${matrix.length}` : undefined;
  const title =
    typeof layout.title === 'string'
      ? layout.title
      : typeof recordOf(layout.qMeta)?.title === 'string'
        ? String(recordOf(layout.qMeta)?.title)
        : plan.title;
  const dimensionInfo = Array.isArray(cube.qDimensionInfo) ? cube.qDimensionInfo : [];
  const measureInfo = Array.isArray(cube.qMeasureInfo) ? cube.qMeasureInfo : [];
  return {
    objectId,
    objectType: typeof info.qType === 'string' ? info.qType : plan.nativeChartType,
    title,
    qInfo: {
      type: typeof info.qType === 'string' ? info.qType : plan.nativeChartType,
      id: typeof info.qId === 'string' ? info.qId : objectId,
    },
    qHyperCube: {
      qSize: { qcx: totalColumns, qcy: totalRows },
      qMode: cube.qMode === 'T' ? 'T' : cube.qMode === 'K' ? 'K' : 'S',
      qDimensionInfo: dimensionInfo.map((entry, index) => {
        const value = recordOf(entry) ?? {};
        return {
          qFallbackTitle:
            typeof value.qFallbackTitle === 'string'
              ? value.qFallbackTitle
              : (plan.resolved.dimensions[index]?.label ?? ''),
          ...(typeof value.qCardinal === 'number' ? { qCardinal: value.qCardinal } : {}),
        };
      }),
      qMeasureInfo: measureInfo.map((entry, index) => {
        const value = recordOf(entry) ?? {};
        return {
          qFallbackTitle:
            typeof value.qFallbackTitle === 'string'
              ? value.qFallbackTitle
              : (plan.resolved.measures[index]?.label ?? ''),
        };
      }),
      qDataPages: [
        {
          qMatrix: matrix,
          qRowCount: matrix.length,
          ...(continuation ? { continuation } : {}),
        },
      ],
    },
    bounded: {
      returnedRows: matrix.length,
      maxRows,
      truncated,
      rawDataIncluded: false,
      ...(continuation ? { continuation } : {}),
    },
  };
}

function hasValidationError(error: unknown): boolean {
  return Boolean(error) && recordOf(error)?.qErrorCode !== 0;
}

function isEvaluatedLayout(layout: unknown, objectId: string, plan?: ResolvedChartPlan): boolean {
  const value = recordOf(layout);
  if (!value || hasValidationError(value.qError) || hasValidationError(value.error)) return false;
  const info = recordOf(value.qInfo);
  if (!info || info.qId !== objectId || typeof info.qType !== 'string' || !info.qType.trim())
    return false;
  const cube = recordOf(value.qHyperCube);
  const size = recordOf(cube?.qSize);
  const dimensions = Array.isArray(cube?.qDimensionInfo) ? cube.qDimensionInfo : [];
  const measures = Array.isArray(cube?.qMeasureInfo) ? cube.qMeasureInfo : [];
  if (
    [...dimensions, ...measures].some(
      (field) =>
        hasValidationError(recordOf(field)?.qError) || Boolean(recordOf(field)?.qCalcCondMsg),
    )
  )
    return false;
  if (
    plan &&
    (info.qType !== plan.nativeChartType ||
      dimensions.length !== plan.resolved.dimensions.length ||
      measures.length !== plan.resolved.measures.length ||
      (typeof value.title === 'string' && value.title !== plan.title))
  )
    return false;
  return Boolean(
    cube &&
    !hasValidationError(cube.qError) &&
    !cube.qCalcCondMsg &&
    size &&
    typeof size.qcx === 'number' &&
    Number.isFinite(size.qcx) &&
    size.qcx >= 0 &&
    typeof size.qcy === 'number' &&
    Number.isFinite(size.qcy) &&
    size.qcy >= 0 &&
    (Array.isArray(cube.qDataPages) ||
      (cube.qMode === 'K' && Array.isArray(cube.qStackedDataPages)) ||
      cube.qMode === 'T'),
  );
}

/** Creates a Cloud adapter whose live dependencies must be supplied explicitly. */
export function createCloudAdapter(
  config: CloudAdapterConfig,
  dependencies: CloudAdapterDependencies,
): CloudAdapter {
  return new CloudAdapter(config, dependencies);
}

export class CloudAdapter implements TargetAdapter {
  readonly platform: PlatformId = 'cloud';
  private readonly now: () => Date;
  private readonly previewLeases = new Map<string, PreviewLease>();

  constructor(
    private readonly config: CloudAdapterConfig = {},
    private readonly dependencies?: CloudAdapterDependencies,
    private readonly mutationLease?: CloudSheetMutationLease,
  ) {
    this.now = dependencies?.now ?? (() => new Date());
  }

  private currentReadiness(connection: ConnectionAlias): CloudReadinessEvidence | undefined {
    const evidence = this.config.readiness;
    if (
      this.config.connection !== connection ||
      !this.config.tenantHost?.trim() ||
      !this.config.oauthClientId?.trim() ||
      !this.dependencies ||
      !evidence?.approved
    ) {
      return undefined;
    }
    const expiresAt = Date.parse(evidence.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) return undefined;
    return evidence;
  }

  private assertCapability(
    connection: ConnectionAlias,
    capability: 'read' | 'preview' | 'write',
  ): CloudReadinessEvidence {
    const evidence = this.currentReadiness(connection);
    const allowed =
      capability === 'read'
        ? evidence?.canRead
        : capability === 'preview'
          ? evidence?.canRead && evidence.canPreview
          : evidence?.canWriteDesignatedSheet && evidence.cleanupVerified;
    if (!evidence || !allowed) {
      throw createError('NOT_CONFIGURED', {
        message: 'The Qlik Cloud target has no current readiness evidence for this capability.',
        details: { connection },
      });
    }
    return evidence;
  }

  private assertDesignatedTarget(target: Required<TargetRef>): void {
    const allowed = this.config.writeTarget;
    if (
      target.connection === this.config.connection &&
      this.config.sheetCreationAppIds?.includes(target.appId) &&
      /^qlikai-[A-Za-z0-9_-]{1,180}$/.test(target.sheetId)
    )
      return;
    if (
      !allowed ||
      target.connection !== allowed.connection ||
      target.appId !== allowed.appId ||
      target.sheetId !== allowed.sheetId
    ) {
      throw createError('PERMISSION_DENIED', {
        message: 'Cloud mutation is restricted to the configured designated test sheet.',
        details: { connection: target.connection, appId: target.appId, sheetId: target.sheetId },
      });
    }
  }

  private async assertManagedSheet(
    session: CloudSdkAppSession,
    target: Required<TargetRef>,
  ): Promise<void> {
    if (
      target.connection === this.config.writeTarget?.connection &&
      target.appId === this.config.writeTarget.appId &&
      target.sheetId === this.config.writeTarget.sheetId
    )
      return;
    const properties = recordOf(await session.getObjectProperties(target.sheetId));
    const marker = recordOf(properties?.qlikAIHarness);
    if (
      recordOf(properties?.qInfo)?.qId !== target.sheetId ||
      recordOf(properties?.qInfo)?.qType !== 'sheet' ||
      marker?.managedBy !== 'qlik-ai-harness' ||
      marker.version !== 1 ||
      typeof marker.ownerHash !== 'string' ||
      (this.mutationLease &&
        marker.ownerHash !== stableId('owner', this.mutationLease.scope.actor.actor))
    ) {
      throw createError('PERMISSION_DENIED', {
        message:
          'New-sheet mutation is restricted to harness-managed sheets in the configured app scope.',
      });
    }
  }

  private requireDependencies(): CloudAdapterDependencies {
    if (!this.dependencies) {
      throw createError('NOT_CONFIGURED', {
        message: 'The Qlik Cloud OAuth/QIX dependencies are not configured.',
      });
    }
    return this.dependencies;
  }

  private async openSession(
    connection: ConnectionAlias,
    appId: string,
  ): Promise<CloudSdkAppSession> {
    const dependencies = this.requireDependencies();
    const hostConfig = await dependencies.hostConfigs.getHostConfig(connection);
    return dependencies.qlik.openAppSession({
      hostConfig,
      appId,
      identity: dependencies.identityFactory?.() ?? `qlik-harness-${randomUUID()}`,
    });
  }

  private async withSession<T>(
    connection: ConnectionAlias,
    appId: string,
    operation: (session: CloudSdkAppSession) => Promise<T>,
  ): Promise<T> {
    if (this.mutationLease) {
      this.mutationLease.assertActive();
      if (
        connection !== this.mutationLease.scope.target.connection ||
        appId !== this.mutationLease.scope.target.appId
      )
        throw createError('PERMISSION_DENIED', {
          message: 'The native sheet session is bound to one connection and app.',
        });
      try {
        const result = await operation(this.mutationLease.session);
        this.mutationLease.assertActive();
        return result;
      } catch (error) {
        return mapCloudError(error);
      }
    }
    let session: CloudSdkAppSession | undefined;
    try {
      session = await this.openSession(connection, appId);
      return await operation(session);
    } catch (error) {
      return mapCloudError(error);
    } finally {
      if (session) {
        try {
          await session.close();
        } catch {
          // The operation result remains authoritative; close errors contain transport details.
        }
      }
    }
  }

  private assertSnapshotBounded(snapshot: CloudCatalogSnapshot): void {
    const count = snapshot.fields.length + snapshot.masterItems.length + snapshot.sheets.length;
    if (count > MAX_COMPILATION_ITEMS) {
      throw createError('CAPACITY_EXHAUSTED', {
        message: 'The policy-visible Cloud catalog exceeds the bounded compilation limit.',
        details: { scope: 'catalog-items', maximum: MAX_COMPILATION_ITEMS, observed: count },
      });
    }
  }

  private buildCatalog(
    connection: ConnectionAlias,
    appId: string,
    snapshot: CloudCatalogSnapshot,
  ): { readonly catalog: CatalogDefinition; readonly sheets: readonly SheetSummary[] } {
    this.assertSnapshotBounded(snapshot);
    const fields = snapshot.fields.flatMap((field) => {
      const mapped = mapField(field);
      return mapped ? [mapped] : [];
    });
    const masterItems = snapshot.masterItems.flatMap((item) => {
      const mapped = mapMasterItem(item);
      return mapped ? [mapped] : [];
    });
    const readiness = this.currentReadiness(connection);
    const sheets = snapshot.sheets.map((sheet) => ({
      sheetId: sheet.id,
      name: sheet.title,
      writeAllowed: Boolean(
        readiness?.canWriteDesignatedSheet &&
        readiness.cleanupVerified &&
        this.config.writeTarget?.connection === connection &&
        this.config.writeTarget.appId === appId &&
        this.config.writeTarget.sheetId === sheet.id,
      ),
    }));
    if (fields.length === 0 && masterItems.length === 0 && sheets.length === 0) {
      throw createError('EMPTY_CATALOG');
    }
    return {
      catalog: {
        catalogId: stableId('qlik-cloud-catalog', connection, appId),
        description: 'Policy-visible Qlik Cloud field and master-item metadata.',
        visibilityPolicy: {
          includeVisibleMetadata: true,
          excludeHiddenMetadata: true,
          excludeSensitiveMetadata: true,
          excludeLoadScripts: true,
          excludeDataConnections: true,
          excludeSecurityRules: true,
        },
        fields,
        masterItems,
        chartSupport: CLOUD_CHART_SUPPORT,
        excludedMetadataExamples: [],
        excludedResponseProperties: [
          'loadScript',
          'dataConnections',
          'securityRules',
          'hiddenFields',
          'rawLayout',
        ],
      },
      sheets,
    };
  }

  async getEnvironmentCapabilities(connection: ConnectionAlias): Promise<CapabilityProbeResult> {
    const readiness = this.currentReadiness(connection);
    const hasWriteTarget = this.config.writeTarget?.connection === connection;
    return readiness
      ? {
          platform: 'cloud',
          connection,
          configured: true,
          canRead: readiness.canRead,
          canPreview: readiness.canRead && readiness.canPreview,
          canWriteDesignatedSheet: Boolean(hasWriteTarget && readiness.canWriteDesignatedSheet),
          cleanupVerified: Boolean(hasWriteTarget && readiness.cleanupVerified),
          reason: 'Current platform-admin Cloud OAuth/QIX readiness evidence is approved.',
        }
      : {
          platform: 'cloud',
          connection,
          configured: false,
          canRead: false,
          canPreview: false,
          canWriteDesignatedSheet: false,
          cleanupVerified: false,
          reason: 'No current platform-admin Cloud OAuth/QIX readiness evidence is configured.',
        };
  }

  async listAccessibleApps(
    connection: ConnectionAlias,
    _actor: ActorContext,
    page?: PageRequest,
  ): Promise<ListAppsResult> {
    this.assertCapability(connection, 'read');
    const limit = boundedPageSize(page);
    const cursor = readRestCursor(page?.pageToken);
    try {
      const dependencies = this.requireDependencies();
      const hostConfig = await dependencies.hostConfigs.getHostConfig(connection);
      const result = await dependencies.qlik.listApps(hostConfig, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      const apps = result.apps.slice(0, limit).map((app) => ({
        appId: app.appId,
        name: app.name,
        connection,
        platform: 'cloud' as const,
        environment: this.config.environment ?? 'development',
      }));
      return {
        apps,
        truncated: result.apps.length > limit || Boolean(result.nextPageToken),
        ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
      };
    } catch (error) {
      return mapCloudError(error);
    }
  }

  async getCompilationContext(
    connection: ConnectionAlias,
    appId: string,
    _actor: ActorContext,
    variant: CatalogVariant = 'default',
  ): Promise<CompilationContext> {
    this.assertCapability(connection, 'read');
    assertDefaultVariant(variant);
    return this.withSession(connection, appId, async (session) => {
      const { catalog, sheets } = this.buildCatalog(
        connection,
        appId,
        await session.getCatalogSnapshot(),
      );
      return { catalog, sheets };
    });
  }

  async getSemanticCatalog(
    connection: ConnectionAlias,
    appId: string,
    _actor: ActorContext,
    variant: CatalogVariant = 'default',
    page?: PageRequest,
  ): Promise<CatalogResult> {
    this.assertCapability(connection, 'read');
    assertDefaultVariant(variant);
    const limit = boundedPageSize(page);
    const offset = readOffset(page?.pageToken, 'catalog');
    return this.withSession(connection, appId, async (session) => {
      const { catalog, sheets } = this.buildCatalog(
        connection,
        appId,
        await session.getCatalogSnapshot(),
      );
      const entries = [
        ...catalog.fields.map((value) => ({ kind: 'field' as const, value })),
        ...catalog.masterItems.map((value) => ({ kind: 'master' as const, value })),
        ...sheets.map((value) => ({ kind: 'sheet' as const, value })),
      ];
      const selected = entries.slice(offset, offset + limit);
      const nextOffset = offset + selected.length;
      const hasNext = nextOffset < entries.length;
      const selectedFields = selected.flatMap((entry) =>
        entry.kind === 'field' ? [entry.value] : [],
      );
      return {
        appId,
        connection,
        catalogId: catalog.catalogId,
        dimensions: selectedFields.filter((field) => field.role === 'dimension'),
        measures: selectedFields.filter((field) => field.role === 'measure'),
        masterItems: selected.flatMap((entry) => (entry.kind === 'master' ? [entry.value] : [])),
        sheets: selected.flatMap((entry) => (entry.kind === 'sheet' ? [entry.value] : [])),
        chartTypes: catalog.chartSupport,
        truncated: hasNext,
        ...(hasNext ? { nextPageToken: offsetToken('catalog', nextOffset) } : {}),
      };
    });
  }

  async listSheetObjects(
    connection: ConnectionAlias,
    appId: string,
    sheetId: string,
    _actor: ActorContext,
    page?: PageRequest,
  ): Promise<ListSheetObjectsResult> {
    this.assertCapability(connection, 'read');
    const limit = boundedPageSize(page);
    const offset = readOffset(page?.pageToken, 'sheet');
    return this.withSession(connection, appId, async (session) => {
      const result = await session.listSheetObjects(sheetId, offset, limit);
      const nextOffset = offset + result.objects.length;
      const hasNext = nextOffset < result.total;
      return {
        objects: result.objects.map((object) => ({
          objectId: object.id,
          type: object.type,
          title: object.title,
        })),
        truncated: hasNext,
        ...(hasNext ? { nextPageToken: offsetToken('sheet', nextOffset) } : {}),
      };
    });
  }

  async createSessionChart(request: CreateSessionChartRequest): Promise<CreateSessionChartResult> {
    this.assertCapability(request.target.connection, 'preview');
    abortError(request.signal);
    if (this.previewLeases.size >= MAX_OPEN_PREVIEW_SESSIONS) {
      throw createError('CAPACITY_EXHAUSTED', {
        message: 'The Cloud adapter reached its bounded open-preview-session limit.',
      });
    }

    let session: CloudSdkAppSession | undefined;
    let objectId: string | undefined;
    let leaseStored = false;
    try {
      session = await this.openSession(request.target.connection, request.target.appId);
      abortError(request.signal);
      const created = await session.createSessionObject(chartProperties(request.plan));
      objectId = created.objectId;
      abortError(request.signal);
      const layout = sessionLayout(created.layout, objectId, request.plan, created.treeNodes);
      if (this.previewLeases.has(objectId)) {
        throw createError('CAPACITY_EXHAUSTED', {
          message: 'Qlik Engine returned a duplicate active session-object identifier.',
        });
      }
      this.previewLeases.set(objectId, {
        connection: request.target.connection,
        appId: request.target.appId,
        session,
      });
      leaseStored = true;
      if (request.signal.aborted) {
        const cancelledObjectId = objectId;
        session = undefined;
        objectId = undefined;
        leaseStored = false;
        await this.disposeSessionChart(request.target.connection, cancelledObjectId);
        throw createError('OPERATION_CANCELLED');
      }
      return { sessionObjectId: objectId, layout };
    } catch (error) {
      if (leaseStored && objectId) this.previewLeases.delete(objectId);
      if (session && objectId) {
        try {
          await session.destroySessionObject(objectId);
        } catch {
          // Closing the owning QIX session below is the final cleanup boundary.
        }
      }
      if (session) {
        try {
          await session.close();
        } catch {
          // Preserve the sanitized operation failure.
        }
      }
      return mapCloudError(error);
    }
  }

  async disposeSessionChart(connection: ConnectionAlias, sessionObjectId: string): Promise<void> {
    const lease = this.previewLeases.get(sessionObjectId);
    if (!lease) return;
    if (lease.connection !== connection) {
      throw createError('PERMISSION_DENIED', {
        message: 'The session object belongs to a different Cloud connection.',
        details: { connection },
      });
    }
    this.previewLeases.delete(sessionObjectId);
    try {
      const destroyed = await lease.session.destroySessionObject(sessionObjectId);
      if (!destroyed) {
        throw createError('TRANSIENT_UNAVAILABLE', {
          message: 'Qlik Engine did not confirm session-object disposal.',
        });
      }
    } catch (error) {
      return mapCloudError(error);
    } finally {
      try {
        await lease.session.close();
      } catch {
        // Session-object ownership still ends at this close attempt.
      }
    }
  }

  canCreateSheetsInApp(connection: ConnectionAlias, appId: string): boolean {
    return (
      connection === this.config.connection &&
      this.config.sheetCreationAppIds?.includes(appId) === true
    );
  }

  async withSheetMutationSession<T>(
    scope: SheetMutationScope,
    run: (writer: SheetMutationWriter) => Promise<T>,
  ): Promise<T> {
    // Snapshot before any await: later caller changes cannot widen this socket's authority.
    const boundScope: SheetMutationScope = {
      target: { ...scope.target },
      actor: { ...scope.actor },
      ...(scope.signal ? { signal: scope.signal } : {}),
    };
    this.assertCapability(boundScope.target.connection, 'write');
    this.assertDesignatedTarget(boundScope.target);
    if (!this.canCreateSheetsInApp(boundScope.target.connection, boundScope.target.appId))
      throw createError('PERMISSION_DENIED', {
        message: 'A sheet mutation session requires explicitly configured app creation scope.',
      });
    const dependencies = this.requireDependencies();
    try {
      return await withCloudSheetMutationSession({
        scope: boundScope,
        openSession: () => this.openSession(boundScope.target.connection, boundScope.target.appId),
        createWriter: (lease) => new CloudAdapter(this.config, dependencies, lease),
        run,
        timeoutMs: dependencies.mutationTimeoutMs,
        closeTimeoutMs: dependencies.mutationCloseTimeoutMs,
      });
    } catch (error) {
      return mapCloudError(error);
    }
  }

  async ensureSheet(request: EnsureSheetRequest): Promise<EnsureSheetResult> {
    this.assertCapability(request.target.connection, 'write');
    if (
      request.target.connection !== this.config.connection ||
      !this.config.sheetCreationAppIds?.includes(request.target.appId)
    ) {
      throw createError('PERMISSION_DENIED', {
        message: 'Sheet creation requires an explicitly configured app scope.',
      });
    }
    if (
      !/^qlikai-[A-Za-z0-9_-]{1,180}$/.test(request.target.sheetId) ||
      !request.title.trim() ||
      request.title.length > 200 ||
      !request.idempotencyKey
    ) {
      throw createError('MALFORMED_REQUEST', {
        message: 'Sheet creation requires a bounded title and deterministic managed identifier.',
      });
    }
    const ownerHash = stableId('owner', request.actor.actor);
    const requestHash = stableId(
      'request',
      request.idempotencyKey,
      request.title,
      request.target.connection,
      request.target.appId,
      request.target.sheetId,
      ownerHash,
    );
    return this.withSession(request.target.connection, request.target.appId, async (session) => {
      if (!session.ensureSheet)
        throw createError('NOT_CONFIGURED', {
          message: 'The Qlik provider does not support native sheet creation.',
        });
      const result = await session.ensureSheet({
        qInfo: { qId: request.target.sheetId, qType: 'sheet' },
        qMetaDef: { title: request.title, description: '', tags: [] },
        qExtendsId: '',
        qStateName: '$',
        rank: 0,
        ...NATIVE_SHEET_LAYOUT,
        cells: [],
        qChildListDef: { qData: { title: '/title' } },
        qlikAIHarness: { managedBy: 'qlik-ai-harness', version: 1, ownerHash, requestHash },
      });
      this.mutationLease?.assertActive();
      await session.save();
      return result;
    });
  }

  async verifySheet(request: VerifySheetRequest): Promise<VerifySheetResult> {
    this.assertCapability(request.target.connection, 'read');
    this.assertDesignatedTarget(request.target);
    return this.withSession(request.target.connection, request.target.appId, async (session) => {
      await this.assertManagedSheet(session, request.target);
      const properties = recordOf(await session.getObjectProperties(request.target.sheetId));
      const marker = recordOf(properties?.qlikAIHarness);
      const rawCells = properties?.cells;
      const cells = Array.isArray(rawCells) ? rawCells : [];
      const objectIds = cells.flatMap((cell) =>
        typeof recordOf(cell)?.name === 'string' ? [String(recordOf(cell)?.name)] : [],
      );
      const bounded =
        cells.length <= MAX_SHEET_OBJECTS && request.objectIds.length <= MAX_SHEET_OBJECTS;
      const unique = new Set(objectIds).size === objectIds.length;
      const validPlacement =
        cells.every(isSheetPlacement) &&
        cells.every((cell, index) =>
          cells.slice(index + 1).every((other) => !placementsOverlap(cell, other)),
        );
      const verified =
        Array.isArray(rawCells) &&
        bounded &&
        unique &&
        validPlacement &&
        containsProperties(properties, NATIVE_SHEET_LAYOUT) &&
        cells.every((cell) =>
          matchesSheetCellBounds(recordOf(cell)?.bounds, cell, SHEET_COLUMNS, SHEET_ROWS),
        ) &&
        marker?.ownerHash === stableId('owner', request.actor.actor) &&
        recordOf(properties?.qInfo)?.qType === 'sheet' &&
        recordOf(properties?.qMetaDef)?.title === request.title &&
        objectIds.length === request.objectIds.length &&
        request.objectIds.every((id) => objectIds.includes(id));
      return { verified, objectIds: objectIds.slice(0, MAX_SHEET_OBJECTS) };
    });
  }

  async persistChart(request: PersistChartRequest): Promise<PersistChartResult> {
    this.assertCapability(request.target.connection, 'write');
    this.assertDesignatedTarget(request.target);
    return this.withSession(request.target.connection, request.target.appId, async (session) => {
      await this.assertManagedSheet(session, request.target);
      const existedBefore = request.objectId
        ? await session.isSheetChild(request.target.sheetId, request.objectId)
        : false;
      const objectId = await session.createChildObject(
        request.target.sheetId,
        chartProperties(request.plan, request.objectId),
        request.placement,
        request.objectId !== undefined,
      );
      try {
        this.mutationLease?.assertActive();
        await session.save();
      } catch (error) {
        if (!existedBefore && (!this.mutationLease || this.mutationLease.isActive())) {
          try {
            await session.destroyChildObject(request.target.sheetId, objectId);
            await session.save();
          } catch {
            // Preserve the original save failure after the best-effort local rollback.
          }
        }
        throw error;
      }
      return { objectId };
    });
  }

  async attachChartToSheet(request: AttachChartRequest): Promise<AttachChartResult> {
    this.assertCapability(request.target.connection, 'write');
    this.assertDesignatedTarget(request.target);
    return this.withSession(request.target.connection, request.target.appId, async (session) => {
      await this.assertManagedSheet(session, request.target);
      const [isChild, hasCell] = await Promise.all([
        session.isSheetChild(request.target.sheetId, request.objectId),
        session.hasSheetCell(request.target.sheetId, request.objectId, request.placement),
      ]);
      if (!isChild || !hasCell) {
        throw createError('NOT_FOUND', {
          message: 'The created native object is not visibly placed on the designated sheet.',
          details: { objectId: request.objectId },
        });
      }
      return { sheetAttachmentId: request.objectId };
    });
  }

  async verifyChart(request: VerifyChartRequest): Promise<VerifyChartResult> {
    this.assertCapability(
      request.target.connection,
      this.canCreateSheetsInApp(request.target.connection, request.target.appId) &&
        request.target.sheetId.startsWith('qlikai-')
        ? 'read'
        : 'write',
    );
    this.assertDesignatedTarget(request.target);
    return this.withSession(request.target.connection, request.target.appId, async (session) => {
      await this.assertManagedSheet(session, request.target);
      const [layout, isChild, hasCell, properties] = await Promise.all([
        session.getObjectLayout(request.objectId),
        session.isSheetChild(request.target.sheetId, request.objectId),
        session.hasSheetCell(request.target.sheetId, request.objectId, request.placement),
        request.plan ? session.getObjectProperties(request.objectId) : Promise.resolve(undefined),
      ]);
      return {
        verified:
          isChild &&
          hasCell &&
          isEvaluatedLayout(layout, request.objectId, request.plan) &&
          (!request.plan ||
            containsProperties(properties, chartProperties(request.plan, request.objectId))),
      };
    });
  }

  /**
   * Reopens one object and returns only schema/type metadata. It deliberately
   * excludes expressions, field names, titles, matrix data, and raw QIX state.
   */
  async inspectVisualizationContract(
    connection: ConnectionAlias,
    appId: string,
    objectId: string,
  ): Promise<CloudVisualizationContractSnapshot> {
    this.assertCapability(connection, 'read');
    if (!objectId.trim()) {
      throw createError('MALFORMED_REQUEST', { message: 'objectId must be non-empty.' });
    }
    return this.withSession(connection, appId, async (session) => {
      const [rawProperties, rawLayout] = await Promise.all([
        session.getObjectProperties(objectId),
        session.getObjectLayout(objectId),
      ]);
      const properties = recordOf(rawProperties) ?? {};
      const propertyInfo = recordOf(properties.qInfo);
      const cube = recordOf(properties.qHyperCubeDef);
      const rawTreeNodes =
        cube?.qMode === 'T' && session.getObjectTreeData
          ? await session.getObjectTreeData(objectId)
          : [];
      const layout = recordOf(rawLayout) ?? {};
      const layoutInfo = recordOf(layout.qInfo);
      const layoutCube = recordOf(layout.qHyperCube);
      const layoutSize = recordOf(layoutCube?.qSize);
      const propertyDimensions = Array.isArray(cube?.qDimensions) ? cube.qDimensions : [];
      const propertyMeasures = Array.isArray(cube?.qMeasures) ? cube.qMeasures : [];
      const layoutDimensions = Array.isArray(layoutCube?.qDimensionInfo)
        ? layoutCube.qDimensionInfo
        : [];
      const layoutMeasures = Array.isArray(layoutCube?.qMeasureInfo) ? layoutCube.qMeasureInfo : [];
      const dataPages = Array.isArray(layoutCube?.qDataPages) ? layoutCube.qDataPages : [];
      const stackedPages = Array.isArray(layoutCube?.qStackedDataPages)
        ? layoutCube.qStackedDataPages
        : [];
      const firstDataPage = recordOf(dataPages[0]);
      const matrix =
        cube?.qMode === 'T'
          ? boundedTreeRows(
              rawTreeNodes,
              propertyDimensions.length,
              propertyMeasures.length,
              MAX_PREVIEW_ROWS,
            )
          : cube?.qMode === 'K'
            ? boundedStackRows(
                stackedPages,
                propertyDimensions.length,
                propertyMeasures.length,
                MAX_PREVIEW_ROWS,
              )
            : Array.isArray(firstDataPage?.qMatrix)
              ? firstDataPage.qMatrix
              : [];
      const cubeColumnCount =
        cube?.qMode === 'T' || cube?.qMode === 'K'
          ? propertyDimensions.length + propertyMeasures.length
          : typeof layoutSize?.qcx === 'number' && Number.isFinite(layoutSize.qcx)
            ? layoutSize.qcx
            : null;
      const cubeRowCount =
        typeof layoutSize?.qcy === 'number' && Number.isFinite(layoutSize.qcy)
          ? layoutSize.qcy
          : null;
      const fullWidthRows = matrix.filter(
        (row) => Array.isArray(row) && cubeColumnCount !== null && row.length === cubeColumnCount,
      );
      const firstMeasureColumn = propertyDimensions.length;
      const usableMeasureRows = fullWidthRows.filter((row) => {
        const cell = recordOf((row as unknown[])[firstMeasureColumn]);
        if (!cell || cell.qNum === 'NaN') return false;
        if (typeof cell.qNum === 'number') return Number.isFinite(cell.qNum);
        return typeof cell.qText === 'string' && cell.qText.trim().length > 0;
      });
      return {
        objectId,
        propertyType:
          typeof propertyInfo?.qType === 'string' && propertyInfo.qType.trim()
            ? propertyInfo.qType
            : null,
        propertyVersion:
          typeof properties.version === 'string' && properties.version.trim()
            ? properties.version
            : null,
        hasRootSorting: properties.sorting !== undefined,
        qColumnOrder: boundedNumberArray(cube?.qColumnOrder),
        qInterColumnSortOrder: boundedNumberArray(cube?.qInterColumnSortOrder),
        propertyDimensionCount: propertyDimensions.length,
        propertyMeasureCount: propertyMeasures.length,
        layoutType:
          typeof layoutInfo?.qType === 'string' && layoutInfo.qType.trim()
            ? layoutInfo.qType
            : null,
        layoutVisualization:
          typeof layout.visualization === 'string' && layout.visualization.trim()
            ? layout.visualization
            : null,
        layoutDimensionInfoCount: layoutDimensions.length,
        layoutMeasureInfoCount: layoutMeasures.length,
        cubeColumnCount,
        cubeRowCount,
        firstPageRowCount: matrix.length,
        fullWidthRowCount: fullWidthRows.length,
        usableMeasureRowCount: usableMeasureRows.length,
        hasLayoutError: Boolean(
          layout.qError || layout.error || layoutCube?.qError || layoutCube?.qCalcCondMsg,
        ),
      };
    });
  }

  async cleanupObject(request: CleanupRequest): Promise<CleanupResult> {
    this.assertDesignatedTarget(request.target);
    this.requireDependencies();
    if (request.sheetAttachmentId && request.sheetAttachmentId !== request.objectId) {
      return { attempted: true, outcome: 'cleanup-failed' };
    }
    try {
      const removed = await this.withSession(
        request.target.connection,
        request.target.appId,
        async (session) => {
          await this.assertManagedSheet(session, request.target);
          const destroyed = await session.destroyChildObject(
            request.target.sheetId,
            request.objectId,
          );
          if (destroyed) await session.save();
          return destroyed;
        },
      );
      return { attempted: true, outcome: removed ? 'cleanup-complete' : 'cleanup-failed' };
    } catch {
      return { attempted: true, outcome: 'cleanup-failed' };
    }
  }

  renderDescriptor(
    target: Required<TargetRef>,
    objectId: string,
    operationId: string,
    mode: 'preview' | 'persisted',
  ): RenderDescriptor {
    if (mode === 'persisted') {
      this.assertCapability(target.connection, 'write');
      this.assertDesignatedTarget(target);
    } else {
      this.assertCapability(target.connection, 'preview');
    }
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
