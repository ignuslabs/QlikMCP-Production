import { derivePlanHash } from '../compiler/planHash.js';
import { resolveVisualizationSchema } from '../compiler/chartTypeRegistry.js';
import { computePlanHash } from '../domain/ids.js';
import { findForbiddenPaths } from '../domain/redaction.js';
import {
  CHART_TYPE_IDS,
  VISUALIZATION_SCHEMA_PROFILE_IDS,
  type CompactDiff,
  type NativeChartType,
  type ResolvedChartPlan,
  type ResolvedFieldRef,
  type ResolvedFilterRef,
  type ResolvedMeasureRef,
  type VisualizationSchemaProfileId,
} from '../domain/types.js';
import {
  configuredStatePath,
  isRecord,
  readJsonState,
  requireString,
  withStateFileLockSync,
  writeJsonStateAtomic,
} from './filePersistence.js';
import type { Awaitable } from './storeTypes.js';

export interface StoredPlan {
  /** Authenticated principal that owns this plan's operation and audit context. */
  readonly ownerActor: string;
  readonly plan: ResolvedChartPlan;
  readonly operationId: string;
  readonly correlationId: string;
  /** Retained because the target value participates in the canonical plan hash. */
  readonly presentationTarget: number | null;
}

export interface PlanRepository {
  save(stored: StoredPlan): Awaitable<void>;
  get(ownerActor: string, planHash: string): Awaitable<StoredPlan | undefined>;
}

interface DurablePlanRecord extends StoredPlan {
  /** Covers the native property proposal and metadata not included in planHash. */
  readonly integrityHash: string;
}

interface PlanStateFile {
  readonly version: 2;
  readonly plans: Readonly<Record<string, DurablePlanRecord>>;
}

const PLAN_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PLATFORMS = new Set(['cloud', 'windows', 'fixture']);
const RISK_CLASSES = new Set(['standard', 'elevated', 'restricted']);
const SORT_OPTIONS = new Set([
  'measure-descending',
  'measure-ascending',
  'dimension-ascending',
  'dimension-descending',
  'none',
]);
const NATIVE_CHART_TYPES = new Set<NativeChartType>([
  'barchart',
  'linechart',
  'scatterplot',
  'table',
  'sn-table',
  'kpi',
  'gauge',
  'treemap',
  'piechart',
  'combochart',
]);
const MAX_ACTOR_LENGTH = 512;
const MAX_PLAN_LOOKUP_LENGTH = 128;

export function validatePlanOwnerActor(ownerActor: unknown): string {
  if (
    typeof ownerActor !== 'string' ||
    ownerActor.length === 0 ||
    ownerActor.length > MAX_ACTOR_LENGTH ||
    ownerActor.trim() !== ownerActor
  ) {
    throw new Error(
      `Durable plan ownerActor must be a trimmed non-empty string no longer than ${MAX_ACTOR_LENGTH} characters.`,
    );
  }
  return ownerActor;
}

function validatePlanLookupHash(planHash: unknown): string {
  if (
    typeof planHash !== 'string' ||
    planHash.length === 0 ||
    planHash.length > MAX_PLAN_LOOKUP_LENGTH
  ) {
    throw new Error(
      `Durable plan lookup hash must be a non-empty string no longer than ${MAX_PLAN_LOOKUP_LENGTH} characters.`,
    );
  }
  return planHash;
}

/** Opaque composite key that prevents an actor-controlled identifier from changing key structure. */
export function planOwnershipKey(ownerActor: string, planHash: string): string {
  return computePlanHash({
    ownerActor: validatePlanOwnerActor(ownerActor),
    planHash: validatePlanLookupHash(planHash),
  });
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  description: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`Durable ${description} contains an unexpected field.`);
  }
}

function requireOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  if (entry === undefined) return undefined;
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error(`Durable plan field ${key} must be a non-empty string when present.`);
  }
  return entry;
}

function requireStringArray(
  value: Record<string, unknown>,
  key: string,
  minimumLength = 0,
): readonly string[] {
  const entries = value[key];
  if (
    !Array.isArray(entries) ||
    entries.length < minimumLength ||
    !entries.every((entry) => typeof entry === 'string')
  ) {
    throw new Error(`Durable plan field ${key} must be a string array.`);
  }
  return entries;
}

function validateTimestamp(value: Record<string, unknown>, key: string): string {
  const timestamp = requireString(value, key);
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`Durable plan field ${key} must be an ISO timestamp.`);
  }
  return timestamp;
}

function validateResolvedField(value: unknown, role: 'dimension'): ResolvedFieldRef;
function validateResolvedField(value: unknown, role: 'measure'): ResolvedMeasureRef;
function validateResolvedField(
  value: unknown,
  role: 'dimension' | 'measure',
): ResolvedFieldRef | ResolvedMeasureRef {
  if (!isRecord(value)) throw new Error('Durable plan resolved field must be an object.');
  assertOnlyKeys(
    value,
    [
      'catalogId',
      'masterItemId',
      'label',
      'role',
      'semanticType',
      ...(role === 'measure' ? ['expression'] : []),
    ],
    'plan resolved field',
  );
  const catalogId = requireString(value, 'catalogId');
  const label = requireString(value, 'label');
  if (value.role !== role) {
    throw new Error(`Durable plan resolved field must have role ${role}.`);
  }
  const masterItemId = requireOptionalString(value, 'masterItemId');
  const semanticType = requireOptionalString(value, 'semanticType');
  if (role === 'measure') {
    return {
      catalogId,
      label,
      role,
      expression: requireString(value, 'expression'),
      ...(masterItemId ? { masterItemId } : {}),
      ...(semanticType ? { semanticType } : {}),
    };
  }
  return {
    catalogId,
    label,
    role,
    ...(masterItemId ? { masterItemId } : {}),
    ...(semanticType ? { semanticType } : {}),
  };
}

function validateResolvedFilter(value: unknown): ResolvedFilterRef {
  if (!isRecord(value)) throw new Error('Durable plan resolved filter must be an object.');
  assertOnlyKeys(value, ['catalogId', 'label', 'values'], 'plan resolved filter');
  return {
    catalogId: requireString(value, 'catalogId'),
    label: requireString(value, 'label'),
    values: requireStringArray(value, 'values', 1),
  };
}

function validateDiff(value: unknown): CompactDiff {
  if (!isRecord(value)) throw new Error('Durable plan diff must be an object.');
  assertOnlyKeys(value, ['summary', 'additions', 'removals'], 'plan diff');
  return {
    summary: requireString(value, 'summary'),
    additions: requireStringArray(value, 'additions'),
    removals: requireStringArray(value, 'removals'),
  };
}

function validatePlan(value: unknown): ResolvedChartPlan {
  if (!isRecord(value)) throw new Error('Durable plan must be an object.');
  assertOnlyKeys(
    value,
    [
      'planHash',
      'compilerVersion',
      'intentVersion',
      'catalogId',
      'target',
      'platform',
      'visualizationSchemaProfile',
      'visualizationSchemaVersion',
      'chartType',
      'nativeChartType',
      'resolved',
      'title',
      'sort',
      'resultLimit',
      'riskClass',
      'warnings',
      'diff',
      'propertyProposal',
      'createdAt',
      'expiresAt',
    ],
    'plan',
  );

  const planHash = requireString(value, 'planHash');
  if (!PLAN_HASH_PATTERN.test(planHash)) {
    throw new Error('Durable plan has an invalid plan hash.');
  }
  if (!isRecord(value.target)) throw new Error('Durable plan target must be an object.');
  assertOnlyKeys(value.target, ['connection', 'appId', 'sheetId'], 'plan target');
  const target = {
    connection: requireString(value.target, 'connection'),
    appId: requireString(value.target, 'appId'),
    sheetId: requireString(value.target, 'sheetId'),
  };

  const platform = requireString(value, 'platform');
  if (!PLATFORMS.has(platform)) throw new Error('Durable plan has an invalid platform.');
  const visualizationSchemaProfile = requireString(value, 'visualizationSchemaProfile');
  if (
    !(VISUALIZATION_SCHEMA_PROFILE_IDS as readonly string[]).includes(visualizationSchemaProfile)
  ) {
    throw new Error('Durable plan has an invalid visualization schema profile.');
  }
  const visualizationSchemaVersion = requireOptionalString(value, 'visualizationSchemaVersion');
  const chartType = requireString(value, 'chartType');
  if (!(CHART_TYPE_IDS as readonly string[]).includes(chartType)) {
    throw new Error('Durable plan has an invalid chart type.');
  }
  const nativeChartType = requireString(value, 'nativeChartType');
  if (!NATIVE_CHART_TYPES.has(nativeChartType as NativeChartType)) {
    throw new Error('Durable plan has an invalid native chart type.');
  }

  const schema = resolveVisualizationSchema({
    chartType: chartType as ResolvedChartPlan['chartType'],
    platform: platform as ResolvedChartPlan['platform'],
    profile: visualizationSchemaProfile as VisualizationSchemaProfileId,
    ...(visualizationSchemaProfile === 'qlik-windows-november-2025-or-later' &&
    visualizationSchemaVersion
      ? { hostValidatedVersion: visualizationSchemaVersion }
      : {}),
  });
  if (
    schema.qlikInAppVisualizationId !== nativeChartType ||
    schema.propertySchemaVersion !== visualizationSchemaVersion
  ) {
    throw new Error('Durable plan visualization schema metadata is inconsistent.');
  }

  if (!isRecord(value.resolved)) throw new Error('Durable plan resolved must be an object.');
  assertOnlyKeys(value.resolved, ['dimensions', 'measures', 'filters'], 'plan resolved');
  if (!Array.isArray(value.resolved.dimensions) || !Array.isArray(value.resolved.measures)) {
    throw new Error('Durable plan resolved dimensions and measures must be arrays.');
  }
  if (!Array.isArray(value.resolved.filters)) {
    throw new Error('Durable plan resolved filters must be an array.');
  }
  const dimensions = value.resolved.dimensions.map((entry) =>
    validateResolvedField(entry, 'dimension'),
  );
  const measures = value.resolved.measures.map((entry) => validateResolvedField(entry, 'measure'));
  const filters = value.resolved.filters.map(validateResolvedFilter);
  if (measures.length === 0) throw new Error('Durable plan must contain a resolved measure.');

  const resultLimit = value.resultLimit;
  if (
    !Number.isInteger(resultLimit) ||
    (resultLimit as number) < 1 ||
    (resultLimit as number) > 50
  ) {
    throw new Error('Durable plan resultLimit must be an integer between 1 and 50.');
  }
  const sort = requireString(value, 'sort');
  if (!SORT_OPTIONS.has(sort)) throw new Error('Durable plan has an invalid sort mode.');
  const riskClass = requireString(value, 'riskClass');
  if (!RISK_CLASSES.has(riskClass)) throw new Error('Durable plan has an invalid risk class.');
  if (!isRecord(value.propertyProposal)) {
    throw new Error('Durable plan propertyProposal must be an object.');
  }
  if (!isRecord(value.propertyProposal.qInfo)) {
    throw new Error('Durable plan propertyProposal.qInfo must be an object.');
  }
  if (
    value.propertyProposal.qInfo.qType !== nativeChartType ||
    value.propertyProposal.qInfo.qId !== `native-${nativeChartType}-${planHash.slice(7, 19)}`
  ) {
    throw new Error('Durable plan property proposal identity is inconsistent.');
  }

  const createdAt = validateTimestamp(value, 'createdAt');
  const expiresAt = validateTimestamp(value, 'expiresAt');
  if (Date.parse(expiresAt) < Date.parse(createdAt)) {
    throw new Error('Durable plan expiry precedes its creation timestamp.');
  }
  return {
    planHash,
    compilerVersion: requireString(value, 'compilerVersion'),
    intentVersion: requireString(value, 'intentVersion'),
    catalogId: requireString(value, 'catalogId'),
    target,
    platform: platform as ResolvedChartPlan['platform'],
    visualizationSchemaProfile: visualizationSchemaProfile as VisualizationSchemaProfileId,
    ...(visualizationSchemaVersion ? { visualizationSchemaVersion } : {}),
    chartType: chartType as ResolvedChartPlan['chartType'],
    nativeChartType: nativeChartType as NativeChartType,
    resolved: { dimensions, measures, filters },
    title: requireString(value, 'title'),
    sort,
    resultLimit: resultLimit as number,
    riskClass: riskClass as ResolvedChartPlan['riskClass'],
    warnings: requireStringArray(value, 'warnings'),
    diff: validateDiff(value.diff),
    propertyProposal: value.propertyProposal,
    createdAt,
    expiresAt,
  };
}

function validateStoredPlan(value: unknown): StoredPlan {
  if (!isRecord(value)) throw new Error('Durable stored plan must be an object.');
  assertOnlyKeys(
    value,
    ['ownerActor', 'operationId', 'correlationId', 'presentationTarget', 'plan'],
    'stored plan',
  );
  const presentationTarget = value.presentationTarget;
  if (
    presentationTarget !== null &&
    (typeof presentationTarget !== 'number' || !Number.isFinite(presentationTarget))
  ) {
    throw new Error('Durable plan presentationTarget must be finite or null.');
  }
  const stored: StoredPlan = {
    ownerActor: validatePlanOwnerActor(value.ownerActor),
    operationId: requireString(value, 'operationId'),
    correlationId: requireString(value, 'correlationId'),
    presentationTarget,
    plan: validatePlan(value.plan),
  };
  if (findForbiddenPaths(stored).length > 0) {
    throw new Error('Refusing to retain a durable plan containing secret-like material.');
  }

  const expectedPlanHash = derivePlanHash({
    compilerVersion: stored.plan.compilerVersion,
    catalogId: stored.plan.catalogId,
    platform: stored.plan.platform,
    visualizationSchemaProfile: stored.plan.visualizationSchemaProfile!,
    visualizationSchemaVersion: stored.plan.visualizationSchemaVersion ?? null,
    target: stored.plan.target as Required<typeof stored.plan.target>,
    chartType: stored.plan.chartType,
    dimensions: stored.plan.resolved.dimensions.map((dimension) => ({
      catalogId: dimension.catalogId,
      label: dimension.label,
    })),
    measures: stored.plan.resolved.measures.map((measure) => ({
      catalogId: measure.catalogId,
      expression: measure.expression,
    })),
    filters: stored.plan.resolved.filters.map((filter) => ({
      catalogId: filter.catalogId,
      values: [...filter.values].sort(),
    })),
    presentation: {
      title: stored.plan.title,
      sort: stored.plan.sort,
      target: stored.presentationTarget,
      resultLimit: stored.plan.resultLimit,
    },
  });
  if (stored.plan.planHash !== expectedPlanHash) {
    throw new Error('Durable plan hash does not match its canonical compiler input.');
  }
  return stored;
}

export function durableRecord(stored: StoredPlan): DurablePlanRecord {
  const validated = validateStoredPlan(stored);
  return { ...validated, integrityHash: computePlanHash(validated) };
}

export function storedRecord(record: DurablePlanRecord): StoredPlan {
  return {
    ownerActor: record.ownerActor,
    operationId: record.operationId,
    correlationId: record.correlationId,
    presentationTarget: record.presentationTarget,
    plan: record.plan,
  };
}

export function validateDurableRecord(value: unknown): DurablePlanRecord {
  if (!isRecord(value)) throw new Error('Durable plan record must be an object.');
  assertOnlyKeys(
    value,
    ['ownerActor', 'operationId', 'correlationId', 'presentationTarget', 'plan', 'integrityHash'],
    'plan record',
  );
  const stored = validateStoredPlan({
    ownerActor: value.ownerActor,
    operationId: value.operationId,
    correlationId: value.correlationId,
    presentationTarget: value.presentationTarget,
    plan: value.plan,
  });
  const integrityHash = requireString(value, 'integrityHash');
  if (!PLAN_HASH_PATTERN.test(integrityHash) || integrityHash !== computePlanHash(stored)) {
    throw new Error('Durable plan integrity hash does not match its stored content.');
  }
  return { ...stored, integrityHash };
}

function validateState(value: unknown): PlanStateFile {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.plans)) {
    throw new Error('Durable plan state has an unsupported shape or version.');
  }
  assertOnlyKeys(value, ['version', 'plans'], 'plan state');
  const plans = Object.fromEntries(
    Object.entries(value.plans).map(([storedKey, rawRecord]) => {
      const record = validateDurableRecord(rawRecord);
      if (planOwnershipKey(record.ownerActor, record.plan.planHash) !== storedKey) {
        throw new Error('Durable plan key does not match its actor ownership and plan hash.');
      }
      return [storedKey, record];
    }),
  );
  return { version: 2, plans };
}

/** In-memory plan state with an optional durable file implementation below. */
export class PlanStore {
  protected plans = new Map<string, StoredPlan>();

  save(stored: StoredPlan): void {
    const validated = validateStoredPlan(stored);
    this.plans.set(planOwnershipKey(validated.ownerActor, validated.plan.planHash), validated);
  }

  get(ownerActor: string, planHash: string): StoredPlan | undefined {
    const stored = this.plans.get(planOwnershipKey(ownerActor, planHash));
    return stored ? validateStoredPlan(stored) : undefined;
  }
}

export class FilePlanStore extends PlanStore {
  constructor(private readonly filePath: string) {
    super();
    this.reload();
  }

  override save(stored: StoredPlan): void {
    const validated = validateStoredPlan(stored);
    withStateFileLockSync(this.filePath, () => {
      const state = this.readAll();
      const plans = {
        ...state.plans,
        [planOwnershipKey(validated.ownerActor, validated.plan.planHash)]: durableRecord(validated),
      };
      writeJsonStateAtomic(this.filePath, { version: 2, plans } satisfies PlanStateFile);
      this.plans = new Map(
        Object.entries(plans).map(([storedKey, record]) => [storedKey, storedRecord(record)]),
      );
    });
  }

  override get(ownerActor: string, planHash: string): StoredPlan | undefined {
    this.reload();
    return super.get(ownerActor, planHash);
  }

  private readAll(): PlanStateFile {
    const raw = readJsonState(this.filePath);
    return raw === undefined ? { version: 2, plans: {} } : validateState(raw);
  }

  private reload(): void {
    const state = this.readAll();
    this.plans = new Map(
      Object.entries(state.plans).map(([storedKey, record]) => [storedKey, storedRecord(record)]),
    );
  }
}

export function createDefaultPlanStore(): PlanStore {
  const filePath = configuredStatePath('QLIK_HARNESS_PLAN_STORE_PATH', 'plans.json');
  return filePath ? new FilePlanStore(filePath) : new PlanStore();
}
