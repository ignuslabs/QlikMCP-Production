import { describe, expect, it } from 'vitest';
import { FixtureRepository } from '../../../src/adapters/fixture/fixtureRepository.js';
import { chartIntentSchema } from '../../../src/compiler/chartIntentSchema.js';
import { compileChartIntent } from '../../../src/compiler/compiler.js';
import type { CreateSessionChartResult } from '../../../src/adapters/targetAdapter.js';
import type { ResolvedChartPlan } from '../../../src/domain/types.js';
import {
  assertCloudTablePlan,
  assertUsableCloudPreviewLayout,
  assertUsableCloudPreviewLayoutAndDispose,
  CloudPreviewLayoutContractError,
  diagnoseCloudPreviewLayout,
  hasUsableMeasureCell,
  parseCloudProbeFieldLabel,
  summarizeCloudProbeInputContract,
} from '../../live/cloudTableContract.js';
import {
  preserveFailureAfterCleanup,
  RetainedObjectCleanupRequiredError,
  RetainedObjectFailureAfterConfirmedCleanupError,
} from '../../live/cloudProbeFailure.js';
import {
  cloudLiveProbeError,
  liveProbeDiagnostics,
  liveProbeStage,
} from '../../live/cloudProbeDiagnostics.js';
import { assertRetainedManifestSlotAvailable } from '../../live/cloudRetainedManifest.js';

const repository = new FixtureRepository();
const catalog = repository.getCatalog('cloud-dev', 'app-sales-cloud-dev', 'default');
const intent = chartIntentSchema.parse({
  analysis: { dimensions: ['CustomerID'], measures: ['Avg(Revenue)'] },
  presentation: {
    preferredChartType: 'table',
    title: 'Cloud retained-object contract',
    topN: 10,
  },
});

function cloudTablePlan(): ResolvedChartPlan {
  return compileChartIntent({
    catalog,
    target: {
      connection: 'cloud-dev',
      appId: 'app-sales-cloud-dev',
      sheetId: 'sheet-sales-overview-cloud-dev',
    },
    platform: 'cloud',
    visualizationSchemaProfile: 'qlik-cloud-current',
    intent,
  });
}

function withProperties(
  plan: ResolvedChartPlan,
  update: Readonly<Record<string, unknown>>,
): ResolvedChartPlan {
  return { ...plan, propertyProposal: { ...plan.propertyProposal, ...update } };
}

function previewFor(plan: ResolvedChartPlan): CreateSessionChartResult {
  return {
    sessionObjectId: 'session-object-sensitive-id',
    layout: {
      objectId: 'session-object-sensitive-id',
      objectType: 'sn-table',
      title: 'sensitive-layout-title',
      qInfo: { type: 'sn-table', id: 'session-object-sensitive-id' },
      qHyperCube: {
        qSize: { qcx: 2, qcy: 1 },
        qMode: 'S',
        qDimensionInfo: [{ qFallbackTitle: 'sensitive-dimension-title' }],
        qMeasureInfo: [{ qFallbackTitle: 'sensitive-measure-title' }],
        qDataPages: [
          {
            qMatrix: [
              [
                { qText: 'sensitive-dimension-value' },
                { qText: 'sensitive-measure-value', qNum: 12 },
              ],
            ],
          },
        ],
      },
      bounded: {
        returnedRows: 1,
        maxRows: plan.resultLimit,
        truncated: false,
        rawDataIncluded: false,
      },
    },
  };
}

function inputContract(plan: ResolvedChartPlan) {
  return summarizeCloudProbeInputContract(
    plan,
    parseCloudProbeFieldLabel('dimension', 'CustomerID'),
    parseCloudProbeFieldLabel('measure', 'Avg(Revenue)'),
  );
}

describe('live Cloud retained-object contract', () => {
  it('accepts the canonical current Cloud sn-table plan', () => {
    expect(() => assertCloudTablePlan(cloudTablePlan())).not.toThrow();
  });

  it('rejects legacy type, schema drift, invented sorting, and missing column order', () => {
    const plan = cloudTablePlan();
    const cube = plan.propertyProposal.qHyperCubeDef as Readonly<Record<string, unknown>>;

    expect(() => assertCloudTablePlan({ ...plan, nativeChartType: 'table' })).toThrowError(
      /pinned sn-table contract/,
    );
    expect(() => assertCloudTablePlan(withProperties(plan, { version: '6.50.0' }))).toThrowError(
      /pinned sn-table contract/,
    );
    expect(() => assertCloudTablePlan(withProperties(plan, { sorting: {} }))).toThrowError(
      /pinned sn-table contract/,
    );
    expect(() =>
      assertCloudTablePlan(
        withProperties(plan, {
          qHyperCubeDef: { ...cube, qColumnOrder: undefined },
        }),
      ),
    ).toThrowError(/pinned sn-table contract/);
  });

  it('rejects NaN measure cells before considering formatted text', () => {
    const plan = cloudTablePlan();

    expect(hasUsableMeasureCell(plan, [[{}, { qNum: 'NaN', qText: '-' }]])).toBe(false);
    expect(hasUsableMeasureCell(plan, [[{}, { qNum: Number.NaN, qText: '-' }]])).toBe(false);
    expect(hasUsableMeasureCell(plan, [[{}, { qNum: 12, qText: '$12' }]])).toBe(true);
    expect(hasUsableMeasureCell(plan, [[{}, { qText: '$12' }]])).toBe(true);
  });

  it('accepts bounded labels and the compiler allowlisted measure grammar', () => {
    expect(parseCloudProbeFieldLabel('dimension', ' Region ')).toEqual({
      value: 'Region',
      format: 'catalog-label',
    });
    expect(parseCloudProbeFieldLabel('measure', 'Revenue')).toEqual({
      value: 'Revenue',
      format: 'catalog-label',
    });
    expect(parseCloudProbeFieldLabel('measure', 'Median(Revenue)')).toEqual({
      value: 'Median(Revenue)',
      format: 'allowlisted-aggregation',
    });
  });

  it.each([
    ['dimension', undefined, 'missing-or-empty'],
    ['dimension', `safe${String.fromCharCode(10)}hidden`, 'control-character'],
    ['dimension', `safe${String.fromCharCode(0x85)}hidden`, 'control-character'],
    ['dimension', 'Sum(Region)', 'expression-syntax'],
    ['dimension', 'x'.repeat(121), 'too-long'],
    ['measure', 'Only(Revenue)', 'expression-syntax'],
    ['measure', 'Sum(Revenue)+1', 'expression-syntax'],
    ['measure', 'x'.repeat(201), 'too-long'],
  ] as const)('rejects invalid %s probe input without echoing it', (role, value, reason) => {
    expect.assertions(3);
    try {
      parseCloudProbeFieldLabel(role, value);
    } catch (error) {
      const envelope = (
        error as {
          toEnvelope: () => { message: string; details?: Readonly<Record<string, unknown>> };
        }
      ).toEnvelope();
      expect(envelope.details?.reason).toBe(reason);
      expect(envelope.message).not.toContain(value ?? 'undefined');
      expect(JSON.stringify(envelope)).not.toContain(value ?? 'undefined');
    }
  });

  it('returns structured data-free diagnostics for a usable preview', () => {
    const plan = cloudTablePlan();
    const diagnostics = assertUsableCloudPreviewLayout(plan, previewFor(plan), inputContract(plan));

    expect(diagnostics).toMatchObject({
      diagnosticVersion: 'cloud-preview-layout-v1',
      passed: true,
      inputContract: {
        dimension: { format: 'catalog-label', resolvedSource: 'field', roleMatched: true },
        measure: {
          format: 'allowlisted-aggregation',
          resolvedSource: 'field',
          roleMatched: true,
        },
      },
      checks: {
        objectIdMatchesSession: true,
        qInfoIdMatchesSession: true,
        objectTypeMatches: true,
        qInfoTypeMatches: true,
        cubeModeMatches: true,
        columnCountMatches: true,
        rowCountPositive: true,
        dimensionInfoCountMatches: true,
        measureInfoCountMatches: true,
        returnedRowsPositive: true,
        matrixRowsPositive: true,
        fullWidthMatrixRowPresent: true,
        usableMeasureCellPresent: true,
      },
      observed: {
        objectType: 'sn-table',
        qInfoType: 'sn-table',
        cubeMode: 'S',
        expectedColumnCount: 2,
        cubeColumnCount: 2,
        cubeRowCount: 1,
        matrixRowCount: 1,
        fullWidthMatrixRowCount: 1,
        usableMeasureRowCount: 1,
      },
    });
  });

  it('classifies simultaneous failures without serializing labels, IDs, titles, or cells', () => {
    const basePlan = cloudTablePlan();
    const plan: ResolvedChartPlan = {
      ...basePlan,
      title: 'sensitive-plan-title',
      resolved: {
        ...basePlan.resolved,
        dimensions: basePlan.resolved.dimensions.map((dimension) => ({
          ...dimension,
          label: 'sensitive-input-dimension',
        })),
        measures: basePlan.resolved.measures.map((measure) => ({
          ...measure,
          label: 'sensitive-input-measure',
          expression: 'Sum(sensitive-expression)',
        })),
      },
    };
    const basePreview = previewFor(plan);
    const preview: CreateSessionChartResult = {
      ...basePreview,
      sessionObjectId: 'sensitive-session-id',
      layout: {
        ...basePreview.layout,
        objectId: 'different-sensitive-object-id',
        objectType: 'sensitive-object-type',
        qInfo: { type: 'customer-secret', id: 'different-sensitive-qinfo-id' },
        qHyperCube: {
          ...basePreview.layout.qHyperCube,
          qSize: { qcx: 99, qcy: 0 },
          qDimensionInfo: [],
          qMeasureInfo: [],
          qDataPages: [
            {
              qMatrix: [
                [
                  { qText: 'sensitive-matrix-dimension' },
                  { qText: 'sensitive-matrix-measure', qNum: 'NaN' },
                ],
              ],
            },
          ],
        },
        bounded: { ...basePreview.layout.bounded, returnedRows: 0 },
      },
    };
    const diagnostics = diagnoseCloudPreviewLayout(plan, preview, inputContract(basePlan));
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.passed).toBe(false);
    expect(diagnostics.checks).toMatchObject({
      objectIdMatchesSession: false,
      qInfoIdMatchesSession: false,
      objectTypeMatches: false,
      qInfoTypeMatches: false,
      columnCountMatches: false,
      rowCountPositive: false,
      dimensionInfoCountMatches: false,
      measureInfoCountMatches: false,
      returnedRowsPositive: false,
      usableMeasureCellPresent: false,
    });
    expect(diagnostics.observed).toMatchObject({
      objectType: 'invalid-or-unexpected',
      qInfoType: 'invalid-or-unexpected',
      cubeColumnCount: 99,
      cubeRowCount: 0,
      usableMeasureRowCount: 0,
    });
    for (const forbidden of [
      'sensitive-input-dimension',
      'sensitive-input-measure',
      'sensitive-expression',
      'sensitive-plan-title',
      'sensitive-session-id',
      'different-sensitive-object-id',
      'different-sensitive-qinfo-id',
      'sensitive-layout-title',
      'sensitive-dimension-title',
      'sensitive-measure-title',
      'sensitive-matrix-dimension',
      'sensitive-matrix-measure',
      'sensitive-object-type',
      'customer-secret',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(() => assertUsableCloudPreviewLayout(plan, preview, inputContract(basePlan))).toThrow(
      CloudPreviewLayoutContractError,
    );
  });

  it('preserves the primary layout diagnostics when session disposal also fails', async () => {
    const plan = cloudTablePlan();
    const basePreview = previewFor(plan);
    const preview: CreateSessionChartResult = {
      ...basePreview,
      layout: {
        ...basePreview.layout,
        qHyperCube: {
          ...basePreview.layout.qHyperCube,
          qSize: { ...basePreview.layout.qHyperCube.qSize, qcy: 0 },
        },
      },
    };

    const error = await assertUsableCloudPreviewLayoutAndDispose({
      plan,
      preview,
      inputContract: inputContract(plan),
      dispose: async () => {
        throw new Error('sensitive-disposal-error');
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudPreviewLayoutContractError);
    expect(error).toMatchObject({
      diagnostics: { checks: { rowCountPositive: false } },
    });
    expect((error as Error).message).not.toContain('sensitive-disposal-error');
  });

  it('propagates disposal failure after a valid layout', async () => {
    const plan = cloudTablePlan();
    const disposalError = new Error('sanitized-disposal-failure');

    await expect(
      assertUsableCloudPreviewLayoutAndDispose({
        plan,
        preview: previewFor(plan),
        inputContract: inputContract(plan),
        dispose: async () => {
          throw disposalError;
        },
      }),
    ).rejects.toBe(disposalError);
  });

  it('returns diagnostics only after disposing a valid preview', async () => {
    const plan = cloudTablePlan();
    let disposed = false;

    const diagnostics = await assertUsableCloudPreviewLayoutAndDispose({
      plan,
      preview: previewFor(plan),
      inputContract: inputContract(plan),
      dispose: async () => {
        disposed = true;
      },
    });

    expect(disposed).toBe(true);
    expect(diagnostics.passed).toBe(true);
  });

  it('preserves the primary failure code and cleanup target when cleanup is not confirmed', async () => {
    const primaryError = cloudLiveProbeError(
      'PERSISTED_OBJECT_CONTRACT_MISMATCH',
      'retained-contract',
      { propertyVersionMatches: false },
      'sanitized schema mismatch',
    );
    const target = {
      connection: 'cloud-dev',
      appId: 'app-sales-cloud-dev',
      sheetId: 'sheet-sales-overview-cloud-dev',
    };

    const failure = preserveFailureAfterCleanup({
      primaryError,
      primaryCode: primaryError.code,
      primaryStage: primaryError.stage,
      target,
      objectId: 'retained-object-id',
      sheetAttachmentId: 'retained-object-id',
      cleanup: async () => ({ attempted: true, outcome: 'cleanup-failed' }),
    });

    await expect(failure).rejects.toMatchObject({
      code: 'CLEANUP_NOT_CONFIRMED',
      stage: 'cleanup',
      primaryCode: 'PERSISTED_OBJECT_CONTRACT_MISMATCH',
      primaryStage: 'retained-contract',
      cleanupAttempted: true,
      cleanupSucceeded: false,
      cleanupRequired: {
        objectId: 'retained-object-id',
        appId: target.appId,
        sheetId: target.sheetId,
      },
    });
    await expect(failure).rejects.toBeInstanceOf(RetainedObjectCleanupRequiredError);
  });

  it('preserves the primary code and records confirmed cleanup after failure', async () => {
    const primaryError = cloudLiveProbeError(
      'PERSISTED_OBJECT_CONTRACT_MISMATCH',
      'retained-contract',
      { propertyVersionMatches: false },
      'sanitized schema mismatch',
    );

    await expect(
      preserveFailureAfterCleanup({
        primaryError,
        primaryCode: primaryError.code,
        primaryStage: primaryError.stage,
        primaryDiagnostics: primaryError.diagnostics,
        target: {
          connection: 'cloud-dev',
          appId: 'app-sales-cloud-dev',
          sheetId: 'sheet-sales-overview-cloud-dev',
        },
        objectId: 'retained-object-id',
        cleanup: async () => ({ attempted: true, outcome: 'cleanup-complete' }),
      }),
    ).rejects.toMatchObject({
      code: 'PERSISTED_OBJECT_CONTRACT_MISMATCH',
      stage: 'retained-contract',
      diagnostics: { propertyVersionMatches: false },
      cleanupAttempted: true,
      cleanupSucceeded: true,
    });
    await expect(
      preserveFailureAfterCleanup({
        primaryError,
        primaryCode: primaryError.code,
        primaryStage: primaryError.stage,
        primaryDiagnostics: primaryError.diagnostics,
        target: {
          connection: 'cloud-dev',
          appId: 'app-sales-cloud-dev',
          sheetId: 'sheet-sales-overview-cloud-dev',
        },
        objectId: 'retained-object-id',
        cleanup: async () => ({ attempted: true, outcome: 'cleanup-complete' }),
      }),
    ).rejects.toBeInstanceOf(RetainedObjectFailureAfterConfirmedCleanupError);
  });

  it('keeps diagnostics serializable after confirmed exact-object cleanup', async () => {
    const primaryError = cloudLiveProbeError(
      'PERSISTED_OBJECT_CONTRACT_MISMATCH',
      'retained-contract',
      { propertyVersionMatches: false },
      'sanitized schema mismatch',
    );
    const failure = await preserveFailureAfterCleanup({
      primaryError,
      primaryCode: primaryError.code,
      primaryStage: primaryError.stage,
      primaryDiagnostics: primaryError.diagnostics,
      target: {
        connection: 'cloud-dev',
        appId: 'app-sales-cloud-dev',
        sheetId: 'sheet-sales-overview-cloud-dev',
      },
      objectId: 'retained-object-id',
      cleanup: async () => ({ attempted: true, outcome: 'cleanup-complete' }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RetainedObjectFailureAfterConfirmedCleanupError);
    expect(liveProbeDiagnostics(failure)).toEqual({ propertyVersionMatches: false });
  });

  it('fails closed when a retain manifest slot is already occupied', () => {
    expect.assertions(3);
    try {
      assertRetainedManifestSlotAvailable('/not-accessed/retained-object.json', () => true);
    } catch (error) {
      expect(error).toMatchObject({ code: 'NOT_CONFIGURED' });
      expect((error as Error).message).toMatch(/run cleanup or reconcile/);
    }
    expect(() =>
      assertRetainedManifestSlotAvailable('/not-accessed/retained-object.json', () => false),
    ).not.toThrow();
  });

  it('retains fixed, data-free stage diagnostics for a reopened contract mismatch', () => {
    const error = cloudLiveProbeError(
      'PERSISTED_OBJECT_CONTRACT_MISMATCH',
      'retained-contract',
      {
        propertyNativeKindMatches: true,
        propertyVersionMatches: false,
        layoutVisualizationMatches: false,
      },
      'sanitized contract mismatch',
    );

    expect(error.code).toBe('PERSISTED_OBJECT_CONTRACT_MISMATCH');
    expect(liveProbeStage(error)).toBe('retained-contract');
    expect(liveProbeDiagnostics(error)).toEqual({
      propertyNativeKindMatches: true,
      propertyVersionMatches: false,
      layoutVisualizationMatches: false,
    });
    expect(JSON.stringify(error)).not.toMatch(/field|expression|matrix|token/i);
  });
});
