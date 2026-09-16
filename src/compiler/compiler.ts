import {
  resolveDimensionReference,
  resolveFilterReference,
  resolveMeasureReference,
} from './expressionGrammar.js';
import {
  defaultVisualizationSchemaProfile,
  parseChartTypeId,
  resolveVisualizationSchema,
  validateChartShape,
  type PropertySchemaBehavior,
} from './chartTypeRegistry.js';
import { derivePlanHash } from './planHash.js';
import { resolveFieldCardinality } from '../catalog/cardinality.js';
import type { ChartIntentInput } from './chartIntentSchema.js';
import type { CatalogDefinition } from '../catalog/catalogTypes.js';
import { createError } from '../domain/errors.js';
import type {
  ChartTypeId,
  CompactDiff,
  NativePropertyProposalLike,
  PlatformId,
  ResolvedChartPlan,
  ResolvedFieldRef,
  ResolvedFilterRef,
  ResolvedMeasureRef,
  RiskClass,
  TargetRef,
  VisualizationSchemaProfileId,
} from '../domain/types.js';

export const COMPILER_VERSION = 'fixture-compiler-v4';
export const CHART_INTENT_VERSION = 'chart-intent-v1';
export const DEFAULT_PLAN_TTL_MS = 15 * 60 * 1000;

export interface CompileChartIntentParams {
  readonly catalog: CatalogDefinition;
  readonly target: Required<TargetRef>;
  readonly platform: PlatformId;
  readonly visualizationSchemaProfile?: VisualizationSchemaProfileId;
  readonly visualizationSchemaVersion?: string;
  readonly intent: ChartIntentInput;
  readonly compilerVersion?: string;
  readonly intentVersion?: string;
  readonly planTtlMs?: number;
  readonly now?: Date;
}

function buildResolvedFilter(ref: ResolvedFieldRef, values: readonly string[]): ResolvedFilterRef {
  return { catalogId: ref.catalogId, label: ref.label, values };
}

const AUTO_COLOR = { auto: true } as const;
const DEFAULT_LEGEND = { show: true, dock: 'auto', showTitle: true } as const;
const DEFAULT_TOOLTIP = { auto: true, hideBasic: false } as const;
const DEFAULT_DIMENSION_AXIS = {
  axisDisplayMode: 'auto',
  continuousAuto: true,
  dock: 'near',
  label: 'auto',
  maxVisibleItems: 10,
  show: 'all',
} as const;
const DEFAULT_MEASURE_AXIS = {
  autoMinMax: true,
  dock: 'near',
  max: 10,
  min: 0,
  minMax: 'min',
  show: 'all',
  spacing: 1,
} as const;

function titleProperties(title: string): Readonly<Record<string, unknown>> {
  return { showTitles: true, title, subtitle: '', footnote: '', showDetails: false };
}

function buildCloudNativeProperties(params: {
  readonly chartType: Exclude<ChartTypeId, 'table'>;
  readonly version: string;
  readonly title: string;
  readonly target?: number;
  readonly commonProperties: Readonly<Record<string, unknown>>;
  readonly qHyperCubeDef: Readonly<Record<string, unknown>>;
}): NativePropertyProposalLike {
  const titles = titleProperties(params.title);
  const shared = {
    ...params.commonProperties,
    version: params.version,
    qHyperCubeDef: params.qHyperCubeDef,
    ...titles,
  };

  switch (params.chartType) {
    case 'bar':
      return {
        ...shared,
        barGrouping: { grouping: 'grouped' },
        color: AUTO_COLOR,
        components: [],
        dataPoint: { showLabels: false, showSegmentLabels: false, showTotalLabels: true },
        dimensionAxis: DEFAULT_DIMENSION_AXIS,
        gridLine: { auto: true, spacing: 2 },
        legend: DEFAULT_LEGEND,
        measureAxis: DEFAULT_MEASURE_AXIS,
        orientation: 'vertical',
        preferContinuousAxis: true,
        refLine: { dimRefLines: [], refLines: [] },
        scrollbar: 'miniChart',
        scrollStartPos: 0,
        showDisclaimer: true,
        showMiniChartForContinuousAxis: true,
        tooltip: DEFAULT_TOOLTIP,
      };
    case 'line':
      return {
        ...shared,
        color: AUTO_COLOR,
        components: [],
        dataPoint: { show: false, showLabels: false },
        dimensionAxis: DEFAULT_DIMENSION_AXIS,
        gridLine: { auto: true, spacing: 2 },
        legend: DEFAULT_LEGEND,
        lineType: 'line',
        measureAxis: { ...DEFAULT_MEASURE_AXIS, logarithmic: false },
        orientation: 'horizontal',
        preferContinuousAxis: true,
        refLine: { dimRefLines: [], refLines: [] },
        scrollbar: 'miniChart',
        scrollStartPos: 0,
        separateStacking: true,
        showDisclaimer: true,
        showMiniChartForContinuousAxis: true,
        stackedArea: false,
        tooltip: DEFAULT_TOOLTIP,
      };
    case 'scatter':
      return {
        ...shared,
        color: AUTO_COLOR,
        components: [],
        dataPoint: { bubbleSizes: 5, compressionResolution: 5, rangeBubbleSizes: [5, 20] },
        disableNavMenu: false,
        gridLine: { auto: true, spacing: 2 },
        labels: { mode: 1 },
        legend: DEFAULT_LEGEND,
        maxVisibleBubbles: 2500,
        navigation: false,
        refLine: { refLinesX: [], refLinesY: [] },
        showDisclaimer: true,
        tooltip: DEFAULT_TOOLTIP,
        trendLines: [],
        xAxis: DEFAULT_MEASURE_AXIS,
        yAxis: DEFAULT_MEASURE_AXIS,
      };
    case 'kpi':
      return {
        ...shared,
        showMeasureTitle: true,
        showSecondMeasureTitle: false,
        disableNavMenu: false,
        fontSize: 'M',
        useLink: false,
        components: [],
      };
    case 'gauge':
      if (params.target === undefined || params.target <= 0) {
        throw createError('INVALID_CHART_CONFIGURATION', {
          message: 'A Cloud gauge requires a positive target value.',
        });
      }
      return {
        ...shared,
        autoOrientation: true,
        color: { useBaseColors: 'measure' },
        components: [],
        disableNavMenu: false,
        gaugetype: 'radial',
        measureAxis: { max: params.target, min: 0, show: 'all', spacing: 1 },
        orientation: 'horizontal',
        paletteProgressColor: { index: 6 },
        refLine: { refLines: [] },
        segmentInfo: { limits: [], paletteColors: [] },
        useSegments: false,
      };
    case 'treemap':
      return {
        ...shared,
        qHyperCubeDef: {
          ...params.qHyperCubeDef,
          qMode: 'K',
          qNoOfLeftDims: -1,
          qSortbyYValue: -1,
          qIndentMode: true,
          qShowTotalsAbove: false,
          qMaxStackedCells: 3_000,
          qAlwaysFullyExpanded: true,
          qSuppressZero: false,
          qSuppressMissing: false,
        },
        color: AUTO_COLOR,
        labels: { auto: true, headers: true, overlay: true, leaves: true, values: false },
        legend: { ...DEFAULT_LEGEND, show: false },
        showDisclaimer: true,
        tooltip: DEFAULT_TOOLTIP,
      };
    case 'pie':
      return {
        ...shared,
        color: AUTO_COLOR,
        components: [],
        dataPoint: { auto: true, labelMode: 'share', labelValueMode: 'arc' },
        dimensionTitle: true,
        donut: { showAsDonut: false },
        legend: DEFAULT_LEGEND,
        showDisclaimer: true,
        tooltip: DEFAULT_TOOLTIP,
      };
    case 'combo': {
      const measures = Array.isArray(params.qHyperCubeDef.qMeasures)
        ? params.qHyperCubeDef.qMeasures
        : [];
      const qMeasures = measures.map((rawMeasure, index) => {
        const measure = rawMeasure as Readonly<Record<string, unknown>>;
        const definition =
          measure.qDef && typeof measure.qDef === 'object'
            ? (measure.qDef as Readonly<Record<string, unknown>>)
            : {};
        return {
          ...measure,
          qDef: {
            ...definition,
            series: { type: index === 0 ? 'bar' : 'line', axis: index === 0 ? 0 : 1, options: {} },
          },
        };
      });
      return {
        ...shared,
        qHyperCubeDef: { ...params.qHyperCubeDef, qMeasures },
        barGrouping: { grouping: 'grouped' },
        color: AUTO_COLOR,
        components: [],
        dataPoint: { show: false, showBarLabels: false, showLineLabels: false },
        dimensionAxis: DEFAULT_DIMENSION_AXIS,
        legend: DEFAULT_LEGEND,
        lineType: 'line',
        measureAxes: [
          { autoMinMax: true, min: 0, max: 10, minMax: 'min', show: 'all', spacing: 1 },
          { autoMinMax: true, min: 0, max: 10, minMax: 'min', show: 'all', spacing: 1 },
        ],
        orientation: 'vertical',
        preferContinuousAxis: true,
        refLine: { dimRefLines: [], refLines: [], refLines2: [] },
        scrollStartPos: 0,
        separateStacking: true,
        showMiniChartForContinuousAxis: true,
        stackedArea: false,
        tooltip: DEFAULT_TOOLTIP,
      };
    }
  }
}

function buildDimensionProperties(dimension: ResolvedFieldRef, sortDirection?: number) {
  const numericSort = ['numeric', 'date', 'timestamp', 'time'].includes(
    dimension.semanticType ?? '',
  );
  const sortProperties =
    sortDirection === undefined
      ? {}
      : {
          qSortCriterias: [
            numericSort ? { qSortByNumeric: sortDirection } : { qSortByAscii: sortDirection },
          ],
        };
  return {
    ...(dimension.masterItemId
      ? {
          qLibraryId: dimension.masterItemId,
          ...(sortDirection !== undefined ? { qDef: sortProperties } : {}),
        }
      : {
          qDef: {
            qFieldDefs: [dimension.label],
            qFieldLabels: [dimension.label],
            ...sortProperties,
          },
        }),
    qNullSuppression: true,
  };
}

function buildNativePropertyProposal(params: {
  readonly chartType: ChartTypeId;
  readonly nativeChartType: string;
  readonly visualizationSchemaProfile: VisualizationSchemaProfileId;
  readonly propertySchemaBehavior: PropertySchemaBehavior;
  readonly propertySchemaVersion?: string;
  readonly qId: string;
  readonly title: string;
  readonly dimensions: readonly ResolvedFieldRef[];
  readonly measures: readonly ResolvedMeasureRef[];
  readonly filters: readonly ResolvedFilterRef[];
  readonly sort: string;
  readonly target?: number;
  readonly resultLimit: number;
}): NativePropertyProposalLike {
  const sortEnabled = params.sort !== 'none';
  const sortByMeasure = sortEnabled && params.sort.startsWith('measure');
  const direction = params.sort.endsWith('descending') ? 'descending' : 'ascending';
  const qSortDirection = direction === 'descending' ? -1 : 1;
  const columnCount = params.dimensions.length + params.measures.length;
  const qColumnOrder = Array.from({ length: columnCount }, (_, index) => index);
  const primarySortColumn = sortByMeasure ? params.dimensions.length : 0;
  const qInterColumnSortOrder = sortEnabled
    ? [primarySortColumn, ...qColumnOrder.filter((column) => column !== primarySortColumn)]
    : [];
  const qDimensions = params.dimensions.map((dimension, index) =>
    buildDimensionProperties(
      dimension,
      !sortByMeasure && sortEnabled && index === 0 ? qSortDirection : undefined,
    ),
  );
  const qMeasures = params.measures.map((measure, index) =>
    measure.masterItemId
      ? {
          qLibraryId: measure.masterItemId,
          ...(sortByMeasure && index === 0 ? { qSortBy: { qSortByNumeric: qSortDirection } } : {}),
        }
      : {
          qDef: { qDef: measure.expression, qLabel: measure.label },
          ...(sortByMeasure && index === 0 ? { qSortBy: { qSortByNumeric: qSortDirection } } : {}),
        },
  );
  const qHyperCubeDef = {
    qDimensions,
    qMeasures,
    qInterColumnSortOrder,
    ...(params.filters.length > 0
      ? { qContextSetExpression: buildContextSetExpression(params.filters) }
      : {}),
    qMode: params.chartType === 'treemap' ? 'K' : 'S',
    qInitialDataFetch: [
      {
        qTop: 0,
        qLeft: 0,
        qHeight: params.resultLimit,
        qWidth: columnCount,
      },
    ],
    qSuppressZero: true,
    qSuppressMissing: true,
  };

  const commonProperties = {
    qInfo: { qType: params.nativeChartType, qId: params.qId },
    qMetaDef: {
      title: params.title,
      description: 'Compiled by the Qlik AI Harness chart compiler.',
    },
  };
  if (params.propertySchemaBehavior === 'standard-hypercube') {
    if (params.visualizationSchemaProfile === 'qlik-cloud-current') {
      if (!params.propertySchemaVersion) {
        throw createError('INVALID_CHART_CONFIGURATION', {
          message: 'Cloud native visualization compilation requires a pinned property version.',
        });
      }
      return buildCloudNativeProperties({
        chartType: params.chartType as Exclude<ChartTypeId, 'table'>,
        version: params.propertySchemaVersion,
        title: params.title,
        ...(params.target !== undefined ? { target: params.target } : {}),
        commonProperties: { ...commonProperties, visualization: params.nativeChartType },
        qHyperCubeDef,
      });
    }
    return {
      ...commonProperties,
      qHyperCubeDef,
      ...(sortEnabled
        ? { sorting: { by: sortByMeasure ? 'measure' : 'dimension', direction } }
        : {}),
    };
  }

  const tableDimensions = params.dimensions.map((dimension, index) =>
    buildDimensionProperties(
      dimension,
      sortEnabled ? (!sortByMeasure && index === 0 ? qSortDirection : 1) : undefined,
    ),
  );
  const tableMeasures = params.measures.map((measure, index) =>
    measure.masterItemId
      ? {
          qLibraryId: measure.masterItemId,
          ...(sortEnabled
            ? {
                qSortBy: {
                  qSortByNumeric: sortByMeasure && index === 0 ? qSortDirection : -1,
                },
              }
            : {}),
        }
      : {
          qDef: {
            qDef: measure.expression,
            qLabel: measure.label,
          },
          ...(sortEnabled
            ? {
                qSortBy: {
                  qSortByNumeric: sortByMeasure && index === 0 ? qSortDirection : -1,
                },
              }
            : {}),
        },
  );

  const tableHyperCubeDef = {
    ...qHyperCubeDef,
    qDimensions: tableDimensions,
    qMeasures: tableMeasures,
    qColumnOrder,
  };
  if (params.propertySchemaBehavior === 'legacy-table') {
    return { ...commonProperties, qHyperCubeDef: tableHyperCubeDef };
  }
  if (!params.propertySchemaVersion) {
    throw createError('INVALID_CHART_CONFIGURATION', {
      message: 'sn-table compilation requires a validated property schema version.',
    });
  }
  return {
    ...commonProperties,
    ...(params.visualizationSchemaProfile === 'qlik-cloud-current'
      ? { visualization: params.nativeChartType }
      : {}),
    version: params.propertySchemaVersion,
    qHyperCubeDef: tableHyperCubeDef,
    showTitles: true,
    enableChartExploration: false,
    title: params.title,
    subtitle: '',
    footnote: '',
    totals: { label: 'Totals', show: true, position: 'noTotals' },
    usePagination: false,
    components: [],
  };
}

function qlikFieldName(label: string): string {
  return `[${label.split(']').join(']]')}]`;
}

function qlikSetValue(value: string): string {
  if (value.includes('$(')) {
    throw createError('DISALLOWED_EXPRESSION', {
      message: 'Filter values must not contain Qlik dollar-sign expansion syntax.',
    });
  }
  return `'${value.split("'").join("''")}'`;
}

/** Builds a bounded literal-only set modifier; no caller expression is accepted. */
function buildContextSetExpression(filters: readonly ResolvedFilterRef[]): string {
  const modifiers = filters.map(
    (filter) => `${qlikFieldName(filter.label)}={${filter.values.map(qlikSetValue).join(',')}}`,
  );
  return `{$<${modifiers.join(',')}>}`;
}

function buildCompactDiff(params: {
  readonly chartType: ChartTypeId;
  readonly title: string;
  readonly target: Required<TargetRef>;
  readonly dimensions: readonly ResolvedFieldRef[];
  readonly measures: readonly ResolvedMeasureRef[];
  readonly filters: readonly ResolvedFilterRef[];
}): CompactDiff {
  const additions = [
    `chart-type: ${params.chartType}`,
    `title: ${params.title}`,
    ...params.dimensions.map((dimension) => `dimension: ${dimension.label}`),
    ...params.measures.map((measure) => `measure: ${measure.label} (${measure.expression})`),
    ...params.filters.map((filter) => `filter: ${filter.label} in [${filter.values.join(', ')}]`),
  ];
  return {
    summary: `Create new "${params.chartType}" chart "${params.title}" on sheet ${params.target.sheetId} (app ${params.target.appId}).`,
    additions,
    removals: [],
  };
}

/**
 * Compiles a validated `ChartIntent` into a deterministic, server-side
 * `ResolvedChartPlan`. Never accepts or produces a raw QIX request; the
 * `propertyProposal` is a bounded, harness-generated native descriptor used
 * only by the preview/apply pipeline, never returned to an MCP caller.
 */
export function compileChartIntent(params: CompileChartIntentParams): ResolvedChartPlan {
  const { catalog, target, platform, intent } = params;
  const compilerVersion = params.compilerVersion ?? COMPILER_VERSION;
  const intentVersion = params.intentVersion ?? CHART_INTENT_VERSION;

  const chartType = parseChartTypeId(intent.presentation.preferredChartType);
  const visualizationSchema = resolveVisualizationSchema({
    chartType,
    platform,
    profile:
      params.visualizationSchemaProfile ?? defaultVisualizationSchemaProfile(params.platform),
    ...(params.visualizationSchemaVersion
      ? { hostValidatedVersion: params.visualizationSchemaVersion }
      : {}),
  });
  const nativeChartType = visualizationSchema.qlikInAppVisualizationId;
  const support = catalog.chartSupport.find(
    (entry) => entry.type === visualizationSchema.catalogChartType,
  );

  const dimensions = intent.analysis.dimensions.map((label) =>
    resolveDimensionReference(catalog, label),
  );
  const measures = intent.analysis.measures.map((label) => resolveMeasureReference(catalog, label));
  const filters = (intent.analysis.filters ?? []).map((filter) => {
    const ref = resolveFilterReference(catalog, filter.field);
    return buildResolvedFilter(ref, filter.values);
  });

  const dimensionBands = dimensions.map(
    (dimension) => resolveFieldCardinality(catalog, dimension).band,
  );
  const dimensionSemanticTypes = dimensions.map((dimension) => dimension.semanticType ?? 'unknown');
  const measureSemanticTypes = measures.map((measure) => measure.semanticType ?? 'unknown');

  const shape = validateChartShape({
    chartType,
    support,
    dimensionBands,
    dimensionSemanticTypes,
    measureSemanticTypes,
    resultLimit: intent.presentation.topN,
    hasExplicitTarget: intent.presentation.target !== undefined,
    ...(intent.presentation.target !== undefined
      ? { targetValue: intent.presentation.target }
      : {}),
  });

  const riskClass: RiskClass = shape.warnings.length > 0 ? 'elevated' : 'standard';

  const now = params.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + (params.planTtlMs ?? DEFAULT_PLAN_TTL_MS),
  ).toISOString();
  const sort = intent.presentation.sort ?? 'measure-descending';

  const planHash = derivePlanHash({
    compilerVersion,
    catalogId: catalog.catalogId,
    platform,
    visualizationSchemaProfile: visualizationSchema.profile,
    visualizationSchemaVersion: visualizationSchema.propertySchemaVersion ?? null,
    target,
    chartType,
    dimensions: dimensions.map((dimension) => ({
      catalogId: dimension.catalogId,
      label: dimension.label,
    })),
    measures: measures.map((measure) => ({
      catalogId: measure.catalogId,
      expression: measure.expression,
    })),
    filters: filters.map((filter) => ({
      catalogId: filter.catalogId,
      values: [...filter.values].sort(),
    })),
    presentation: {
      title: intent.presentation.title,
      sort,
      target: intent.presentation.target ?? null,
      resultLimit: shape.resolvedResultLimit,
    },
  });

  const propertyProposal = buildNativePropertyProposal({
    chartType,
    nativeChartType,
    visualizationSchemaProfile: visualizationSchema.profile,
    propertySchemaBehavior: visualizationSchema.propertySchemaBehavior,
    ...(visualizationSchema.propertySchemaVersion
      ? { propertySchemaVersion: visualizationSchema.propertySchemaVersion }
      : {}),
    qId: `native-${nativeChartType}-${planHash.slice(7, 19)}`,
    title: intent.presentation.title,
    dimensions,
    measures,
    filters,
    sort,
    ...(intent.presentation.target !== undefined ? { target: intent.presentation.target } : {}),
    resultLimit: shape.resolvedResultLimit,
  });

  const diff = buildCompactDiff({
    chartType,
    title: intent.presentation.title,
    target,
    dimensions,
    measures,
    filters,
  });

  return {
    planHash,
    compilerVersion,
    intentVersion,
    catalogId: catalog.catalogId,
    target,
    platform,
    visualizationSchemaProfile: visualizationSchema.profile,
    ...(visualizationSchema.propertySchemaVersion
      ? { visualizationSchemaVersion: visualizationSchema.propertySchemaVersion }
      : {}),
    chartType,
    nativeChartType,
    resolved: { dimensions, measures, filters },
    title: intent.presentation.title,
    sort,
    resultLimit: shape.resolvedResultLimit,
    riskClass,
    warnings: shape.warnings,
    diff,
    propertyProposal,
    createdAt,
    expiresAt,
  };
}
