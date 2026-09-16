import type { ResolvedFieldRef, ResolvedMeasureRef } from '../../domain/types.js';
import type { QixDataPage, QixHyperCube, BoundedResultMeta } from '../targetAdapter.js';
import type { CardinalityBand } from '../../catalog/catalogTypes.js';

/**
 * Deterministic, synthetic sample data for the fixture-safe adapter. Values
 * are illustrative and reproducible (no randomness); a couple of well-known
 * dimension/measure combinations intentionally mirror
 * `test/fixtures/qix/layouts.json` so the fixture-safe adapter's preview
 * output is directly comparable to the shared fixture contract.
 */

const KNOWN_DIMENSION_VALUES: Readonly<Record<string, readonly string[]>> = {
  region: ['North', 'South', 'East', 'West'],
  'order.status': ['New', 'Processing', 'Shipped', 'Cancelled'],
  'customer.status': ['Active', 'Inactive', 'Prospect'],
  orderdate: [
    '2026-01-05',
    '2026-02-11',
    '2026-03-08',
    '2026-04-02',
    '2026-05-14',
    '2026-06-19',
    '2026-07-22',
    '2026-08-03',
  ],
};

const KNOWN_MEASURE_VALUES: Readonly<Record<string, readonly number[]>> = {
  revenue: [120000, 98000, 87000, 76000, 65000, 54000, 43000, 32000],
  margin: [24000, 19600, 17400, 15200, 13000, 10800, 8600, 6400],
};

function normalize(label: string): string {
  return label.toLowerCase();
}

function customerId(index: number): string {
  return `customer-${String(index + 1).padStart(4, '0')}`;
}

function bandCategoryCount(band: CardinalityBand, maxDistinctValues: number | undefined): number {
  if (maxDistinctValues) return maxDistinctValues;
  switch (band) {
    case 'low':
      return 4;
    case 'medium':
      return 12;
    case 'high':
      return 10000;
    default:
      return 1;
  }
}

export interface BuildLayoutParams {
  readonly dimensions: readonly ResolvedFieldRef[];
  readonly measures: readonly ResolvedMeasureRef[];
  readonly dimensionBands: readonly CardinalityBand[];
  readonly dimensionMaxDistinct: readonly (number | undefined)[];
  readonly resultLimit: number;
}

export interface BuiltLayout {
  readonly qHyperCube: QixHyperCube;
  readonly bounded: BoundedResultMeta;
}

/** Builds a bounded, deterministic QIX-shaped hypercube and its bounded-result metadata. */
export function buildDeterministicLayout(params: BuildLayoutParams): BuiltLayout {
  const { dimensions, measures, resultLimit } = params;

  if (dimensions.length === 0) {
    const row = measures.map((measure, index) => {
      const values = KNOWN_MEASURE_VALUES[normalize(measure.label)] ?? [10000 + index * 1000];
      return { qText: String(values[0]), qNum: values[0] };
    });
    return {
      qHyperCube: {
        qSize: { qcx: measures.length, qcy: 1 },
        qMode: 'S',
        qDimensionInfo: [],
        qMeasureInfo: measures.map((measure) => ({ qFallbackTitle: measure.label })),
        qDataPages: [{ qMatrix: [row], qRowCount: 1 }],
      },
      bounded: { returnedRows: 1, maxRows: 1, truncated: false, rawDataIncluded: false },
    };
  }

  const primary = dimensions[0]!;
  const band = params.dimensionBands[0] ?? 'low';
  const maxDistinct = params.dimensionMaxDistinct[0];
  const totalCategories = bandCategoryCount(band, maxDistinct);
  const returnedRows = Math.min(totalCategories, resultLimit);
  const truncated = totalCategories > returnedRows;

  const knownLabels = KNOWN_DIMENSION_VALUES[normalize(primary.label)];
  const isCustomerId = normalize(primary.label) === 'customerid';

  const matrix = Array.from({ length: returnedRows }, (_, rowIndex) => {
    const dimensionCell: { qText: string; qNum?: number | 'NaN' } = isCustomerId
      ? { qText: customerId(rowIndex) }
      : knownLabels
        ? { qText: knownLabels[rowIndex % knownLabels.length]!, qNum: 'NaN' }
        : { qText: `Category ${rowIndex + 1}`, qNum: 'NaN' };

    const measureCells = measures.map((measure) => {
      const knownValues = KNOWN_MEASURE_VALUES[normalize(measure.label)];
      const value = knownValues
        ? knownValues[rowIndex % knownValues.length]!
        : 1000 * (rowIndex + 1);
      return { qText: String(value), qNum: value };
    });

    return [dimensionCell, ...measureCells];
  });

  const continuation = truncated
    ? isCustomerId
      ? 'fixture-continuation-001'
      : `fixture-continuation-${primary.catalogId}`
    : undefined;

  const dataPage: QixDataPage = {
    qMatrix: matrix,
    qRowCount: returnedRows,
    ...(continuation ? { continuation } : {}),
  };

  return {
    qHyperCube: {
      qSize: { qcx: dimensions.length + measures.length, qcy: returnedRows },
      qMode: 'S',
      qDimensionInfo: dimensions.map((dimension, index) => ({
        qFallbackTitle: dimension.label,
        qCardinal: index === 0 ? totalCategories : undefined,
      })),
      qMeasureInfo: measures.map((measure) => ({ qFallbackTitle: measure.label })),
      qDataPages: [dataPage],
    },
    bounded: {
      returnedRows,
      maxRows: resultLimit,
      truncated,
      rawDataIncluded: false,
      ...(continuation ? { continuation } : {}),
    },
  };
}
