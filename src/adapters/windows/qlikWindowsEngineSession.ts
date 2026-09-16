import { createHash, randomUUID } from 'node:crypto';
import { qix } from '@qlik/api';
import type { HostConfig } from '@qlik/api/auth';
import type {
  AnyGenericObjectLayout,
  AppSession,
  DimensionListItem,
  Doc,
  DocListEntry,
  GenericObject,
  MeasureListItem,
  NxCell,
  NxDataPage,
  NxFieldDescription,
  OpenAppSessionProps,
  SheetListItem,
} from '@qlik/api/qix';
import { createError } from '../../domain/errors.js';
import type { ActorContext } from '../../domain/types.js';
import type {
  CatalogChartSupport,
  CatalogDefinition,
  CatalogField,
  CatalogFieldCardinality,
  CatalogMasterItem,
  CatalogVariant,
} from '../../catalog/catalogTypes.js';
import type {
  AppSummary,
  AttachChartRequest,
  AttachChartResult,
  CatalogResult,
  CleanupRequest,
  CleanupResult,
  CompilationContext,
  CreateSessionChartRequest,
  CreateSessionChartResult,
  ListAppsResult,
  ListSheetObjectsResult,
  PageRequest,
  PersistChartRequest,
  PersistChartResult,
  QixDataPage,
  QixMatrixCell,
  SheetObjectSummary,
  SheetSummary,
  VerifyChartRequest,
  VerifyChartResult,
} from '../targetAdapter.js';
import type {
  WindowsEngineSession,
  WindowsEngineSessionFactory,
  WindowsSecret,
  WindowsWriteTarget,
} from './windowsAdapter.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const DEFAULT_SHEET_COLUMNS = 24;
const DEFAULT_CHART_ROW_SPAN = 6;

const WINDOWS_CHART_SUPPORT = [
  { type: 'barchart', enabled: true, maxDimensionCardinalityBand: 'high', boundedResultRows: 50 },
  { type: 'linechart', enabled: true, requiresSemanticType: 'date' },
  { type: 'scatterplot', enabled: true, requiresNumericMeasures: 2 },
  { type: 'table', enabled: true, boundedResultRows: 100 },
  { type: 'kpi', enabled: true, requiresMeasures: 1 },
  { type: 'gauge', enabled: true, requiresTarget: true },
  { type: 'treemap', enabled: true, maxDimensionCardinalityBand: 'medium' },
  { type: 'piechart', enabled: true, maxDimensionCardinalityBand: 'low' },
  { type: 'combochart', enabled: true, maxDimensionCount: 1 },
] as const satisfies readonly CatalogChartSupport[];

const BLOCKED_METADATA_TAGS = new Set([
  'confidential',
  'hidden',
  'internal',
  'personal',
  'pii',
  'restricted',
  'sensitive',
  'system',
]);

const NUMERIC_TAGS = new Set(['fixed', 'integer', 'money', 'numeric', 'real']);
const DATE_TAGS = new Set(['date', 'timestamp', 'time']);
const IDENTIFIER_TAGS = new Set(['key', 'primary', 'identifier']);

type QlikOpenAppSession = (props: OpenAppSessionProps) => AppSession;
type LiveGenericObject = GenericObject<Record<string, unknown>, AnyGenericObjectLayout>;

interface BuiltHostConfig {
  readonly hostConfig: HostConfig;
  readonly clearSecretReferences: () => void;
}

interface AppHandle {
  readonly appSession: AppSession;
  readonly doc: Doc;
}

interface SessionObjectOwner extends AppHandle {
  readonly appId: string;
}

interface LiveCatalog {
  readonly definition: CatalogDefinition;
  readonly sheets: readonly SheetSummary[];
}

interface PageSlice<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
  readonly nextPageToken?: string;
}

interface SheetCell {
  readonly name: string;
  readonly type: string;
  readonly col: number;
  readonly row: number;
  readonly colspan: number;
  readonly rowspan: number;
}

export interface QlikWindowsEngineSessionFactoryOptions {
  /** Injectable only for unit tests; production uses `qix.openAppSession`. */
  readonly openAppSession?: QlikOpenAppSession;
  readonly createIdentity?: () => string;
}

function invalidConfiguration(message: string): never {
  throw createError('NOT_CONFIGURED', { message });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizedTags(tags: readonly string[] | undefined): readonly string[] {
  return (tags ?? []).map((tag) => tag.trim().toLowerCase().replace(/^\$/, ''));
}

function tagsAreVisible(tags: readonly string[] | undefined): boolean {
  return !normalizedTags(tags).some((tag) => BLOCKED_METADATA_TAGS.has(tag));
}

function semanticType(tags: readonly string[] | undefined): string {
  const normalized = new Set(normalizedTags(tags));
  if ([...DATE_TAGS].some((tag) => normalized.has(tag))) return 'date';
  if ([...IDENTIFIER_TAGS].some((tag) => normalized.has(tag))) return 'identifier';
  if ([...NUMERIC_TAGS].some((tag) => normalized.has(tag))) return 'numeric';
  return 'text';
}

function cardinality(count: number | undefined, semantic: string): CatalogFieldCardinality {
  if (semantic === 'numeric') return { band: 'continuous' };
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return { band: 'high' };
  const maxDistinctValues = Math.floor(count);
  if (maxDistinctValues <= 20) return { band: 'low', maxDistinctValues };
  if (maxDistinctValues <= 1_000) return { band: 'medium', maxDistinctValues };
  return { band: 'high', maxDistinctValues };
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
  return `${prefix}-${digest}`;
}

function assertDefaultVariant(variant: CatalogVariant | undefined): void {
  if (variant && variant !== 'default') {
    throw createError('MALFORMED_REQUEST', {
      message: 'Synthetic catalog variants are unavailable on a live Windows target.',
    });
  }
}

function paginate<T>(items: readonly T[], page: PageRequest | undefined): PageSlice<T> {
  const pageSize = page?.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw createError('MALFORMED_REQUEST', {
      message: `Windows pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`,
    });
  }
  const token = page?.pageToken;
  if (token !== undefined && !/^windows:\d+$/.test(token)) {
    throw createError('MALFORMED_REQUEST', { message: 'The Windows page token is invalid.' });
  }
  const offset = token ? Number.parseInt(token.slice('windows:'.length), 10) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw createError('MALFORMED_REQUEST', { message: 'The Windows page token is invalid.' });
  }
  const selected = items.slice(offset, offset + pageSize);
  const nextOffset = offset + selected.length;
  const truncated = nextOffset < items.length;
  return {
    items: selected,
    truncated,
    ...(truncated ? { nextPageToken: `windows:${nextOffset}` } : {}),
  };
}

function parseServerAlias(serverAlias: string): URL {
  const value = serverAlias.trim();
  if (!value || /\s/.test(value))
    return invalidConfiguration('The Windows server alias is invalid.');
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return invalidConfiguration('The Windows server alias is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    return invalidConfiguration('The Windows server alias must identify one HTTPS host.');
  }
  return url;
}

/** Normalizes a Windows routing alias without permitting credentials, paths, or insecure HTTP. */
export function normalizeWindowsServerAlias(serverAlias: string): string {
  return parseServerAlias(serverAlias).toString().replace(/\/$/, '');
}

function buildHostConfig(options: {
  readonly serverAlias: string;
  readonly virtualProxyAlias?: string;
  readonly authMode: 'proxy-session' | 'trusted-backend';
  readonly secret: WindowsSecret;
}): BuiltHostConfig {
  const url = parseServerAlias(options.serverAlias);
  if (options.authMode === 'proxy-session') {
    if (options.secret.authMode !== 'proxy-session') {
      return invalidConfiguration(
        'The Windows secret does not match the configured authentication mode.',
      );
    }
    const virtualProxy = options.virtualProxyAlias?.trim();
    if (!virtualProxy || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(virtualProxy)) {
      return invalidConfiguration(
        'Proxy-session authentication requires an approved virtual-proxy alias.',
      );
    }
    url.pathname = `/${virtualProxy}`;
    let accessToken: string | undefined = options.secret.accessToken;
    const hostConfig = {
      authType: 'windowscookie',
      host: url.toString().replace(/\/$/, ''),
      getAccessToken: async () =>
        accessToken ?? invalidConfiguration('The Windows proxy JWT is no longer available.'),
    } satisfies HostConfig;
    return {
      hostConfig,
      clearSecretReferences: () => {
        accessToken = undefined;
      },
    };
  }

  if (options.secret.authMode !== 'trusted-backend') {
    return invalidConfiguration(
      'The Windows secret does not match the configured authentication mode.',
    );
  }
  if (options.virtualProxyAlias) {
    return invalidConfiguration('Trusted-backend authentication cannot use a virtual-proxy alias.');
  }
  if (!url.port) url.port = '4747';
  const pfx = Uint8Array.from(options.secret.pfx);
  const mutableHostConfig: {
    authType: 'pfx';
    host: string;
    pfx: Uint8Array;
    passphrase?: string;
    userHeader: string;
  } = {
    authType: 'pfx',
    host: url.toString().replace(/\/$/, ''),
    pfx,
    ...(options.secret.passphrase ? { passphrase: options.secret.passphrase } : {}),
    userHeader: options.secret.userHeader,
  };
  return {
    hostConfig: mutableHostConfig,
    clearSecretReferences: () => {
      pfx.fill(0);
      mutableHostConfig.passphrase = undefined;
      mutableHostConfig.userHeader = '';
    },
  };
}

function fieldFromDescription(field: NxFieldDescription): CatalogField | undefined {
  const label = nonEmptyString(field.qName);
  if (!label || field.qIsHidden || field.qIsSystem || !tagsAreVisible(field.qTags))
    return undefined;
  const semantic = semanticType(field.qTags);
  const role = field.qIsImplicit ? 'measure' : 'dimension';
  return {
    id: stableId('field', role, label),
    label,
    role,
    semanticType: semantic,
    cardinality: cardinality(field.qCardinal, semantic),
    visible: true,
  };
}

function masterItem(
  item: DimensionListItem | MeasureListItem,
  kind: 'dimension' | 'measure',
): CatalogMasterItem | undefined {
  const id = nonEmptyString(item.qInfo?.qId);
  const label = nonEmptyString(item.qData?.title);
  const tags = item.qData?.tags;
  if (!id || !label || !tagsAreVisible(tags)) return undefined;
  return {
    id,
    label,
    kind,
    semanticType: kind === 'measure' ? 'numeric' : semanticType(tags),
    visible: true,
  };
}

function sheetSummary(
  item: SheetListItem,
  connection: string,
  appId: string,
  writeTarget: WindowsWriteTarget | undefined,
): SheetSummary | undefined {
  const sheetId = nonEmptyString(item.qInfo?.qId);
  if (!sheetId) return undefined;
  return {
    sheetId,
    name: nonEmptyString(item.qData?.title) ?? sheetId,
    writeAllowed:
      writeTarget?.connection === connection &&
      writeTarget.appId === appId &&
      writeTarget.sheetId === sheetId,
  };
}

function assertCatalogNotEmpty(catalog: CatalogDefinition): void {
  if (catalog.fields.length === 0 && catalog.masterItems.length === 0) {
    throw createError('EMPTY_CATALOG');
  }
}

function appSummary(entry: DocListEntry, connection: string): AppSummary | undefined {
  const appId = nonEmptyString(entry.qDocId);
  if (!appId) return undefined;
  return {
    appId,
    name: nonEmptyString(entry.qTitle) ?? nonEmptyString(entry.qDocName) ?? appId,
    connection,
    platform: 'windows',
    environment: 'client-managed',
  };
}

function qixCell(cell: NxCell): QixMatrixCell {
  const qNum = cell.qNum;
  return {
    qText:
      typeof cell.qText === 'string'
        ? cell.qText
        : typeof qNum === 'number' && Number.isFinite(qNum)
          ? String(qNum)
          : '',
    ...(typeof qNum === 'number' ? { qNum: Number.isFinite(qNum) ? qNum : ('NaN' as const) } : {}),
  };
}

function qixDataPage(page: NxDataPage | undefined, totalRows: number): QixDataPage {
  return {
    qMatrix: (page?.qMatrix ?? []).map((row) => row.map(qixCell)),
    qRowCount: totalRows,
  };
}

function objectInfo(properties: Record<string, unknown>): {
  readonly id?: string;
  readonly type?: string;
} {
  const qInfo = asRecord(properties.qInfo);
  return { id: nonEmptyString(qInfo?.qId), type: nonEmptyString(qInfo?.qType) };
}

function titleFromProperties(properties: Record<string, unknown>, fallback: string): string {
  const qMetaDef = asRecord(properties.qMetaDef);
  return nonEmptyString(qMetaDef?.title) ?? nonEmptyString(properties.title) ?? fallback;
}

function isSheetCell(value: unknown): value is SheetCell {
  const record = asRecord(value);
  return Boolean(
    nonEmptyString(record?.name) &&
    nonEmptyString(record?.type) &&
    typeof record?.col === 'number' &&
    Number.isFinite(record.col) &&
    record.col >= 0 &&
    typeof record?.row === 'number' &&
    Number.isFinite(record.row) &&
    record.row >= 0 &&
    typeof record.colspan === 'number' &&
    Number.isFinite(record.colspan) &&
    record.colspan > 0 &&
    typeof record.rowspan === 'number' &&
    Number.isFinite(record.rowspan) &&
    record.rowspan > 0,
  );
}

function attachmentId(sheetId: string, objectId: string): string {
  return stableId('harness-link', sheetId, objectId);
}

function isEvaluatedLayout(layout: AnyGenericObjectLayout, objectId: string): boolean {
  if (layout.qError || layout.qInfo?.qId !== objectId) return false;
  const cube = layout.qHyperCube;
  return Boolean(cube && !cube.qError && !cube.qCalcCondMsg);
}

/** Real `@qlik/api` QIX factory for Qlik Sense Enterprise on Windows. */
export class QlikWindowsEngineSessionFactory implements WindowsEngineSessionFactory {
  private readonly openAppSession: QlikOpenAppSession;
  private readonly createIdentity: () => string;

  constructor(options: QlikWindowsEngineSessionFactoryOptions = {}) {
    this.openAppSession = options.openAppSession ?? qix.openAppSession;
    this.createIdentity = options.createIdentity ?? randomUUID;
  }

  async open(options: {
    readonly connection: string;
    readonly serverAlias: string;
    readonly virtualProxyAlias?: string;
    readonly discoveryAppId?: string;
    readonly writeTarget?: WindowsWriteTarget;
    readonly authMode: 'proxy-session' | 'trusted-backend';
    readonly secret: WindowsSecret;
  }): Promise<WindowsEngineSession> {
    const built = buildHostConfig(options);
    return new QlikWindowsEngineSession({
      connection: options.connection,
      ...(options.discoveryAppId ? { discoveryAppId: options.discoveryAppId } : {}),
      ...(options.writeTarget ? { writeTarget: options.writeTarget } : {}),
      hostConfig: built.hostConfig,
      clearSecretReferences: built.clearSecretReferences,
      openAppSession: this.openAppSession,
      createIdentity: this.createIdentity,
    });
  }
}

class QlikWindowsEngineSession implements WindowsEngineSession {
  private readonly activeAppSessions = new Set<AppSession>();
  private readonly sessionObjectOwners = new Map<string, SessionObjectOwner>();
  private closed = false;

  constructor(
    private readonly options: {
      readonly connection: string;
      readonly discoveryAppId?: string;
      readonly writeTarget?: WindowsWriteTarget;
      readonly hostConfig: HostConfig;
      readonly clearSecretReferences: () => void;
      readonly openAppSession: QlikOpenAppSession;
      readonly createIdentity: () => string;
    },
  ) {}

  private assertOpen(): void {
    if (this.closed) {
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'The Windows Engine session is already closed.',
      });
    }
  }

  private async openApp(appId: string): Promise<AppHandle> {
    this.assertOpen();
    if (!appId.trim()) return invalidConfiguration('A Windows app identifier is required.');
    const identityDigest = stableId('session', this.options.createIdentity());
    const appSession = this.options.openAppSession({
      appId,
      identity: identityDigest,
      hostConfig: this.options.hostConfig,
    });
    this.activeAppSessions.add(appSession);
    try {
      return { appSession, doc: await appSession.getDoc() };
    } catch (error) {
      await this.closeAppSession(appSession);
      throw error;
    }
  }

  private async closeAppSession(appSession: AppSession): Promise<void> {
    this.activeAppSessions.delete(appSession);
    try {
      await appSession.close({ websocketCloseDelay: 0 });
    } catch {
      // Transport close errors are deliberately suppressed and never exposed.
    }
  }

  private async withApp<T>(appId: string, fn: (doc: Doc) => Promise<T>): Promise<T> {
    const handle = await this.openApp(appId);
    try {
      return await fn(handle.doc);
    } finally {
      await this.closeAppSession(handle.appSession);
    }
  }

  private async loadCatalog(appId: string, doc: Doc): Promise<LiveCatalog> {
    const [fieldList, dimensionList, measureList, sheetList] = await Promise.all([
      doc.getFieldList(),
      doc.getDimensionList(),
      doc.getMeasureList(),
      doc.getSheetList(),
    ]);
    const fields = fieldList
      .map(fieldFromDescription)
      .filter((field): field is CatalogField => Boolean(field))
      .sort((left, right) => left.id.localeCompare(right.id));
    const masterItems = [
      ...dimensionList.map((item) => masterItem(item, 'dimension')),
      ...measureList.map((item) => masterItem(item, 'measure')),
    ]
      .filter((item): item is CatalogMasterItem => Boolean(item))
      .sort((left, right) => left.id.localeCompare(right.id));
    const sheets = sheetList
      .map((item) => sheetSummary(item, this.options.connection, appId, this.options.writeTarget))
      .filter((sheet): sheet is SheetSummary => Boolean(sheet))
      .sort((left, right) => left.sheetId.localeCompare(right.sheetId));
    const catalogHash = createHash('sha256')
      .update(JSON.stringify({ fields, masterItems, sheets }))
      .digest('hex')
      .slice(0, 24);
    const definition: CatalogDefinition = {
      catalogId: `windows-live-${catalogHash}`,
      description: 'Policy-filtered live Qlik Sense Enterprise on Windows metadata.',
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
      chartSupport: WINDOWS_CHART_SUPPORT,
      excludedMetadataExamples: [],
      excludedResponseProperties: [
        'rawData',
        'loadScript',
        'dataConnections',
        'securityRules',
        'qixHandles',
        'credentials',
      ],
    };
    assertCatalogNotEmpty(definition);
    return { definition, sheets };
  }

  async listAccessibleApps(_actor: ActorContext, page?: PageRequest): Promise<ListAppsResult> {
    const discoveryAppId = this.options.discoveryAppId?.trim();
    if (!discoveryAppId) {
      return invalidConfiguration(
        'Windows app discovery requires an approved bootstrap app identifier.',
      );
    }
    return this.withApp(discoveryAppId, async (doc) => {
      const apps = (await doc.global.getDocList())
        .map((entry) => appSummary(entry, this.options.connection))
        .filter((app): app is AppSummary => Boolean(app))
        .sort((left, right) => left.appId.localeCompare(right.appId));
      const selected = paginate(apps, page);
      return {
        apps: selected.items,
        truncated: selected.truncated,
        ...(selected.nextPageToken ? { nextPageToken: selected.nextPageToken } : {}),
      };
    });
  }

  async getCompilationContext(
    appId: string,
    _actor: ActorContext,
    variant?: CatalogVariant,
  ): Promise<CompilationContext> {
    assertDefaultVariant(variant);
    return this.withApp(appId, async (doc) => {
      const loaded = await this.loadCatalog(appId, doc);
      return { catalog: loaded.definition, sheets: loaded.sheets };
    });
  }

  async getSemanticCatalog(
    appId: string,
    _actor: ActorContext,
    variant?: CatalogVariant,
    page?: PageRequest,
  ): Promise<CatalogResult> {
    assertDefaultVariant(variant);
    return this.withApp(appId, async (doc) => {
      const loaded = await this.loadCatalog(appId, doc);
      const entries = [
        ...loaded.definition.fields.map((value) => ({ kind: value.role, value }) as const),
        ...loaded.definition.masterItems.map((value) => ({ kind: 'master', value }) as const),
        ...loaded.sheets.map((value) => ({ kind: 'sheet', value }) as const),
      ];
      const selected = paginate(entries, page);
      return {
        appId,
        connection: this.options.connection,
        catalogId: loaded.definition.catalogId,
        dimensions: selected.items
          .filter((entry) => entry.kind === 'dimension')
          .map((entry) => entry.value as CatalogField),
        measures: selected.items
          .filter((entry) => entry.kind === 'measure')
          .map((entry) => entry.value as CatalogField),
        masterItems: selected.items
          .filter((entry) => entry.kind === 'master')
          .map((entry) => entry.value as CatalogMasterItem),
        sheets: selected.items
          .filter((entry) => entry.kind === 'sheet')
          .map((entry) => entry.value as SheetSummary),
        chartTypes: loaded.definition.chartSupport,
        truncated: selected.truncated,
        ...(selected.nextPageToken ? { nextPageToken: selected.nextPageToken } : {}),
      };
    });
  }

  async listSheetObjects(
    appId: string,
    sheetId: string,
    _actor: ActorContext,
    page?: PageRequest,
  ): Promise<ListSheetObjectsResult> {
    return this.withApp(appId, async (doc) => {
      const sheet = await doc.getObject<LiveGenericObject>(sheetId);
      const selected = paginate(
        (await sheet.getChildInfos())
          .filter((info) => nonEmptyString(info.qId))
          .sort((left, right) => (left.qId ?? '').localeCompare(right.qId ?? '')),
        page,
      );
      const objects = await Promise.all(
        selected.items.map(async (info): Promise<SheetObjectSummary> => {
          const objectId = info.qId!;
          const child = await sheet.getChild<LiveGenericObject>(objectId);
          const properties = (await child.getProperties()) as Record<string, unknown>;
          return {
            objectId,
            type: nonEmptyString(info.qType) ?? objectInfo(properties).type ?? 'unknown',
            title: titleFromProperties(properties, objectId),
          };
        }),
      );
      return {
        objects,
        truncated: selected.truncated,
        ...(selected.nextPageToken ? { nextPageToken: selected.nextPageToken } : {}),
      };
    });
  }

  async createSessionChart(request: CreateSessionChartRequest): Promise<CreateSessionChartResult> {
    request.signal.throwIfAborted();
    const handle = await this.openApp(request.target.appId);
    let objectId: string | undefined;
    try {
      request.signal.throwIfAborted();
      const proposedInfo = asRecord(request.plan.propertyProposal.qInfo);
      const requestedId = stableId('harness-session-object', this.options.createIdentity());
      const properties = {
        ...request.plan.propertyProposal,
        qInfo: {
          ...proposedInfo,
          qId: requestedId,
          qType: request.plan.nativeChartType,
        },
      };
      const object = await handle.doc.createSessionObject<
        Record<string, unknown>,
        LiveGenericObject
      >(properties);
      objectId = nonEmptyString(object.id);
      if (!objectId) {
        throw createError('TRANSIENT_UNAVAILABLE', {
          message: 'The Windows Engine did not return a session-object identifier.',
        });
      }
      request.signal.throwIfAborted();
      const layout = await object.getLayout();
      const cube = layout.qHyperCube;
      if (!cube || layout.qError || cube.qError || cube.qCalcCondMsg) {
        throw createError('INVALID_CHART_CONFIGURATION', {
          message: 'The Windows Engine could not evaluate the compiled chart properties.',
        });
      }
      const width = Math.max(
        1,
        request.plan.resolved.dimensions.length + request.plan.resolved.measures.length,
      );
      const dataPages = await object.getHyperCubeData('/qHyperCubeDef', [
        { qTop: 0, qLeft: 0, qWidth: width, qHeight: request.plan.resultLimit },
      ]);
      request.signal.throwIfAborted();
      const totalRows = Math.max(0, cube.qSize?.qcy ?? dataPages[0]?.qMatrix?.length ?? 0);
      const page = qixDataPage(dataPages[0], totalRows);
      const returnedRows = page.qMatrix.length;
      const mode = cube.qMode === 'K' || cube.qMode === 'DATA_MODE_PIVOT_STACK' ? 'K' : 'S';
      this.sessionObjectOwners.set(objectId, {
        appId: request.target.appId,
        appSession: handle.appSession,
        doc: handle.doc,
      });
      return {
        sessionObjectId: objectId,
        layout: {
          objectId,
          objectType: nonEmptyString(layout.qInfo?.qType) ?? request.plan.nativeChartType,
          title: request.plan.title,
          qInfo: { type: request.plan.nativeChartType, id: objectId },
          qHyperCube: {
            qSize: { qcx: Math.max(0, cube.qSize?.qcx ?? width), qcy: totalRows },
            qMode: mode,
            qDimensionInfo: request.plan.resolved.dimensions.map((dimension, index) => ({
              qFallbackTitle:
                nonEmptyString(cube.qDimensionInfo?.[index]?.qFallbackTitle) ?? dimension.label,
              ...(typeof cube.qDimensionInfo?.[index]?.qCardinal === 'number'
                ? { qCardinal: cube.qDimensionInfo[index]!.qCardinal }
                : {}),
            })),
            qMeasureInfo: request.plan.resolved.measures.map((measure, index) => ({
              qFallbackTitle:
                nonEmptyString(cube.qMeasureInfo?.[index]?.qFallbackTitle) ?? measure.label,
            })),
            qDataPages: [page],
          },
          bounded: {
            returnedRows,
            maxRows: request.plan.resultLimit,
            truncated: totalRows > returnedRows,
            rawDataIncluded: false,
            ...(totalRows > returnedRows ? { continuation: `windows:${returnedRows}` } : {}),
          },
        },
      };
    } catch (error) {
      if (objectId) {
        try {
          await handle.doc.destroySessionObject(objectId);
        } catch {
          // Best-effort cleanup; the originating app session is closed below.
        }
      }
      await this.closeAppSession(handle.appSession);
      throw error;
    }
  }

  async disposeSessionChart(sessionObjectId: string): Promise<void> {
    const owner = this.sessionObjectOwners.get(sessionObjectId);
    if (!owner) return;
    this.sessionObjectOwners.delete(sessionObjectId);
    let failure: unknown;
    try {
      if (!(await owner.doc.destroySessionObject(sessionObjectId))) {
        failure = createError('TRANSIENT_UNAVAILABLE', {
          message: 'The Windows Engine did not acknowledge session-object disposal.',
        });
      }
    } catch (error) {
      failure = error;
    } finally {
      await this.closeAppSession(owner.appSession);
    }
    if (failure) throw failure;
  }

  async persistChart(request: PersistChartRequest): Promise<PersistChartResult> {
    return this.withApp(request.target.appId, async (doc) => {
      const object = await doc.createObject<Record<string, unknown>, LiveGenericObject>(
        request.plan.propertyProposal,
      );
      const objectId = nonEmptyString(object.id);
      if (!objectId) {
        throw createError('TRANSIENT_UNAVAILABLE', {
          message: 'The Windows Engine did not return a persistent object identifier.',
        });
      }
      return { objectId };
    });
  }

  async attachChartToSheet(request: AttachChartRequest): Promise<AttachChartResult> {
    return this.withApp(request.target.appId, async (doc) => {
      const sheet = await doc.getObject<LiveGenericObject>(request.target.sheetId);
      const linkedObjectId = attachmentId(request.target.sheetId, request.objectId);
      const existing = (await sheet.getChildInfos()).find((info) => info.qId === linkedObjectId);
      if (existing) {
        const child = await sheet.getChild<LiveGenericObject>(linkedObjectId);
        const properties = (await child.getProperties()) as Record<string, unknown>;
        if (properties.qExtendsId !== request.objectId) {
          throw createError('IDEMPOTENCY_CONFLICT', {
            message: 'The deterministic Windows sheet-child identifier is already in use.',
          });
        }
        return { sheetAttachmentId: linkedObjectId };
      }

      const source = await doc.getObject<LiveGenericObject>(request.objectId);
      const sourceProperties = (await source.getProperties()) as Record<string, unknown>;
      const sourceType = objectInfo(sourceProperties).type;
      if (!sourceType) {
        throw createError('INVALID_CHART_CONFIGURATION', {
          message: 'The persistent Windows object has no native visualization type.',
        });
      }
      const sheetProperties = (await sheet.getProperties()) as Record<string, unknown>;
      const existingCells = Array.isArray(sheetProperties.cells) ? sheetProperties.cells : [];
      const nextRow = existingCells
        .filter(isSheetCell)
        .reduce((maximum, cell) => Math.max(maximum, cell.row + cell.rowspan), 0);
      const columns =
        typeof sheetProperties.columns === 'number' && sheetProperties.columns > 0
          ? Math.floor(sheetProperties.columns)
          : DEFAULT_SHEET_COLUMNS;
      const cell: SheetCell = {
        name: linkedObjectId,
        type: sourceType,
        col: 0,
        row: nextRow,
        colspan: columns,
        rowspan: DEFAULT_CHART_ROW_SPAN,
      };
      const parentProperties = {
        ...sheetProperties,
        rows: Math.max(
          typeof sheetProperties.rows === 'number' ? sheetProperties.rows : 0,
          nextRow + DEFAULT_CHART_ROW_SPAN,
        ),
        cells: [...existingCells, cell],
      };
      const child = await sheet.createChild<Record<string, unknown>, LiveGenericObject>(
        {
          qInfo: { qId: linkedObjectId, qType: sourceType },
          qExtendsId: request.objectId,
        },
        parentProperties,
      );
      const actualId = nonEmptyString(child.id);
      if (actualId !== linkedObjectId) {
        if (actualId) {
          try {
            await sheet.destroyChild(actualId, {
              ...sheetProperties,
              cells: existingCells,
            });
          } catch {
            // The apply layer will record partial failure and require cleanup.
          }
        }
        throw createError('PARTIAL_APPLY', {
          message: 'The Windows Engine could not reserve the deterministic sheet-child identifier.',
        });
      }
      return { sheetAttachmentId: linkedObjectId };
    });
  }

  async verifyChart(request: VerifyChartRequest): Promise<VerifyChartResult> {
    return this.withApp(request.target.appId, async (doc) => {
      const object = await doc.getObject<LiveGenericObject>(request.objectId);
      const layout = await object.getLayout();
      if (!isEvaluatedLayout(layout, request.objectId)) return { verified: false };
      const sheet = await doc.getObject<LiveGenericObject>(request.target.sheetId);
      const linkedObjectId = attachmentId(request.target.sheetId, request.objectId);
      if (!(await sheet.getChildInfos()).some((info) => info.qId === linkedObjectId)) {
        return { verified: false };
      }
      const sheetProperties = (await sheet.getProperties()) as Record<string, unknown>;
      const cells = Array.isArray(sheetProperties.cells) ? sheetProperties.cells : [];
      const matchingCell = cells.find(
        (cell): cell is SheetCell => isSheetCell(cell) && cell.name === linkedObjectId,
      );
      if (!matchingCell) return { verified: false };
      const child = await sheet.getChild<LiveGenericObject>(linkedObjectId);
      const childProperties = (await child.getProperties()) as Record<string, unknown>;
      return {
        verified:
          childProperties.qExtendsId === request.objectId &&
          objectInfo(childProperties).type === matchingCell.type,
      };
    });
  }

  async cleanupObject(request: CleanupRequest): Promise<CleanupResult> {
    return this.withApp(request.target.appId, async (doc) => {
      let failed = false;
      if (request.sheetAttachmentId) {
        try {
          const sheet = await doc.getObject<LiveGenericObject>(request.target.sheetId);
          const sheetProperties = (await sheet.getProperties()) as Record<string, unknown>;
          const existingCells = Array.isArray(sheetProperties.cells) ? sheetProperties.cells : [];
          const parentProperties = {
            ...sheetProperties,
            cells: existingCells.filter(
              (cell) => nonEmptyString(asRecord(cell)?.name) !== request.sheetAttachmentId,
            ),
          };
          if (!(await sheet.destroyChild(request.sheetAttachmentId, parentProperties))) {
            failed = true;
          }
        } catch {
          failed = true;
        }
      }
      try {
        if (!(await doc.destroyObject(request.objectId))) failed = true;
      } catch {
        failed = true;
      }
      return { attempted: true, outcome: failed ? 'cleanup-failed' : 'cleanup-complete' };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const owners = [...this.sessionObjectOwners.entries()];
    this.sessionObjectOwners.clear();
    for (const [sessionObjectId, owner] of owners) {
      try {
        await owner.doc.destroySessionObject(sessionObjectId);
      } catch {
        // Closing the same originating app session below is the final cleanup boundary.
      }
    }
    await Promise.all([...this.activeAppSessions].map((session) => this.closeAppSession(session)));
    this.options.clearSecretReferences();
  }
}
