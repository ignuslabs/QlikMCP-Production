import { describe, expect, it } from 'vitest';
import { TOOL_CAPABILITY, availableTools } from '../../../src/adapters/capabilityProbe.js';
import { FixtureAdapter } from '../../../src/adapters/fixture/fixtureAdapter.js';
import { PolicyEngine } from '../../../src/policy/policy.js';
import { buildTestPolicyConfig, MUTATOR_ACTOR } from '../../helpers/testContext.js';
import type { CapabilityProbeResult } from '../../../src/adapters/targetAdapter.js';

const ALL_TOOL_NAMES = [
  'qlik_apply_visualization',
  'qlik_approve_visualization_request',
  'qlik_get_app_catalog',
  'qlik_get_operation',
  'qlik_get_readiness',
  'qlik_get_visualization_approval',
  'qlik_list_apps',
  'qlik_list_sheet_objects',
  'qlik_plan_visualization',
  'qlik_preview_visualization',
  'qlik_reject_visualization_request',
  'qlik_request_visualization_approval',
] as const;

function capabilities(overrides: Partial<CapabilityProbeResult> = {}): CapabilityProbeResult {
  return {
    platform: 'cloud',
    connection: 'cloud-dev',
    configured: false,
    canRead: false,
    canPreview: false,
    canWriteDesignatedSheet: false,
    cleanupVerified: false,
    reason: 'test',
    ...overrides,
  };
}

describe('tool capability mapping', () => {
  it('maps the 12 governed tools and four opt-in sheet tools', () => {
    expect(Object.keys(TOOL_CAPABILITY).sort()).toEqual(
      [
        ...ALL_TOOL_NAMES,
        'qlik_plan_sheet',
        'qlik_preview_sheet',
        'qlik_apply_sheet',
        'qlik_verify_sheet',
      ].sort(),
    );
  });

  it('keeps service workflow tools visible while target calls fail closed at call time', () => {
    expect([...availableTools(capabilities())].sort()).toEqual(
      [
        'qlik_approve_visualization_request',
        'qlik_get_operation',
        'qlik_get_readiness',
        'qlik_get_visualization_approval',
        'qlik_reject_visualization_request',
      ].sort(),
    );
  });

  it('advertises mutation only after both designated-sheet write and cleanup are proven', () => {
    const readOnly = availableTools(
      capabilities({ configured: true, canRead: true, canPreview: true }),
    );
    expect(readOnly).not.toContain('qlik_request_visualization_approval');
    expect(readOnly).not.toContain('qlik_apply_visualization');

    const ready = availableTools(
      capabilities({
        configured: true,
        canRead: true,
        canPreview: true,
        canWriteDesignatedSheet: true,
        cleanupVerified: true,
      }),
    );
    expect(ready).toContain('qlik_request_visualization_approval');
    expect(ready).toContain('qlik_apply_visualization');
  });
  it('advertises sheets only for an explicit authorized actor/app/chart scope with provider support', () => {
    const config = buildTestPolicyConfig();
    const connection = config.connections['cloud-dev']!;
    const grant = {
      actors: [MUTATOR_ACTOR.actor],
      appIds: ['app-sales-cloud-dev'],
      chartTypes: ['bar'] as const,
      maxCharts: 2,
      allowProduction: false,
    };
    const context = {
      policy: new PolicyEngine({
        ...config,
        connections: {
          ...config.connections,
          'cloud-dev': { ...connection, sheetGeneration: grant },
        },
      }),
      adapter: new FixtureAdapter(),
      actor: MUTATOR_ACTOR.actor,
      appId: 'app-sales-cloud-dev',
      chartTypes: ['bar'] as const,
    };
    const ready = capabilities({
      configured: true,
      canRead: true,
      canPreview: true,
      canWriteDesignatedSheet: true,
      cleanupVerified: true,
    });
    const sheetTools = (value: readonly string[]) =>
      value.filter((name) =>
        ['qlik_plan_sheet', 'qlik_preview_sheet', 'qlik_apply_sheet', 'qlik_verify_sheet'].includes(
          name,
        ),
      );
    expect(sheetTools(availableTools(ready))).toEqual([]);
    expect(sheetTools(availableTools(ready, context))).toHaveLength(4);
    expect(sheetTools(availableTools(ready, { ...context, actor: 'unapproved' }))).toEqual([]);
    expect(sheetTools(availableTools(ready, { ...context, appId: 'other-app' }))).toEqual([]);
    expect(sheetTools(availableTools(ready, { ...context, chartTypes: ['kpi'] }))).toEqual([]);
    const unsupported = new FixtureAdapter();
    unsupported.canCreateSheetsInApp = () => false;
    expect(sheetTools(availableTools(ready, { ...context, adapter: unsupported }))).toEqual([]);
    const missingVerification = new FixtureAdapter();
    Object.defineProperty(missingVerification, 'verifySheet', { value: undefined });
    expect(sheetTools(availableTools(ready, { ...context, adapter: missingVerification }))).toEqual(
      [],
    );
    const read = availableTools(capabilities({ configured: true, canRead: true }), context);
    expect(sheetTools(read)).toEqual(['qlik_plan_sheet', 'qlik_verify_sheet']);
    const preview = availableTools(
      capabilities({ configured: true, canRead: true, canPreview: true }),
      context,
    );
    expect(sheetTools(preview)).toEqual([
      'qlik_plan_sheet',
      'qlik_preview_sheet',
      'qlik_verify_sheet',
    ]);
    expect(availableTools({ ...ready, cleanupVerified: false }, context)).not.toContain(
      'qlik_apply_sheet',
    );
    const production = { ...connection, environment: 'production', sheetGeneration: grant };
    const productionPolicy = new PolicyEngine({
      ...config,
      connections: { 'cloud-dev': production },
    });
    expect(sheetTools(availableTools(ready, { ...context, policy: productionPolicy }))).toEqual([]);
  });
});
