import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPolicyConfig } from '../../../src/config/policyConfig.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadPolicyConfig deployment policy', () => {
  it('loads an exact non-secret deployment mutation allowlist from the environment', () => {
    vi.stubEnv('QLIK_HARNESS_MUTATION_ACTORS', 'requester');
    vi.stubEnv('QLIK_HARNESS_REVIEWER_ACTORS', 'reviewer');
    vi.stubEnv(
      'QLIK_HARNESS_CONNECTIONS_JSON',
      JSON.stringify({
        allowedEnvironments: ['development'],
        connections: [
          {
            alias: 'tenant-cloud-dev',
            platform: 'qlik-cloud',
            visualizationSchemaProfile: 'qlik-cloud-current',
            environment: 'development',
            productionUse: false,
            allowedApps: { 'real-app-id': ['real-sheet-id'] },
            allowedChartTypes: ['table'],
          },
        ],
      }),
    );

    const policy = loadPolicyConfig();

    expect(policy.connections['tenant-cloud-dev']).toEqual({
      alias: 'tenant-cloud-dev',
      platform: 'cloud',
      visualizationSchemaProfile: 'qlik-cloud-current',
      environment: 'development',
      allowedApps: { 'real-app-id': ['real-sheet-id'] },
      allowedChartTypes: ['table'],
    });
    expect(policy.mutationActors).toEqual(new Set(['requester']));
    expect(policy.reviewerActors).toEqual(new Set(['reviewer']));
  });

  it('rejects malformed and unsupported inline policy values', () => {
    vi.stubEnv('QLIK_HARNESS_CONNECTIONS_JSON', '{"connections":"not-an-array"}');
    expect(() => loadPolicyConfig()).toThrow('connections array');

    vi.stubEnv(
      'QLIK_HARNESS_CONNECTIONS_JSON',
      JSON.stringify({
        connections: [
          {
            alias: 'prod',
            platform: 'qlik-cloud',
            visualizationSchemaProfile: 'qlik-cloud-current',
            environment: 'development',
            productionUse: false,
            allowedApps: {},
            allowedChartTypes: ['made-up-chart'],
          },
        ],
      }),
    );
    expect(() => loadPolicyConfig()).toThrow('unsupported chart type');
  });

  it('rejects a deployment policy marked for production use', () => {
    vi.stubEnv(
      'QLIK_HARNESS_CONNECTIONS_JSON',
      JSON.stringify({
        connections: [
          {
            alias: 'prod',
            platform: 'qlik-cloud',
            visualizationSchemaProfile: 'qlik-cloud-current',
            environment: 'production',
            productionUse: true,
            allowedApps: {},
            allowedChartTypes: ['table'],
          },
        ],
      }),
    );

    expect(() => loadPolicyConfig()).toThrow('production use is prohibited');
  });

  it.each(['prod', 'Prod', 'production', 'Production', 'PRODUCTION', 'pRoDuCtIoN'])(
    'rejects inline deployment environment classification %s',
    (environment) => {
      vi.stubEnv(
        'QLIK_HARNESS_CONNECTIONS_JSON',
        JSON.stringify({
          allowedEnvironments: [environment],
          connections: [
            {
              alias: 'unsafe-environment',
              platform: 'qlik-cloud',
              visualizationSchemaProfile: 'qlik-cloud-current',
              environment,
              productionUse: false,
              allowedApps: {},
              allowedChartTypes: ['table'],
            },
          ],
        }),
      );

      expect(() => loadPolicyConfig()).toThrow(
        /production use is prohibited|development or nonproduction/,
      );
    },
  );

  it('rejects an unsafe inline allowed-environment entry even when the connection is development', () => {
    vi.stubEnv(
      'QLIK_HARNESS_CONNECTIONS_JSON',
      JSON.stringify({
        allowedEnvironments: ['development', 'prod'],
        connections: [
          {
            alias: 'tenant-cloud-dev',
            platform: 'qlik-cloud',
            visualizationSchemaProfile: 'qlik-cloud-current',
            environment: 'development',
            productionUse: false,
            allowedApps: {},
            allowedChartTypes: ['table'],
          },
        ],
      }),
    );

    expect(() => loadPolicyConfig()).toThrow('development or nonproduction');
  });

  it('accepts nonproduction as the second explicit inline deployment classification', () => {
    vi.stubEnv(
      'QLIK_HARNESS_CONNECTIONS_JSON',
      JSON.stringify({
        allowedEnvironments: ['nonproduction'],
        connections: [
          {
            alias: 'tenant-cloud-nonprod',
            platform: 'qlik-cloud',
            visualizationSchemaProfile: 'qlik-cloud-current',
            environment: 'nonproduction',
            productionUse: false,
            allowedApps: {},
            allowedChartTypes: ['table'],
          },
        ],
      }),
    );

    expect(loadPolicyConfig().allowedEnvironments).toEqual(['nonproduction']);
  });

  it('loads a modern Windows profile only with a host-validated sn-table version', () => {
    vi.stubEnv(
      'QLIK_HARNESS_CONNECTIONS_JSON',
      JSON.stringify({
        connections: [
          {
            alias: 'windows-modern-dev',
            platform: 'qlik-sense-enterprise-on-windows',
            visualizationSchemaProfile: 'qlik-windows-november-2025-or-later',
            visualizationSchemaVersion: '6.44.0',
            environment: 'development',
          },
        ],
      }),
    );

    expect(loadPolicyConfig().connections['windows-modern-dev']).toMatchObject({
      platform: 'windows',
      visualizationSchemaProfile: 'qlik-windows-november-2025-or-later',
      visualizationSchemaVersion: '6.44.0',
    });
  });

  it.each([
    {
      name: 'missing profile',
      platform: 'qlik-cloud',
      expected: 'visualizationSchemaProfile',
    },
    {
      name: 'platform mismatch',
      platform: 'qlik-cloud',
      visualizationSchemaProfile: 'qlik-windows-pre-november-2025',
      expected: 'does not match platform',
    },
    {
      name: 'missing modern Windows host version',
      platform: 'qlik-sense-enterprise-on-windows',
      visualizationSchemaProfile: 'qlik-windows-november-2025-or-later',
      expected: 'host-validated semantic visualizationSchemaVersion',
    },
    {
      name: 'non-semantic modern Windows host version',
      platform: 'qlik-sense-enterprise-on-windows',
      visualizationSchemaProfile: 'qlik-windows-november-2025-or-later',
      visualizationSchemaVersion: 'current',
      expected: 'host-validated semantic visualizationSchemaVersion',
    },
    {
      name: 'modern Windows host version with leading zeroes',
      platform: 'qlik-sense-enterprise-on-windows',
      visualizationSchemaProfile: 'qlik-windows-november-2025-or-later',
      visualizationSchemaVersion: '01.2.3',
      expected: 'host-validated semantic visualizationSchemaVersion',
    },
    {
      name: 'modern Windows host version with an empty prerelease identifier',
      platform: 'qlik-sense-enterprise-on-windows',
      visualizationSchemaProfile: 'qlik-windows-november-2025-or-later',
      visualizationSchemaVersion: '1.2.3-alpha..1',
      expected: 'host-validated semantic visualizationSchemaVersion',
    },
  ])('rejects a $name configuration', (testCase) => {
    vi.stubEnv(
      'QLIK_HARNESS_CONNECTIONS_JSON',
      JSON.stringify({
        connections: [
          {
            alias: 'invalid-profile-dev',
            platform: testCase.platform,
            ...(testCase.visualizationSchemaProfile
              ? { visualizationSchemaProfile: testCase.visualizationSchemaProfile }
              : {}),
            ...(testCase.visualizationSchemaVersion
              ? { visualizationSchemaVersion: testCase.visualizationSchemaVersion }
              : {}),
            environment: 'development',
          },
        ],
      }),
    );

    expect(() => loadPolicyConfig()).toThrow(testCase.expected);
  });
});
