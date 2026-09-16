import { describe, expect, it } from 'vitest';
import { compileChartIntent } from '../../../src/compiler/compiler.js';
import { chartIntentSchema } from '../../../src/compiler/chartIntentSchema.js';
import { FixtureRepository } from '../../../src/adapters/fixture/fixtureRepository.js';
import type { CatalogDefinition } from '../../../src/catalog/catalogTypes.js';
import type { VisualizationSchemaProfileId } from '../../../src/domain/types.js';

const repo = new FixtureRepository();
const catalog = repo.getCatalog('cloud-dev', 'app-sales-cloud-dev', 'default');
const target = {
  connection: 'cloud-dev',
  appId: 'app-sales-cloud-dev',
  sheetId: 'sheet-sales-overview-cloud-dev',
};

function compile(rawIntent: unknown) {
  const intent = chartIntentSchema.parse(rawIntent);
  return compileChartIntent({ catalog, target, platform: 'cloud', intent });
}

function expectFailureCode(rawIntent: unknown, code: string): void {
  expect.assertions(1);
  try {
    compile(rawIntent);
  } catch (error) {
    expect((error as { code: string }).code).toBe(code);
  }
}

describe('compileChartIntent: every registered chart type', () => {
  it('compiles a bar chart', () => {
    const plan = compile({
      analysis: { dimensions: ['Region'], measures: ['Revenue'] },
      presentation: { preferredChartType: 'bar', title: 'Bar' },
    });
    expect(plan.nativeChartType).toBe('barchart');
    expect(plan.propertyProposal).toMatchObject({
      visualization: 'barchart',
      qHyperCubeDef: {
        qDimensions: [{ qLibraryId: 'master-region' }],
        qMeasures: [{ qLibraryId: 'master-revenue' }],
      },
    });
    expect(plan.propertyProposal).toMatchObject({
      version: '2.7.0',
      barGrouping: { grouping: 'grouped' },
      orientation: 'vertical',
      qHyperCubeDef: {
        qMeasures: [{ qLibraryId: 'master-revenue', qSortBy: { qSortByNumeric: -1 } }],
      },
    });
    expect(plan.propertyProposal).not.toHaveProperty('sorting');
  });

  it('applies bounded filters through a literal-only cube context set', () => {
    const plan = compile({
      analysis: {
        dimensions: ['CustomerID'],
        measures: ['Revenue'],
        filters: [{ field: 'OrderDate', values: ['2026-01-01', "O'Brien"] }],
      },
      presentation: { preferredChartType: 'table', title: 'Filtered table', topN: 10 },
    });
    expect(plan.propertyProposal).toMatchObject({
      qHyperCubeDef: {
        qContextSetExpression: "{$<[OrderDate]={'2026-01-01','O''Brien'}>}",
      },
    });
  });

  it.each(['$(=Only({1} CustomerID))', "O'Brien $(=Only({1} CustomerID)) literal-suffix"])(
    'rejects Qlik dollar-sign expansion in a filter literal: %s',
    (value) => {
      expectFailureCode(
        {
          analysis: {
            dimensions: ['CustomerID'],
            measures: ['Revenue'],
            filters: [{ field: 'OrderDate', values: [value] }],
          },
          presentation: { preferredChartType: 'table', title: 'Filtered table', topN: 10 },
        },
        'DISALLOWED_EXPRESSION',
      );
    },
  );

  it.each(['cost $5', 'parenthesized (literal)', '$ (not an expansion)'])(
    'preserves a non-expansion filter literal at the dollar-sign boundary: %s',
    (value) => {
      const plan = compile({
        analysis: {
          dimensions: ['CustomerID'],
          measures: ['Revenue'],
          filters: [{ field: 'OrderDate', values: [value] }],
        },
        presentation: { preferredChartType: 'table', title: 'Filtered table', topN: 10 },
      });
      const hyperCube = plan.propertyProposal.qHyperCubeDef as {
        qContextSetExpression?: string;
      };
      expect(hyperCube.qContextSetExpression).toBe(`{$<[OrderDate]={'${value}'}>}`);
    },
  );

  it('uses a concrete field expression when an aggregation is explicit', () => {
    const plan = compile({
      analysis: { dimensions: ['CustomerID'], measures: ['Avg(Revenue)'] },
      presentation: { preferredChartType: 'table', title: 'Average', topN: 10 },
    });
    expect(plan.propertyProposal).toMatchObject({
      qHyperCubeDef: { qMeasures: [{ qDef: { qDef: 'Avg([Revenue])' } }] },
    });
  });

  it('aggregates an ordinary numeric field without promoting plain field labels to measures', () => {
    const numericFieldCatalog: CatalogDefinition = {
      ...catalog,
      fields: catalog.fields.map((field) =>
        field.label === 'Revenue' ? { ...field, role: 'dimension' as const } : field,
      ),
      masterItems: catalog.masterItems.filter((item) => item.label !== 'Revenue'),
    };
    const explicit = compileChartIntent({
      catalog: numericFieldCatalog,
      target,
      platform: 'cloud',
      intent: chartIntentSchema.parse({
        analysis: { dimensions: ['Region'], measures: ['Sum(Revenue)'] },
        presentation: { preferredChartType: 'bar', title: 'Explicit numeric field' },
      }),
    });

    expect(explicit.propertyProposal).toMatchObject({
      qHyperCubeDef: { qMeasures: [{ qDef: { qDef: 'Sum([Revenue])' } }] },
    });
    expect(() =>
      compileChartIntent({
        catalog: numericFieldCatalog,
        target,
        platform: 'cloud',
        intent: chartIntentSchema.parse({
          analysis: { dimensions: ['Region'], measures: ['Revenue'] },
          presentation: { preferredChartType: 'bar', title: 'Plain numeric field' },
        }),
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_MEASURE' }));
  });

  it('allows Count over visible text and rejects numeric-only aggregations over text', () => {
    const count = compile({
      analysis: { dimensions: ['OrderDate'], measures: ['Count(Region)'] },
      presentation: { preferredChartType: 'line', title: 'Count regions' },
    });
    expect(count.propertyProposal).toMatchObject({
      qHyperCubeDef: { qMeasures: [{ qDef: { qDef: 'Count([Region])' } }] },
    });
    expect(() =>
      compile({
        analysis: { dimensions: ['OrderDate'], measures: ['Avg(Region)'] },
        presentation: { preferredChartType: 'line', title: 'Invalid average' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_MEASURE' }));
  });

  it('bracket-escapes ordinary field names in allowlisted aggregations', () => {
    const escapedLabel = 'Sales Amount]Net';
    const escapedCatalog: CatalogDefinition = {
      ...catalog,
      fields: [
        ...catalog.fields,
        {
          id: 'field-sales-amount-net',
          label: escapedLabel,
          role: 'dimension',
          semanticType: 'numeric',
          cardinality: { band: 'continuous' },
          visible: true,
        },
      ],
    };
    const plan = compileChartIntent({
      catalog: escapedCatalog,
      target,
      platform: 'cloud',
      intent: chartIntentSchema.parse({
        analysis: { dimensions: ['Region'], measures: [`Median(${escapedLabel})`] },
        presentation: { preferredChartType: 'bar', title: 'Escaped field' },
      }),
    });

    expect(plan.propertyProposal).toMatchObject({
      qHyperCubeDef: {
        qMeasures: [{ qDef: { qDef: 'Median([Sales Amount]]Net])' } }],
      },
    });
  });

  it('places table sorting in the hypercube column definitions', () => {
    const plan = compile({
      analysis: { dimensions: ['CustomerID'], measures: ['Avg(Revenue)'] },
      presentation: {
        preferredChartType: 'table',
        title: 'Sorted table',
        sort: 'measure-ascending',
        topN: 10,
      },
    });

    expect(plan.propertyProposal).toMatchObject({
      qHyperCubeDef: {
        qDimensions: [{ qDef: { qSortCriterias: [{ qSortByAscii: 1 }] } }],
        qMeasures: [{ qSortBy: { qSortByNumeric: 1 } }],
        qInterColumnSortOrder: [1, 0],
      },
    });
    expect(plan.propertyProposal).not.toHaveProperty('sorting');
  });

  it('compiles a line chart over a date dimension', () => {
    const plan = compile({
      analysis: { dimensions: ['OrderDate'], measures: ['Revenue'] },
      presentation: { preferredChartType: 'line', title: 'Line' },
    });
    expect(plan.nativeChartType).toBe('linechart');
  });

  it('accepts a timestamp-semantic Cloud dimension for a date-axis line chart', () => {
    const timestampCatalog: CatalogDefinition = {
      ...catalog,
      fields: catalog.fields.map((field) =>
        field.label === 'OrderDate' ? { ...field, semanticType: 'timestamp' } : field,
      ),
    };
    const plan = compileChartIntent({
      catalog: timestampCatalog,
      target,
      platform: 'cloud',
      intent: chartIntentSchema.parse({
        analysis: { dimensions: ['OrderDate'], measures: ['Revenue'] },
        presentation: { preferredChartType: 'line', title: 'Timestamp line' },
      }),
    });

    expect(plan.nativeChartType).toBe('linechart');
  });

  it('compiles a scatter plot with exactly two numeric measures', () => {
    const plan = compile({
      analysis: { dimensions: [], measures: ['Revenue', 'Margin'] },
      presentation: { preferredChartType: 'scatter', title: 'Scatter' },
    });
    expect(plan.nativeChartType).toBe('scatterplot');
  });

  it('compiles a bounded table over a high-cardinality dimension', () => {
    const plan = compile({
      analysis: { dimensions: ['CustomerID'], measures: ['Revenue'] },
      presentation: { preferredChartType: 'table', title: 'Table', topN: 10 },
    });
    expect(plan.nativeChartType).toBe('sn-table');
    expect(plan.visualizationSchemaProfile).toBe('qlik-cloud-current');
    expect(plan.visualizationSchemaVersion).toBe('6.51.0');
    expect(plan.propertyProposal).toEqual(
      expect.objectContaining({
        qInfo: expect.objectContaining({ qType: 'sn-table' }),
        version: '6.51.0',
        qHyperCubeDef: expect.objectContaining({
          qColumnOrder: [0, 1],
          qInterColumnSortOrder: [1, 0],
        }),
        showTitles: true,
        enableChartExploration: false,
        title: 'Table',
        subtitle: '',
        footnote: '',
        totals: { label: 'Totals', show: true, position: 'noTotals' },
        usePagination: false,
        components: [],
      }),
    );
    expect(plan.propertyProposal).not.toHaveProperty('sorting');
    expect(plan.warnings).toContain('high-cardinality-dimension');
    expect(plan.warnings).toContain('bounded-result-required');
    expect(plan.riskClass).toBe('elevated');
    expect(plan.resultLimit).toBe(10);
  });

  it('compiles a KPI with zero dimensions', () => {
    const plan = compile({
      analysis: { dimensions: [], measures: ['Revenue'] },
      presentation: { preferredChartType: 'kpi', title: 'KPI' },
    });
    expect(plan.nativeChartType).toBe('kpi');
  });

  it('compiles a gauge with an explicit target', () => {
    const plan = compile({
      analysis: { dimensions: [], measures: ['Revenue'] },
      presentation: { preferredChartType: 'gauge', title: 'Gauge', target: 100000 },
    });
    expect(plan.nativeChartType).toBe('gauge');
    expect(plan.propertyProposal).toMatchObject({
      version: '0.10.0',
      gaugetype: 'radial',
      measureAxis: { min: 0, max: 100000 },
    });
  });

  it('rejects a gauge with no explicit target', () => {
    expectFailureCode(
      {
        analysis: { dimensions: [], measures: ['Revenue'] },
        presentation: { preferredChartType: 'gauge', title: 'Gauge' },
      },
      'INVALID_CHART_CONFIGURATION',
    );
  });

  it.each([0, -1])('rejects a non-positive gauge target: %s', (targetValue) => {
    expectFailureCode(
      {
        analysis: { dimensions: [], measures: ['Revenue'] },
        presentation: { preferredChartType: 'gauge', title: 'Gauge', target: targetValue },
      },
      'INVALID_CHART_CONFIGURATION',
    );
  });

  it('compiles a treemap', () => {
    const plan = compile({
      analysis: { dimensions: ['Region'], measures: ['Revenue'] },
      presentation: { preferredChartType: 'treemap', title: 'Treemap' },
    });
    expect(plan.nativeChartType).toBe('treemap');
    expect(plan.propertyProposal.qHyperCubeDef).toMatchObject({
      qMode: 'K',
      qNoOfLeftDims: -1,
      qAlwaysFullyExpanded: true,
      qMaxStackedCells: 3000,
    });
  });

  it('compiles a pie chart over a low-cardinality dimension', () => {
    const plan = compile({
      analysis: { dimensions: ['Region'], measures: ['Revenue'] },
      presentation: { preferredChartType: 'pie', title: 'Pie' },
    });
    expect(plan.nativeChartType).toBe('piechart');
  });

  it('compiles a combo chart with one dimension and two measures', () => {
    const plan = compile({
      analysis: { dimensions: ['Region'], measures: ['Revenue', 'Margin'] },
      presentation: { preferredChartType: 'combo', title: 'Combo' },
    });
    expect(plan.nativeChartType).toBe('combochart');
    expect(plan.propertyProposal).toMatchObject({
      version: '1.43.0',
      qHyperCubeDef: {
        qMeasures: [
          { qDef: { series: { type: 'bar', axis: 0, options: {} } } },
          { qDef: { series: { type: 'line', axis: 1, options: {} } } },
        ],
      },
    });
  });

  it.each([
    ['bar', '2.7.0', 'barGrouping'],
    ['line', '2.7.0', 'lineType'],
    ['scatter', '3.60.1', 'xAxis'],
    ['table', '6.51.0', 'totals'],
    ['kpi', '2.4.0', 'fontSize'],
    ['gauge', '0.10.0', 'measureAxis'],
    ['treemap', '1.8.0', 'labels'],
    ['pie', '2.8.0', 'donut'],
    ['combo', '1.43.0', 'measureAxes'],
  ] as const)('uses the pinned Cloud %s property contract', (chartType, version, requiredKey) => {
    const intents = {
      bar: { dimensions: ['Region'], measures: ['Revenue'] },
      line: { dimensions: ['OrderDate'], measures: ['Revenue'] },
      scatter: { dimensions: [], measures: ['Revenue', 'Margin'] },
      table: { dimensions: ['Region'], measures: ['Revenue'] },
      kpi: { dimensions: [], measures: ['Revenue'] },
      gauge: { dimensions: [], measures: ['Revenue'] },
      treemap: { dimensions: ['Region'], measures: ['Revenue'] },
      pie: { dimensions: ['Region'], measures: ['Revenue'] },
      combo: { dimensions: ['Region'], measures: ['Revenue', 'Margin'] },
    } as const;
    const plan = compile({
      analysis: intents[chartType],
      presentation: {
        preferredChartType: chartType,
        title: `${chartType} contract`,
        ...(chartType === 'gauge' ? { target: 100 } : {}),
      },
    });

    expect(plan.visualizationSchemaVersion).toBe(version);
    expect(plan.propertyProposal.version).toBe(version);
    expect(plan.propertyProposal).toHaveProperty(requiredKey);
    expect(plan.propertyProposal).not.toHaveProperty('sorting');
  });

  it.each(['bar', 'table'] as const)('does not fabricate sorting for %s sort:none', (chartType) => {
    const plan = compile({
      analysis: { dimensions: ['Region'], measures: ['Revenue'] },
      presentation: {
        preferredChartType: chartType,
        title: 'Unsorted chart',
        sort: 'none',
      },
    });
    const cube = plan.propertyProposal.qHyperCubeDef as Readonly<Record<string, unknown>>;

    expect(plan.propertyProposal).not.toHaveProperty('sorting');
    expect(JSON.stringify(cube)).not.toMatch(/qSortBy|qSortCriterias/);
    if (chartType === 'table') expect(cube.qInterColumnSortOrder).toEqual([]);
  });
});

describe('compileChartIntent: native sort contracts', () => {
  const cases = ['bar', 'line', 'scatter', 'pie', 'combo', 'table'] as const;

  describe.each(['master', 'field'] as const)('%s dimension and measure bindings', (binding) => {
    it.each(cases)('preserves explicit column precedence and criteria for %s', (chartType) => {
      const dimensionLabel = chartType === 'line' ? 'OrderDate' : 'Region';
      const sortCatalog: CatalogDefinition = {
        ...catalog,
        masterItems:
          binding === 'master'
            ? [
                ...catalog.masterItems,
                {
                  id: 'master-order-date',
                  label: 'OrderDate',
                  kind: 'dimension',
                  semanticType: 'date',
                  visible: true,
                },
              ]
            : [],
      };
      const measureLabels =
        chartType === 'combo' || chartType === 'scatter' ? ['Revenue', 'Margin'] : ['Revenue'];
      const measures =
        binding === 'master' ? measureLabels : measureLabels.map((label) => `Sum(${label})`);

      for (const sort of [
        'dimension-ascending',
        'dimension-descending',
        'measure-ascending',
        'measure-descending',
        'none',
      ] as const) {
        const plan = compileChartIntent({
          catalog: sortCatalog,
          target,
          platform: 'cloud',
          intent: chartIntentSchema.parse({
            analysis: { dimensions: [dimensionLabel], measures },
            presentation: { preferredChartType: chartType, title: 'Explicit sort', sort },
          }),
        });
        const cube = plan.propertyProposal.qHyperCubeDef as {
          qDimensions: Record<string, unknown>[];
          qMeasures: Record<string, unknown>[];
          qInterColumnSortOrder: number[];
        };
        const secondaryMeasures = measures.length > 1 ? [2] : [];
        const direction = sort.endsWith('descending') ? -1 : 1;

        expect(cube.qDimensions[0]).not.toHaveProperty('qSortBy');
        if (sort === 'none') {
          expect(cube.qInterColumnSortOrder).toEqual([]);
          expect(JSON.stringify(cube)).not.toMatch(/qSortBy|qSortCriterias/);
        } else if (sort.startsWith('measure')) {
          expect(cube.qInterColumnSortOrder).toEqual([1, 0, ...secondaryMeasures]);
          expect(cube.qMeasures[0]).toMatchObject({ qSortBy: { qSortByNumeric: direction } });
        } else {
          expect(cube.qInterColumnSortOrder).toEqual([0, 1, ...secondaryMeasures]);
          expect(cube.qDimensions[0]).toMatchObject({
            qDef: {
              qSortCriterias: [
                chartType === 'line' ? { qSortByNumeric: direction } : { qSortByAscii: direction },
              ],
            },
          });
        }
      }
    });
  });

  it.each(['numeric', 'date', 'timestamp', 'time'])(
    'uses numeric ordering for a %s dimension',
    (semanticType) => {
      const sortCatalog: CatalogDefinition = {
        ...catalog,
        fields: catalog.fields.map((field) =>
          field.label === 'Region' ? { ...field, semanticType } : field,
        ),
        masterItems: catalog.masterItems.filter((item) => item.label !== 'Region'),
      };
      for (const sort of ['dimension-ascending', 'dimension-descending'] as const) {
        const plan = compileChartIntent({
          catalog: sortCatalog,
          target,
          platform: 'cloud',
          intent: chartIntentSchema.parse({
            analysis: { dimensions: ['Region'], measures: ['Revenue'] },
            presentation: { preferredChartType: 'bar', title: 'Numeric dimension', sort },
          }),
        });

        expect(plan.propertyProposal.qHyperCubeDef).toMatchObject({
          qDimensions: [
            {
              qDef: {
                qSortCriterias: [{ qSortByNumeric: sort === 'dimension-descending' ? -1 : 1 }],
              },
            },
          ],
          qInterColumnSortOrder: [0, 1],
        });
      }
    },
  );

  it('places the measure after all dimensions when calculating its sort-column index', () => {
    const plan = compile({
      analysis: { dimensions: ['Region', 'OrderDate'], measures: ['Revenue', 'Margin'] },
      presentation: { preferredChartType: 'bar', title: 'Grouped bar', sort: 'measure-descending' },
    });

    expect(plan.propertyProposal.qHyperCubeDef).toMatchObject({
      qInterColumnSortOrder: [2, 0, 1, 3],
      qMeasures: [{ qSortBy: { qSortByNumeric: -1 } }, { qLibraryId: 'master-margin' }],
    });
  });

  it.each(['treemap', 'scatter', 'kpi', 'gauge'] as const)(
    'retains valid default measure precedence for %s',
    (chartType) => {
      const plan = compile({
        analysis: {
          dimensions: chartType === 'treemap' ? ['Region'] : [],
          measures: chartType === 'scatter' ? ['Revenue', 'Margin'] : ['Revenue'],
        },
        presentation: { preferredChartType: chartType, title: 'Default sort', target: 100 },
      });

      expect(plan.propertyProposal.qHyperCubeDef).toMatchObject({
        qInterColumnSortOrder:
          chartType === 'treemap' ? [1, 0] : chartType === 'scatter' ? [0, 1] : [0],
        qMeasures: expect.arrayContaining([
          { qLibraryId: 'master-revenue', qSortBy: { qSortByNumeric: -1 } },
        ]),
      });
    },
  );

  it('preserves Engine sort properties in the Windows native-chart branch', () => {
    const plan = compileChartIntent({
      catalog,
      target,
      platform: 'windows',
      intent: chartIntentSchema.parse({
        analysis: { dimensions: ['Region'], measures: ['Revenue'] },
        presentation: {
          preferredChartType: 'bar',
          title: 'Windows sort',
          sort: 'measure-descending',
        },
      }),
    });

    expect(plan.propertyProposal.qHyperCubeDef).toMatchObject({
      qInterColumnSortOrder: [1, 0],
      qMeasures: [{ qSortBy: { qSortByNumeric: -1 } }],
    });
  });
});

describe('compileChartIntent: planner negative cases (test/fixtures/operations.json)', () => {
  it('rejects an unknown field', () => {
    expectFailureCode(
      {
        analysis: { dimensions: ['NotInCatalog'], measures: ['Revenue'] },
        presentation: { preferredChartType: 'bar', title: 'x' },
      },
      'UNKNOWN_FIELD',
    );
  });

  it('rejects an unsupported chart type', () => {
    expectFailureCode(
      {
        analysis: { dimensions: ['Region'], measures: ['Revenue'] },
        presentation: { preferredChartType: 'radar', title: 'x' },
      },
      'UNSUPPORTED_CHART',
    );
  });

  it('rejects a disallowed compound expression', () => {
    expectFailureCode(
      {
        analysis: { dimensions: ['Region'], measures: ['Sum(Revenue)+Avg(Margin)'] },
        presentation: { preferredChartType: 'bar', title: 'x' },
      },
      'DISALLOWED_EXPRESSION',
    );
  });

  it('rejects a measure-typed field used as a dimension', () => {
    expectFailureCode(
      {
        analysis: { dimensions: ['Revenue'], measures: ['Margin'] },
        presentation: { preferredChartType: 'bar', title: 'x' },
      },
      'INVALID_DIMENSION',
    );
  });

  it('rejects a dimension-typed field used as a measure', () => {
    expectFailureCode(
      {
        analysis: { dimensions: ['Region'], measures: ['OrderDate'] },
        presentation: { preferredChartType: 'bar', title: 'x' },
      },
      'INVALID_MEASURE',
    );
  });

  it('rejects an ambiguous field', () => {
    expectFailureCode(
      {
        analysis: { dimensions: ['Status'], measures: ['Revenue'] },
        presentation: { preferredChartType: 'bar', title: 'x' },
      },
      'AMBIGUOUS_FIELD',
    );
  });

  it('rejects a sensitive field', () => {
    expectFailureCode(
      {
        analysis: { dimensions: ['CustomerEmail'], measures: ['Revenue'] },
        presentation: { preferredChartType: 'bar', title: 'x' },
      },
      'SENSITIVE_FIELD',
    );
  });
});

describe('compileChartIntent: determinism', () => {
  const rawIntent = {
    analysis: { dimensions: ['Region'], measures: ['Revenue'] },
    presentation: { preferredChartType: 'bar', title: 'Sales by region' },
  };

  it('produces the same plan hash for the same normalized input and catalog', () => {
    const planA = compile(rawIntent);
    const planB = compile(rawIntent);
    expect(planA.planHash).toBe(planB.planHash);
    expect(planA.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces a different plan hash for a materially different input', () => {
    const planA = compile(rawIntent);
    const planB = compile({
      analysis: { dimensions: ['Region'], measures: ['Margin'] },
      presentation: { preferredChartType: 'bar', title: 'Sales by region' },
    });
    expect(planA.planHash).not.toBe(planB.planHash);
  });

  it('does not reuse the pre-fix compiler hash for the corrected native properties', () => {
    const current = compile(rawIntent);
    const previousVersion = compileChartIntent({
      catalog,
      target,
      platform: 'cloud',
      compilerVersion: 'fixture-compiler-v3',
      intent: chartIntentSchema.parse(rawIntent),
    });

    expect(current.compilerVersion).toBe('fixture-compiler-v4');
    expect(current.planHash).not.toBe(previousVersion.planHash);
  });

  it("never exposes a raw QIX request shape in the resolved plan's public fields", () => {
    const plan = compile(rawIntent);
    expect(Object.keys(plan)).not.toContain('qixHandle');
    expect(JSON.stringify(plan.diff)).not.toMatch(/qHyperCubeDef/);
  });

  it('binds deterministic table hashes to the selected Windows schema profile and version', () => {
    const intent = chartIntentSchema.parse({
      analysis: { dimensions: ['CustomerID'], measures: ['Revenue'] },
      presentation: { preferredChartType: 'table', title: 'Windows table', topN: 10 },
    });
    const compileWindowsTable = (
      visualizationSchemaProfile: VisualizationSchemaProfileId,
      visualizationSchemaVersion?: string,
    ) =>
      compileChartIntent({
        catalog,
        target,
        platform: 'windows',
        visualizationSchemaProfile,
        ...(visualizationSchemaVersion ? { visualizationSchemaVersion } : {}),
        intent,
      });

    const legacyA = compileWindowsTable('qlik-windows-pre-november-2025');
    const legacyB = compileWindowsTable('qlik-windows-pre-november-2025');
    const modern = compileWindowsTable('qlik-windows-november-2025-or-later', '6.44.0');
    const modernOtherVersion = compileWindowsTable('qlik-windows-november-2025-or-later', '6.45.0');

    expect(legacyA.planHash).toBe(legacyB.planHash);
    expect(legacyA.planHash).not.toBe(modern.planHash);
    expect(modern.planHash).not.toBe(modernOtherVersion.planHash);
    expect(legacyA.nativeChartType).toBe('table');
    expect(legacyA.propertyProposal).toMatchObject({
      qInfo: { qType: 'table' },
      qHyperCubeDef: { qColumnOrder: [0, 1], qInterColumnSortOrder: [1, 0] },
    });
    expect(legacyA.propertyProposal).not.toHaveProperty('version');
    expect(legacyA.propertyProposal).not.toHaveProperty('sorting');
    expect(modern.nativeChartType).toBe('sn-table');
    expect(modern.propertyProposal).toMatchObject({
      qInfo: { qType: 'sn-table' },
      version: '6.44.0',
      qHyperCubeDef: { qColumnOrder: [0, 1], qInterColumnSortOrder: [1, 0] },
    });
  });

  it('fails closed for unknown, mismatched, and unversioned modern Windows profiles', () => {
    const intent = chartIntentSchema.parse(rawIntent);
    const compileWithProfile = (
      platform: 'cloud' | 'windows',
      visualizationSchemaProfile: VisualizationSchemaProfileId,
    ) => compileChartIntent({ catalog, target, platform, visualizationSchemaProfile, intent });

    expect(() => compileWithProfile('cloud', 'qlik-windows-pre-november-2025')).toThrowError(
      /not valid for platform/,
    );
    expect(() =>
      compileWithProfile('cloud', 'unknown-profile' as VisualizationSchemaProfileId),
    ).toThrowError(/not valid for platform/);
    expect(() => compileWithProfile('windows', 'qlik-windows-november-2025-or-later')).toThrowError(
      /host-validated semantic sn-table property version/,
    );
  });
});
