import { describe, expect, it } from 'vitest';
import { derivePlanHash } from '../../../src/compiler/planHash.js';

const baseInput = {
  compilerVersion: 'fixture-compiler-v1',
  catalogId: 'sales-demo-v1',
  platform: 'cloud',
  visualizationSchemaProfile: 'qlik-cloud-current',
  visualizationSchemaVersion: '6.51.0',
  target: {
    connection: 'cloud-dev',
    appId: 'app-sales-cloud-dev',
    sheetId: 'sheet-sales-overview-cloud-dev',
  },
  chartType: 'bar',
  dimensions: [{ catalogId: 'master-region', label: 'Region' }],
  measures: [{ catalogId: 'master-revenue', expression: 'Sum(Revenue)' }],
  filters: [],
  presentation: {
    title: 'Sales by region',
    sort: 'measure-descending',
    target: null,
    resultLimit: 50,
  },
};

describe('derivePlanHash', () => {
  it('is deterministic for identical input', () => {
    expect(derivePlanHash(baseInput)).toBe(derivePlanHash(baseInput));
  });

  it('is insensitive to object key order', () => {
    const reordered = {
      target: baseInput.target,
      compilerVersion: baseInput.compilerVersion,
      chartType: baseInput.chartType,
      catalogId: baseInput.catalogId,
      platform: baseInput.platform,
      visualizationSchemaProfile: baseInput.visualizationSchemaProfile,
      visualizationSchemaVersion: baseInput.visualizationSchemaVersion,
      measures: baseInput.measures,
      dimensions: baseInput.dimensions,
      filters: baseInput.filters,
      presentation: baseInput.presentation,
    };
    expect(derivePlanHash(baseInput)).toBe(derivePlanHash(reordered));
  });

  it('changes when any semantically meaningful field changes', () => {
    const changed = { ...baseInput, chartType: 'line' };
    expect(derivePlanHash(baseInput)).not.toBe(derivePlanHash(changed));
  });

  it('changes when the visualization schema profile or property version changes', () => {
    expect(
      derivePlanHash({
        ...baseInput,
        visualizationSchemaProfile: 'qlik-windows-november-2025-or-later',
      }),
    ).not.toBe(derivePlanHash(baseInput));
    expect(derivePlanHash({ ...baseInput, visualizationSchemaVersion: '6.44.0' })).not.toBe(
      derivePlanHash(baseInput),
    );
  });

  it('produces a sha256:<hex> formatted hash', () => {
    expect(derivePlanHash(baseInput)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
