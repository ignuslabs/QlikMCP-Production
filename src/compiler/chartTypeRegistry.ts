import { createError } from '../domain/errors.js';
import {
  CHART_TYPE_IDS,
  type ChartTypeId,
  type NativeChartType,
  type PlatformId,
  type VisualizationSchemaProfileId,
} from '../domain/types.js';
import type { CardinalityBand, CatalogChartSupport } from '../catalog/catalogTypes.js';

/**
 * Chart type registry: the exact, build-time set of native chart types this
 * harness will ever compile a plan for. Runtime plugin/type loading is never
 * permitted; adding a chart type requires a code change and new tests.
 */

export type PropertySchemaBehavior = 'standard-hypercube' | 'legacy-table' | 'sn-table';

interface VisualizationProfileMapping {
  readonly qlikInAppVisualizationId: NativeChartType;
  /** Null when Qlik documents no compatible Nebula implementation for this profile. */
  readonly nebulaVisualizationId: string | null;
  readonly propertySchemaBehavior: PropertySchemaBehavior;
}

export interface VisualizationRegistryEntry {
  readonly logicalChartType: ChartTypeId;
  /** Type used by target catalogs when declaring that the visual is supported. */
  readonly catalogChartType: NativeChartType;
  readonly qlikDevSpecVersion: string;
  readonly qlikDevSpecUrl: string;
  readonly profiles: Readonly<Record<VisualizationSchemaProfileId, VisualizationProfileMapping>>;
}

export interface VisualizationSchemaProfile {
  readonly id: VisualizationSchemaProfileId;
  readonly platform: 'cloud' | 'windows';
  readonly snTablePropertyVersionSource: 'qlik-dev-pinned' | 'not-applicable' | 'host-validated';
  readonly pinnedSnTablePropertyVersion?: string;
}

export const VISUALIZATION_SCHEMA_PROFILES: Readonly<
  Record<VisualizationSchemaProfileId, VisualizationSchemaProfile>
> = {
  'qlik-cloud-current': {
    id: 'qlik-cloud-current',
    platform: 'cloud',
    snTablePropertyVersionSource: 'qlik-dev-pinned',
    pinnedSnTablePropertyVersion: '6.51.0',
  },
  'qlik-windows-pre-november-2025': {
    id: 'qlik-windows-pre-november-2025',
    platform: 'windows',
    snTablePropertyVersionSource: 'not-applicable',
  },
  'qlik-windows-november-2025-or-later': {
    id: 'qlik-windows-november-2025-or-later',
    platform: 'windows',
    snTablePropertyVersionSource: 'host-validated',
  },
};

const STANDARD_PROFILE_MAPPINGS = (
  qlikInAppVisualizationId: NativeChartType,
  nebulaVisualizationId: string,
): Readonly<Record<VisualizationSchemaProfileId, VisualizationProfileMapping>> => ({
  'qlik-cloud-current': {
    qlikInAppVisualizationId,
    nebulaVisualizationId,
    propertySchemaBehavior: 'standard-hypercube',
  },
  'qlik-windows-pre-november-2025': {
    qlikInAppVisualizationId,
    nebulaVisualizationId,
    propertySchemaBehavior: 'standard-hypercube',
  },
  'qlik-windows-november-2025-or-later': {
    qlikInAppVisualizationId,
    nebulaVisualizationId,
    propertySchemaBehavior: 'standard-hypercube',
  },
});

/**
 * Versioned visualization compatibility table. The Qlik in-app type,
 * catalog type, and Nebula package identity are intentionally distinct.
 */
export const VISUALIZATION_REGISTRY: Readonly<Record<ChartTypeId, VisualizationRegistryEntry>> = {
  bar: {
    logicalChartType: 'bar',
    catalogChartType: 'barchart',
    qlikDevSpecVersion: '2.7.0',
    qlikDevSpecUrl: 'https://qlik.dev/specs/javascript/sn-bar-chart.json',
    profiles: STANDARD_PROFILE_MAPPINGS('barchart', 'sn-bar-chart'),
  },
  line: {
    logicalChartType: 'line',
    catalogChartType: 'linechart',
    qlikDevSpecVersion: '2.7.0',
    qlikDevSpecUrl: 'https://qlik.dev/specs/javascript/sn-line-chart.json',
    profiles: STANDARD_PROFILE_MAPPINGS('linechart', 'sn-line-chart'),
  },
  scatter: {
    logicalChartType: 'scatter',
    catalogChartType: 'scatterplot',
    qlikDevSpecVersion: '3.60.1',
    qlikDevSpecUrl: 'https://qlik.dev/specs/javascript/sn-scatter-plot.json',
    profiles: STANDARD_PROFILE_MAPPINGS('scatterplot', 'sn-scatter-plot'),
  },
  table: {
    logicalChartType: 'table',
    catalogChartType: 'table',
    qlikDevSpecVersion: '6.51.0',
    qlikDevSpecUrl: 'https://qlik.dev/specs/javascript/sn-table.json',
    profiles: {
      'qlik-cloud-current': {
        qlikInAppVisualizationId: 'sn-table',
        nebulaVisualizationId: 'sn-table',
        propertySchemaBehavior: 'sn-table',
      },
      'qlik-windows-pre-november-2025': {
        qlikInAppVisualizationId: 'table',
        nebulaVisualizationId: null,
        propertySchemaBehavior: 'legacy-table',
      },
      'qlik-windows-november-2025-or-later': {
        qlikInAppVisualizationId: 'sn-table',
        nebulaVisualizationId: 'sn-table',
        propertySchemaBehavior: 'sn-table',
      },
    },
  },
  kpi: {
    logicalChartType: 'kpi',
    catalogChartType: 'kpi',
    qlikDevSpecVersion: '2.4.0',
    qlikDevSpecUrl: 'https://qlik.dev/specs/javascript/sn-kpi.json',
    profiles: STANDARD_PROFILE_MAPPINGS('kpi', 'sn-kpi'),
  },
  gauge: {
    logicalChartType: 'gauge',
    catalogChartType: 'gauge',
    qlikDevSpecVersion: '0.10.0',
    qlikDevSpecUrl: 'https://qlik.dev/specs/javascript/sn-gauge.json',
    profiles: STANDARD_PROFILE_MAPPINGS('gauge', 'sn-gauge'),
  },
  treemap: {
    logicalChartType: 'treemap',
    catalogChartType: 'treemap',
    qlikDevSpecVersion: '1.8.0',
    qlikDevSpecUrl: 'https://qlik.dev/specs/javascript/sn-treemap-events.json',
    profiles: STANDARD_PROFILE_MAPPINGS('treemap', 'sn-treemap'),
  },
  pie: {
    logicalChartType: 'pie',
    catalogChartType: 'piechart',
    qlikDevSpecVersion: '2.8.0',
    qlikDevSpecUrl: 'https://qlik.dev/specs/javascript/sn-pie-chart.json',
    profiles: STANDARD_PROFILE_MAPPINGS('piechart', 'sn-pie-chart'),
  },
  combo: {
    logicalChartType: 'combo',
    catalogChartType: 'combochart',
    qlikDevSpecVersion: '1.43.0',
    qlikDevSpecUrl: 'https://qlik.dev/specs/javascript/sn-combo-chart.json',
    profiles: STANDARD_PROFILE_MAPPINGS('combochart', 'sn-combo-chart'),
  },
};

export interface ResolvedVisualizationSchema {
  readonly profile: VisualizationSchemaProfileId;
  readonly propertySchemaVersion?: string;
  readonly catalogChartType: NativeChartType;
  readonly qlikInAppVisualizationId: NativeChartType;
  readonly nebulaVisualizationId: string | null;
  readonly propertySchemaBehavior: PropertySchemaBehavior;
}

const SEMVER_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_PATTERN = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)` +
    `(?:-${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*)?` +
    '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
);

export function isValidVisualizationSchemaVersion(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

export function defaultVisualizationSchemaProfile(
  platform: PlatformId,
): VisualizationSchemaProfileId {
  if (platform === 'cloud') return 'qlik-cloud-current';
  if (platform === 'windows') return 'qlik-windows-pre-november-2025';
  throw createError('INVALID_CHART_CONFIGURATION', {
    message: `Platform "${platform}" has no visualization schema profile.`,
    details: { platform },
  });
}

export function resolveVisualizationSchema(params: {
  readonly chartType: ChartTypeId;
  readonly platform: PlatformId;
  readonly profile: VisualizationSchemaProfileId;
  readonly hostValidatedVersion?: string;
}): ResolvedVisualizationSchema {
  const profile = VISUALIZATION_SCHEMA_PROFILES[params.profile];
  if (!profile || profile.platform !== params.platform) {
    throw createError('INVALID_CHART_CONFIGURATION', {
      message: `Visualization schema profile "${params.profile}" is not valid for platform "${params.platform}".`,
      details: { platform: params.platform, visualizationSchemaProfile: params.profile },
    });
  }

  const definition = VISUALIZATION_REGISTRY[params.chartType];
  const mapping = definition.profiles[params.profile];
  let propertySchemaVersion: string | undefined;
  if (profile.snTablePropertyVersionSource === 'qlik-dev-pinned') {
    if (params.hostValidatedVersion !== undefined) {
      throw createError('INVALID_CHART_CONFIGURATION', {
        message: `Visualization schema profile "${params.profile}" does not accept a host-validated version override.`,
      });
    }
    propertySchemaVersion = profile.pinnedSnTablePropertyVersion;
  } else if (profile.snTablePropertyVersionSource === 'host-validated') {
    if (
      params.hostValidatedVersion === undefined ||
      !isValidVisualizationSchemaVersion(params.hostValidatedVersion)
    ) {
      throw createError('INVALID_CHART_CONFIGURATION', {
        message: `Visualization schema profile "${params.profile}" requires a host-validated semantic sn-table property version.`,
      });
    }
    propertySchemaVersion = params.hostValidatedVersion;
  } else if (params.hostValidatedVersion !== undefined) {
    throw createError('INVALID_CHART_CONFIGURATION', {
      message: `Visualization schema profile "${params.profile}" does not use an sn-table property version.`,
    });
  }

  if (
    params.profile === 'qlik-cloud-current' &&
    mapping.propertySchemaBehavior === 'standard-hypercube'
  ) {
    propertySchemaVersion = definition.qlikDevSpecVersion;
  }
  return {
    profile: params.profile,
    ...(propertySchemaVersion &&
    (mapping.propertySchemaBehavior === 'sn-table' || params.profile === 'qlik-cloud-current')
      ? { propertySchemaVersion }
      : {}),
    catalogChartType: definition.catalogChartType,
    qlikInAppVisualizationId: mapping.qlikInAppVisualizationId,
    nebulaVisualizationId: mapping.nebulaVisualizationId,
    propertySchemaBehavior: mapping.propertySchemaBehavior,
  };
}

const CHART_TYPE_ID_SET: ReadonlySet<string> = new Set(CHART_TYPE_IDS);

/** Parses and strictly validates a caller-supplied chart type string. */
export function parseChartTypeId(raw: string): ChartTypeId {
  const normalized = raw.trim().toLowerCase();
  if (CHART_TYPE_ID_SET.has(normalized)) {
    return normalized as ChartTypeId;
  }
  throw createError('UNSUPPORTED_CHART', {
    message: `"${raw}" is not one of the supported chart types (${CHART_TYPE_IDS.join(', ')}).`,
    details: { requestedType: raw },
  });
}

interface ChartShapeRule {
  readonly minDimensions: number;
  readonly maxDimensions: number;
  readonly minMeasures: number;
  readonly maxMeasures: number;
}

const CHART_SHAPE_RULES: Readonly<Record<ChartTypeId, ChartShapeRule>> = {
  bar: { minDimensions: 1, maxDimensions: 2, minMeasures: 1, maxMeasures: 4 },
  line: { minDimensions: 1, maxDimensions: 2, minMeasures: 1, maxMeasures: 4 },
  scatter: { minDimensions: 0, maxDimensions: 1, minMeasures: 2, maxMeasures: 2 },
  table: { minDimensions: 1, maxDimensions: 6, minMeasures: 1, maxMeasures: 8 },
  kpi: { minDimensions: 0, maxDimensions: 0, minMeasures: 1, maxMeasures: 1 },
  gauge: { minDimensions: 0, maxDimensions: 0, minMeasures: 1, maxMeasures: 1 },
  treemap: { minDimensions: 1, maxDimensions: 2, minMeasures: 1, maxMeasures: 1 },
  pie: { minDimensions: 1, maxDimensions: 1, minMeasures: 1, maxMeasures: 1 },
  combo: { minDimensions: 1, maxDimensions: 1, minMeasures: 2, maxMeasures: 4 },
};

const BAND_RANK: Readonly<Record<CardinalityBand, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  continuous: 0,
};

export interface ShapeValidationInput {
  readonly chartType: ChartTypeId;
  readonly support: CatalogChartSupport | undefined;
  readonly dimensionBands: readonly CardinalityBand[];
  readonly dimensionSemanticTypes: readonly string[];
  readonly measureSemanticTypes: readonly string[];
  readonly resultLimit: number | undefined;
  readonly hasExplicitTarget: boolean;
  readonly targetValue?: number;
}

export interface ShapeValidationResult {
  readonly warnings: string[];
  readonly resolvedResultLimit: number;
}

/**
 * Validates chart-type-specific structural rules (dimension/measure counts,
 * required semantic types, numeric-measure counts, gauge targets, and
 * catalog-declared cardinality bounds), producing warnings for allowed
 * bounded cases (e.g. a high-cardinality dimension on a chart type that
 * supports it only with a bounded row limit).
 */
export function validateChartShape(input: ShapeValidationInput): ShapeValidationResult {
  const {
    chartType,
    support,
    dimensionBands,
    dimensionSemanticTypes,
    measureSemanticTypes,
    hasExplicitTarget,
  } = input;

  if (!support || support.enabled === false) {
    throw createError('UNSUPPORTED_CHART', {
      message: `Chart type "${chartType}" is not enabled for this target catalog.`,
      details: { chartType },
    });
  }

  const rule = CHART_SHAPE_RULES[chartType];
  const dimensionCount = dimensionBands.length;
  const measureCount = measureSemanticTypes.length;

  if (dimensionCount < rule.minDimensions || dimensionCount > rule.maxDimensions) {
    throw createError('INVALID_CHART_CONFIGURATION', {
      message: `Chart type "${chartType}" requires between ${rule.minDimensions} and ${rule.maxDimensions} dimension(s); received ${dimensionCount}.`,
      details: {
        chartType,
        dimensionCount,
        minDimensions: rule.minDimensions,
        maxDimensions: rule.maxDimensions,
      },
    });
  }

  const requiredMeasures =
    support.requiresMeasures ?? support.requiresNumericMeasures ?? rule.minMeasures;
  const maxMeasures =
    support.requiresNumericMeasures ?? support.requiresMeasures ?? rule.maxMeasures;
  if (
    measureCount < Math.max(rule.minMeasures, requiredMeasures) ||
    measureCount > Math.min(rule.maxMeasures, Math.max(maxMeasures, rule.minMeasures))
  ) {
    throw createError('INVALID_CHART_CONFIGURATION', {
      message: `Chart type "${chartType}" requires exactly ${requiredMeasures} measure(s) for this catalog; received ${measureCount}.`,
      details: { chartType, measureCount, requiredMeasures },
    });
  }

  if (support.requiresNumericMeasures !== undefined) {
    const nonNumeric = measureSemanticTypes.filter((type) => type !== 'numeric');
    if (nonNumeric.length > 0) {
      throw createError('INVALID_CHART_CONFIGURATION', {
        message: `Chart type "${chartType}" requires numeric measures only.`,
        details: { chartType },
      });
    }
  }

  const requiredSemanticTypePresent =
    !support.requiresSemanticType ||
    dimensionSemanticTypes.includes(support.requiresSemanticType) ||
    (support.requiresSemanticType === 'date' && dimensionSemanticTypes.includes('timestamp'));
  if (!requiredSemanticTypePresent) {
    throw createError('INVALID_CHART_CONFIGURATION', {
      message: `Chart type "${chartType}" requires a dimension of semantic type "${support.requiresSemanticType}".`,
      details: { chartType, requiredSemanticType: support.requiresSemanticType },
    });
  }

  if (
    support.requiresTarget &&
    (!hasExplicitTarget || input.targetValue === undefined || input.targetValue <= 0)
  ) {
    throw createError('INVALID_CHART_CONFIGURATION', {
      message: `Chart type "${chartType}" requires an explicit positive target value.`,
      details: { chartType },
    });
  }

  if (support.maxDimensionCount !== undefined && dimensionCount > support.maxDimensionCount) {
    throw createError('INVALID_CHART_CONFIGURATION', {
      message: `Chart type "${chartType}" allows at most ${support.maxDimensionCount} dimension(s) for this catalog.`,
      details: { chartType, maxDimensionCount: support.maxDimensionCount },
    });
  }

  const warnings: string[] = [];
  let resolvedResultLimit = input.resultLimit ?? support.boundedResultRows ?? 50;

  for (const band of dimensionBands) {
    const maxBand = support.maxDimensionCardinalityBand;
    if (maxBand && BAND_RANK[band] > BAND_RANK[maxBand]) {
      throw createError('UNSUPPORTED_CHART', {
        message: `Chart type "${chartType}" does not support a "${band}" cardinality dimension for this catalog.`,
        details: { chartType, band },
      });
    }
    if (band === 'high') {
      warnings.push('high-cardinality-dimension');
      if (!warnings.includes('bounded-result-required')) {
        warnings.push('bounded-result-required');
      }
      resolvedResultLimit = input.resultLimit ?? support.boundedResultRows ?? resolvedResultLimit;
    }
  }

  if (support.boundedResultRows !== undefined) {
    resolvedResultLimit = Math.min(resolvedResultLimit, support.boundedResultRows);
  }

  return { warnings, resolvedResultLimit };
}
