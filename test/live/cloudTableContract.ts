import {
  VISUALIZATION_REGISTRY,
  VISUALIZATION_SCHEMA_PROFILES,
} from '../../src/compiler/chartTypeRegistry.js';
import {
  classifyMeasureReference,
  isPlainDimensionReference,
  type MeasureReferenceFormat,
} from '../../src/compiler/expressionGrammar.js';
import { createError } from '../../src/domain/errors.js';
import type { CreateSessionChartResult } from '../../src/adapters/targetAdapter.js';
import type { ResolvedChartPlan } from '../../src/domain/types.js';

export const CLOUD_VISUALIZATION_SCHEMA_PROFILE = 'qlik-cloud-current' as const;
const CLOUD_TABLE_DEFINITION = VISUALIZATION_REGISTRY.table;
export const CLOUD_TABLE_NATIVE_TYPE =
  CLOUD_TABLE_DEFINITION.profiles[CLOUD_VISUALIZATION_SCHEMA_PROFILE].qlikInAppVisualizationId;
const CLOUD_PROFILE_SCHEMA_VERSION =
  VISUALIZATION_SCHEMA_PROFILES[CLOUD_VISUALIZATION_SCHEMA_PROFILE].pinnedSnTablePropertyVersion;
if (!CLOUD_PROFILE_SCHEMA_VERSION) {
  throw new Error('The current Cloud visualization profile must pin an sn-table schema version.');
}
export const CLOUD_TABLE_SCHEMA_VERSION = CLOUD_PROFILE_SCHEMA_VERSION;

export type CloudProbeFieldRole = 'dimension' | 'measure';

export interface ParsedCloudProbeFieldReference {
  readonly value: string;
  readonly format: 'catalog-label' | MeasureReferenceFormat;
}

export interface CloudProbeInputContractSummary {
  readonly dimension: {
    readonly format: 'catalog-label';
    readonly resolvedSource: 'field' | 'master-item';
    readonly roleMatched: true;
  };
  readonly measure: {
    readonly format: MeasureReferenceFormat;
    readonly resolvedSource: 'field' | 'master-item';
    readonly roleMatched: true;
  };
}

export interface CloudPreviewLayoutDiagnostics {
  readonly diagnosticVersion: 'cloud-preview-layout-v1';
  readonly passed: boolean;
  readonly inputContract: CloudProbeInputContractSummary;
  readonly checks: {
    readonly objectIdMatchesSession: boolean;
    readonly qInfoIdMatchesSession: boolean;
    readonly objectTypeMatches: boolean;
    readonly qInfoTypeMatches: boolean;
    readonly cubeModeMatches: boolean;
    readonly columnCountMatches: boolean;
    readonly rowCountPositive: boolean;
    readonly dimensionInfoCountMatches: boolean;
    readonly measureInfoCountMatches: boolean;
    readonly returnedRowsPositive: boolean;
    readonly matrixRowsPositive: boolean;
    readonly fullWidthMatrixRowPresent: boolean;
    readonly usableMeasureCellPresent: boolean;
  };
  readonly observed: {
    readonly objectType: string;
    readonly qInfoType: string;
    readonly cubeMode: string;
    readonly expectedColumnCount: number;
    readonly cubeColumnCount: number | 'invalid';
    readonly cubeRowCount: number | 'invalid';
    readonly expectedDimensionInfoCount: number;
    readonly dimensionInfoCount: number;
    readonly expectedMeasureInfoCount: number;
    readonly measureInfoCount: number;
    readonly returnedRows: number | 'invalid';
    readonly matrixRowCount: number;
    readonly fullWidthMatrixRowCount: number;
    readonly usableMeasureRowCount: number;
  };
}

export class CloudPreviewLayoutContractError extends Error {
  readonly code = 'TRANSIENT_UNAVAILABLE';

  constructor(readonly diagnostics: CloudPreviewLayoutDiagnostics) {
    super('The live Cloud preview layout failed one or more structural checks.');
    this.name = 'CloudPreviewLayoutContractError';
  }
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function hasNumberOrder(value: unknown, expected: readonly number[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function fieldSettingName(role: CloudProbeFieldRole): string {
  return role === 'dimension' ? 'QLIK_CLOUD_PROBE_DIMENSION' : 'QLIK_CLOUD_PROBE_MEASURE';
}

function invalidFieldSetting(role: CloudProbeFieldRole, reason: string): never {
  const setting = fieldSettingName(role);
  const acceptedFormat =
    role === 'dimension'
      ? 'one bounded catalog label, not an expression'
      : 'one bounded catalog label or one allowlisted aggregation';
  throw createError('NOT_CONFIGURED', {
    message: `${setting} must contain ${acceptedFormat}.`,
    details: { setting, role, reason },
  });
}

/** Parses a probe reference without ever echoing its label or expression in a failure. */
export function parseCloudProbeFieldLabel(
  role: CloudProbeFieldRole,
  value: string | undefined,
): ParsedCloudProbeFieldReference {
  if (
    value !== undefined &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    invalidFieldSetting(role, 'control-character');
  }
  const normalized = value?.trim();
  if (!normalized) invalidFieldSetting(role, 'missing-or-empty');
  const maxLength = role === 'dimension' ? 120 : 200;
  if (normalized.length > maxLength) invalidFieldSetting(role, 'too-long');
  if (role === 'dimension') {
    if (!isPlainDimensionReference(normalized)) {
      invalidFieldSetting(role, 'expression-syntax');
    }
    return { value: normalized, format: 'catalog-label' };
  }
  const format = classifyMeasureReference(normalized);
  if (!format) invalidFieldSetting(role, 'expression-syntax');
  return { value: normalized, format };
}

export function assertCloudTablePlan(plan: ResolvedChartPlan): void {
  const properties = recordOf(plan.propertyProposal);
  const info = recordOf(properties?.qInfo);
  const cube = recordOf(properties?.qHyperCubeDef);
  const totals = recordOf(properties?.totals);
  const initialDataFetch = Array.isArray(cube?.qInitialDataFetch)
    ? recordOf(cube.qInitialDataFetch[0])
    : undefined;
  if (
    plan.visualizationSchemaProfile !== CLOUD_VISUALIZATION_SCHEMA_PROFILE ||
    plan.visualizationSchemaVersion !== CLOUD_TABLE_SCHEMA_VERSION ||
    plan.nativeChartType !== CLOUD_TABLE_NATIVE_TYPE ||
    properties?.version !== CLOUD_TABLE_SCHEMA_VERSION ||
    properties.sorting !== undefined ||
    properties.showTitles !== true ||
    properties.enableChartExploration !== false ||
    properties.title !== plan.title ||
    properties.subtitle !== '' ||
    properties.footnote !== '' ||
    properties.usePagination !== false ||
    !Array.isArray(properties.components) ||
    properties.components.length !== 0 ||
    totals?.label !== 'Totals' ||
    totals.show !== true ||
    totals.position !== 'noTotals' ||
    info?.qType !== CLOUD_TABLE_NATIVE_TYPE ||
    !Array.isArray(cube?.qDimensions) ||
    cube.qDimensions.length !== 1 ||
    !Array.isArray(cube.qMeasures) ||
    cube.qMeasures.length !== 1 ||
    cube.qMode !== 'S' ||
    initialDataFetch?.qTop !== 0 ||
    initialDataFetch.qLeft !== 0 ||
    initialDataFetch.qHeight !== plan.resultLimit ||
    initialDataFetch.qWidth !== 2 ||
    !hasNumberOrder(cube?.qColumnOrder, [0, 1]) ||
    !hasNumberOrder(cube?.qInterColumnSortOrder, [1, 0])
  ) {
    throw createError('INVALID_CHART_CONFIGURATION', {
      message: 'The live Cloud probe compiler did not produce the pinned sn-table contract.',
    });
  }
}

export function summarizeCloudProbeInputContract(
  plan: ResolvedChartPlan,
  dimension: ParsedCloudProbeFieldReference,
  measure: ParsedCloudProbeFieldReference,
): CloudProbeInputContractSummary {
  const resolvedDimension = plan.resolved.dimensions[0];
  const resolvedMeasure = plan.resolved.measures[0];
  if (
    plan.resolved.dimensions.length !== 1 ||
    plan.resolved.measures.length !== 1 ||
    !resolvedDimension ||
    !resolvedMeasure ||
    resolvedDimension.role !== 'dimension' ||
    resolvedMeasure.role !== 'measure' ||
    dimension.format !== 'catalog-label'
  ) {
    throw createError('INVALID_CHART_CONFIGURATION', {
      message: 'The live Cloud probe input contract did not resolve to one dimension and measure.',
    });
  }
  return {
    dimension: {
      format: 'catalog-label',
      resolvedSource: resolvedDimension.masterItemId ? 'master-item' : 'field',
      roleMatched: true,
    },
    measure: {
      format: measure.format,
      resolvedSource: resolvedMeasure.masterItemId ? 'master-item' : 'field',
      roleMatched: true,
    },
  };
}

export function hasUsableMeasureCell(
  plan: ResolvedChartPlan,
  matrix: readonly (readonly unknown[])[],
): boolean {
  const measureColumn = plan.resolved.dimensions.length;
  return matrix.some((row) => {
    const cell = recordOf(row[measureColumn]);
    if (cell?.qNum === 'NaN') return false;
    if (typeof cell?.qNum === 'number') return Number.isFinite(cell.qNum);
    return typeof cell?.qText === 'string' && cell.qText.trim().length > 0;
  });
}

function safeType(value: unknown): string {
  return value === CLOUD_TABLE_NATIVE_TYPE ? CLOUD_TABLE_NATIVE_TYPE : 'invalid-or-unexpected';
}

function safeCubeMode(value: unknown): string {
  return value === 'S' || value === 'K' ? value : 'invalid-or-unexpected';
}

function safeCount(value: unknown): number | 'invalid' {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 'invalid';
}

export function diagnoseCloudPreviewLayout(
  plan: ResolvedChartPlan,
  preview: CreateSessionChartResult,
  inputContract: CloudProbeInputContractSummary,
): CloudPreviewLayoutDiagnostics {
  const cube = preview.layout.qHyperCube;
  const matrix = cube.qDataPages[0]?.qMatrix ?? [];
  const expectedColumnCount = plan.resolved.dimensions.length + plan.resolved.measures.length;
  const fullWidthMatrixRowCount = matrix.filter((row) => row.length === expectedColumnCount).length;
  const usableMeasureRowCount = matrix.filter((row) => hasUsableMeasureCell(plan, [row])).length;
  const checks = {
    objectIdMatchesSession: preview.layout.objectId === preview.sessionObjectId,
    qInfoIdMatchesSession: preview.layout.qInfo.id === preview.sessionObjectId,
    objectTypeMatches: preview.layout.objectType === CLOUD_TABLE_NATIVE_TYPE,
    qInfoTypeMatches: preview.layout.qInfo.type === CLOUD_TABLE_NATIVE_TYPE,
    cubeModeMatches: cube.qMode === 'S',
    columnCountMatches: cube.qSize.qcx === expectedColumnCount,
    rowCountPositive: cube.qSize.qcy > 0,
    dimensionInfoCountMatches: cube.qDimensionInfo.length === plan.resolved.dimensions.length,
    measureInfoCountMatches: cube.qMeasureInfo.length === plan.resolved.measures.length,
    returnedRowsPositive: preview.layout.bounded.returnedRows > 0,
    matrixRowsPositive: matrix.length > 0,
    fullWidthMatrixRowPresent: fullWidthMatrixRowCount > 0,
    usableMeasureCellPresent: usableMeasureRowCount > 0,
  };
  return {
    diagnosticVersion: 'cloud-preview-layout-v1',
    passed: Object.values(checks).every(Boolean),
    inputContract,
    checks,
    observed: {
      objectType: safeType(preview.layout.objectType),
      qInfoType: safeType(preview.layout.qInfo.type),
      cubeMode: safeCubeMode(cube.qMode),
      expectedColumnCount,
      cubeColumnCount: safeCount(cube.qSize.qcx),
      cubeRowCount: safeCount(cube.qSize.qcy),
      expectedDimensionInfoCount: plan.resolved.dimensions.length,
      dimensionInfoCount: cube.qDimensionInfo.length,
      expectedMeasureInfoCount: plan.resolved.measures.length,
      measureInfoCount: cube.qMeasureInfo.length,
      returnedRows: safeCount(preview.layout.bounded.returnedRows),
      matrixRowCount: matrix.length,
      fullWidthMatrixRowCount,
      usableMeasureRowCount,
    },
  };
}

export function assertUsableCloudPreviewLayout(
  plan: ResolvedChartPlan,
  preview: CreateSessionChartResult,
  inputContract: CloudProbeInputContractSummary,
): CloudPreviewLayoutDiagnostics {
  const diagnostics = diagnoseCloudPreviewLayout(plan, preview, inputContract);
  if (!diagnostics.passed) throw new CloudPreviewLayoutContractError(diagnostics);
  return diagnostics;
}

export async function assertUsableCloudPreviewLayoutAndDispose(params: {
  readonly plan: ResolvedChartPlan;
  readonly preview: CreateSessionChartResult;
  readonly inputContract: CloudProbeInputContractSummary;
  readonly dispose: () => Promise<void>;
}): Promise<CloudPreviewLayoutDiagnostics> {
  let diagnostics: CloudPreviewLayoutDiagnostics | undefined;
  let validationError: unknown;
  try {
    diagnostics = assertUsableCloudPreviewLayout(params.plan, params.preview, params.inputContract);
  } catch (error) {
    validationError = error;
  }

  try {
    await params.dispose();
  } catch (disposalError) {
    if (!validationError) throw disposalError;
  }
  if (validationError) throw validationError;
  if (!diagnostics) {
    throw createError('TRANSIENT_UNAVAILABLE', {
      message: 'The live Cloud preview validation did not produce diagnostics.',
    });
  }
  return diagnostics;
}
