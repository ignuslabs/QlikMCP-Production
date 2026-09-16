import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadManagementPolicy, managementPolicySchema } from '../../../src/management/policy.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The deployment helper is executable JavaScript and intentionally outside src/.
// @ts-expect-error No declaration file is shipped for this command-line helper.
const deploymentModule = await import('../../../scripts/agentcore/render-config.mjs');
const { renderAgentCoreConfig } = deploymentModule as {
  renderAgentCoreConfig(input: Record<string, unknown>): unknown;
};

type DeploymentInput = Record<string, unknown> & {
  oidc: Record<string, unknown>;
  governance: Record<string, unknown>;
  qlikCloud: Record<string, unknown>;
};

function deploymentInput(): DeploymentInput {
  return JSON.parse(
    readFileSync(path.join(projectRoot, 'config/agentcore-deployment.example.json'), 'utf8'),
  ) as DeploymentInput;
}

function operatorPolicy(input: DeploymentInput, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    enabled: true,
    environment: 'development',
    grants: [
      {
        actor: (input.governance.mutationActors as string[])[0],
        clientId: (input.oidc.allowedClients as string[])[0],
        connection: input.qlikCloud.connectionAlias,
        actions: [
          'app.create',
          'app.get',
          'datafile.upload',
          'script.apply',
          'reload.wait',
          'chart.create',
          'artifact.read',
        ],
        spaceIds: ['sandbox-space'],
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      },
    ],
    reviewers: [
      {
        actor: (input.governance.reviewerActors as string[])[0],
        clientId: (input.oidc.allowedClients as string[])[0],
      },
    ],
    ...overrides,
  };
}

function renderedEnvironment(input: DeploymentInput) {
  const rendered = renderAgentCoreConfig(input) as {
    runtimes: Array<{ envVars: Array<{ name: string; value: string }> }>;
  };
  return Object.fromEntries(
    rendered.runtimes[0]!.envVars.map((entry) => [entry.name, entry.value]),
  );
}

describe('AgentCore deployment config renderer', () => {
  it('keeps legacy deployments unchanged when managementPolicy is absent', () => {
    expect(renderedEnvironment(deploymentInput())).not.toHaveProperty(
      'QLIK_MANAGEMENT_POLICY_JSON',
    );
  });

  it('renders the shared runtime policy with normalized defaults and exact operator grants', () => {
    const input = deploymentInput();
    const managementPolicy = operatorPolicy(input);
    const environment = renderedEnvironment({ ...input, managementPolicy });
    const roundTrip = loadManagementPolicy({
      QLIK_MANAGEMENT_POLICY_JSON: environment.QLIK_MANAGEMENT_POLICY_JSON,
    });
    expect(roundTrip).toEqual(managementPolicySchema.parse(managementPolicy));
    expect(roundTrip.grants[0]).toMatchObject({
      appIds: [],
      spaceIds: ['sandbox-space'],
      requireApproval: true,
      allowPersonalSpace: false,
    });
    expect(roundTrip.maxUploadBytes).toBe(50 * 1024 * 1024);
    expect(roundTrip.maxArtifactBytes).toBe(200 * 1024 * 1024);
    expect(environment).not.toHaveProperty('QLIK_CLOUD_SHEET_CREATION_APP_IDS');
  });

  it('renders no reviewer identity only for an enabled policy that explicitly waives every approval', () => {
    const input = deploymentInput();
    const policy = operatorPolicy(input, { reviewers: [] });
    input.governance.reviewerActors = [];
    const environment = renderedEnvironment({
      ...input,
      managementPolicy: {
        ...policy,
        grants: [{ ...policy.grants[0], requireApproval: false }],
      },
    });
    expect(environment.QLIK_HARNESS_REVIEWER_ACTORS).toBe('');
    expect(environment.QLIK_HARNESS_MUTATION_ACTORS).toBe(
      (input.governance.mutationActors as string[]).join(','),
    );
    expect(environment.QLIK_AGENTCORE_JWT_ALLOWED_CLIENT_IDS).toBe(
      (input.oidc.allowedClients as string[]).join(','),
    );
    expect(loadManagementPolicy(environment)).toMatchObject({
      enabled: true,
      reviewers: [],
      grants: [{ requireApproval: false, spaceIds: ['sandbox-space'] }],
    });
  });

  it('preserves the reviewer requirement for legacy and disabled management deployments', () => {
    const input = deploymentInput();
    const policy = operatorPolicy(input, { enabled: false, reviewers: [] });
    input.governance.reviewerActors = [];
    expect(() => renderAgentCoreConfig(input)).toThrow('reviewerActors must be non-empty');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: {
          ...policy,
          grants: [{ ...policy.grants[0], requireApproval: false }],
        },
      }),
    ).toThrow('reviewerActors must be non-empty');
  });

  it.each([true, undefined])(
    'does not waive approval when any grant has requireApproval=%s, including read-only grants',
    (requireApproval) => {
      const input = deploymentInput();
      const policy = operatorPolicy(input, { reviewers: [] });
      input.governance.reviewerActors = [];
      expect(() =>
        renderAgentCoreConfig({
          ...input,
          managementPolicy: {
            ...policy,
            grants: [
              { ...policy.grants[0], requireApproval: false },
              { ...policy.grants[0], actions: ['data.profile'], requireApproval },
            ],
          },
        }),
      ).toThrow('reviewerActors must be non-empty');
    },
  );

  it('rejects approval-required writes and unmatched policy reviewers with an empty governance reviewer list', () => {
    const input = deploymentInput();
    const policy = operatorPolicy(input);
    input.governance.reviewerActors = [];
    expect(() =>
      renderAgentCoreConfig({ ...input, managementPolicy: { ...policy, reviewers: [] } }),
    ).toThrow('separately allowlisted reviewer');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: {
          ...policy,
          grants: [{ ...policy.grants[0], requireApproval: false }],
        },
      }),
    ).toThrow('reviewer actor and clientId');
  });

  it.each([undefined, null, '', [''], ['reviewer,other']])(
    'does not treat malformed governance reviewer input %j as an explicit empty list',
    (reviewerActors) => {
      const input = deploymentInput();
      const policy = operatorPolicy(input, { reviewers: [] });
      input.governance.reviewerActors = reviewerActors;
      expect(() =>
        renderAgentCoreConfig({
          ...input,
          managementPolicy: {
            ...policy,
            grants: [{ ...policy.grants[0], requireApproval: false }],
          },
        }),
      ).toThrow('governance.reviewerActors');
    },
  );

  it('still validates scope, expiry, and non-overlap for a policy that waives approval', () => {
    const input = deploymentInput();
    const policy = operatorPolicy(input, { reviewers: [] });
    input.governance.reviewerActors = [];
    for (const [overrides, message] of [
      [{ spaceIds: [] }, 'require exact appIds'],
      [{ expiresAt: '1970-01-01T00:00:00.000Z' }, 'future expiresAt'],
    ] as const)
      expect(() =>
        renderAgentCoreConfig({
          ...input,
          managementPolicy: {
            ...policy,
            grants: [{ ...policy.grants[0], requireApproval: false, ...overrides }],
          },
        }),
      ).toThrow(message);
    input.governance.reviewerActors = input.governance.mutationActors;
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: { ...policy, grants: [{ ...policy.grants[0], requireApproval: false }] },
      }),
    ).toThrow('must not overlap');
  });

  it('permits production management without a legacy sheet-generation grant', () => {
    const input = deploymentInput();
    input.qlikCloud.environment = 'production';
    const managementPolicy = operatorPolicy(input, {
      environment: 'production',
      allowProduction: true,
    });
    const environment = renderedEnvironment({ ...input, managementPolicy });
    expect(JSON.parse(environment.QLIK_MANAGEMENT_POLICY_JSON!)).toMatchObject({
      enabled: true,
      environment: 'production',
      allowProduction: true,
    });
    const legacy = JSON.parse(environment.QLIK_HARNESS_CONNECTIONS_JSON!);
    expect(legacy.connections[0]).not.toHaveProperty('sheetGeneration');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: { ...managementPolicy, enabled: false },
      }),
    ).toThrow('explicit sheetGeneration grant');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: { ...managementPolicy, allowProduction: false },
      }),
    ).toThrow('allowProduction=true');
  });

  it('maps nonproduction to the runtime test environment and rejects mismatched enabled policies', () => {
    const input = deploymentInput();
    input.qlikCloud.environment = 'nonproduction';
    expect(() =>
      renderAgentCoreConfig({ ...input, managementPolicy: operatorPolicy(input) }),
    ).toThrow('must match qlikCloud.environment');
    expect(
      JSON.parse(
        renderedEnvironment({
          ...input,
          managementPolicy: operatorPolicy(input, { environment: 'test' }),
        }).QLIK_MANAGEMENT_POLICY_JSON!,
      ),
    ).toMatchObject({ environment: 'test' });
  });

  it.each([
    ['actor', 'unapproved-actor'],
    ['clientId', 'unapproved-client'],
    ['connection', 'different-connection'],
  ])('rejects management grants whose %s differs from the deployment boundary', (field, value) => {
    const input = deploymentInput();
    const policy = operatorPolicy(input);
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: { ...policy, grants: [{ ...policy.grants[0], [field]: value }] },
      }),
    ).toThrow('must exactly match');
  });

  it('requires allowlisted separate reviewers for approval-required writes', () => {
    const input = deploymentInput();
    const policy = operatorPolicy(input);
    expect(() =>
      renderAgentCoreConfig({ ...input, managementPolicy: { ...policy, reviewers: [] } }),
    ).toThrow('separately allowlisted reviewer');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: {
          ...policy,
          reviewers: [{ ...policy.reviewers[0], actor: policy.grants[0]?.actor }],
        },
      }),
    ).toThrow('reviewer actor and clientId');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: {
          ...policy,
          reviewers: [{ ...policy.reviewers[0], clientId: 'different-client' }],
        },
      }),
    ).toThrow('reviewer actor and clientId');
    const explicitNoApproval = {
      ...policy,
      reviewers: [],
      grants: [{ ...policy.grants[0], requireApproval: false }],
    };
    expect(
      JSON.parse(
        renderedEnvironment({ ...input, managementPolicy: explicitNoApproval })
          .QLIK_MANAGEMENT_POLICY_JSON!,
      ).grants[0].requireApproval,
    ).toBe(false);
  });

  it('rejects expired enabled grants, unknown actions, duplicate grants and unknown policy fields', () => {
    const input = deploymentInput();
    const policy = operatorPolicy(input);
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: {
          ...policy,
          grants: [{ ...policy.grants[0], expiresAt: '1970-01-01T00:00:00.000Z' }],
        },
      }),
    ).toThrow('future expiresAt');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: { ...policy, grants: [{ ...policy.grants[0], actions: ['app.cretae'] }] },
      }),
    ).toThrow('unknown management action');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: { ...policy, grants: [policy.grants[0], policy.grants[0]] },
      }),
    ).toThrow('overlapping operator grants');
    expect(() =>
      renderAgentCoreConfig({ ...input, managementPolicy: { ...policy, wildcard: true } }),
    ).toThrow('runtime schema');
  });

  it('rejects unscoped resource actions, wildcard targets and impossible destination grants', () => {
    const input = deploymentInput();
    const policy = operatorPolicy(input);
    const grant = policy.grants[0];
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: { ...policy, grants: [{ ...grant, spaceIds: [], actions: ['app.get'] }] },
      }),
    ).toThrow('require exact appIds');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: { ...policy, grants: [{ ...grant, spaceIds: ['space-*'] }] },
      }),
    ).toThrow('without wildcard');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: {
          ...policy,
          grants: [{ ...grant, spaceIds: [], appIds: ['fixed-app'], actions: ['app.create'] }],
        },
      }),
    ).toThrow('creation and destination actions');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: {
          ...policy,
          grants: [{ ...grant, spaceIds: [], allowPersonalSpace: true, actions: ['app.publish'] }],
        },
      }),
    ).toThrow('require exact spaceIds');
  });

  it('uses the runtime schema upload/export limits and permits an explicitly disabled expired policy', () => {
    const input = deploymentInput();
    const policy = operatorPolicy(input);
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: { ...policy, maxUploadBytes: 51 * 1024 * 1024 },
      }),
    ).toThrow('runtime schema');
    expect(() =>
      renderAgentCoreConfig({
        ...input,
        managementPolicy: { ...policy, maxArtifactBytes: 201 * 1024 * 1024 },
      }),
    ).toThrow('runtime schema');
    expect(
      JSON.parse(
        renderedEnvironment({
          ...input,
          managementPolicy: {
            ...policy,
            enabled: false,
            grants: [{ ...policy.grants[0], expiresAt: '1970-01-01T00:00:00.000Z' }],
          },
        }).QLIK_MANAGEMENT_POLICY_JSON!,
      ).enabled,
    ).toBe(false);
  });

  it('renders a valid MCP runtime boundary without embedding secret material', () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'qlik-agentcore-config-'));
    try {
      const configPath = path.join(temporary, 'agentcore.json');
      const targetsPath = path.join(temporary, 'aws-targets.json');
      writeFileSync(configPath, '{}\n', { mode: 0o644 });
      writeFileSync(targetsPath, '[]\n', { mode: 0o644 });
      chmodSync(configPath, 0o644);
      chmodSync(targetsPath, 0o644);
      const result = spawnSync(
        process.execPath,
        [
          'scripts/agentcore/render-config.mjs',
          '--input',
          'config/agentcore-deployment.example.json',
          '--output',
          configPath,
          '--targets-output',
          targetsPath,
        ],
        { cwd: projectRoot, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        runtimes: Array<{
          protocol: string;
          runtimeVersion: string;
          requestHeaderAllowlist: string[];
          authorizerType: string;
          envVars: Array<{ name: string; value: string }>;
        }>;
      };
      const runtime = config.runtimes[0];
      expect(runtime).toMatchObject({
        protocol: 'MCP',
        runtimeVersion: 'NODE_22',
        authorizerType: 'CUSTOM_JWT',
        requestHeaderAllowlist: [
          'Authorization',
          'X-Correlation-Id',
          'Mcp-Protocol-Version',
          'Mcp-Method',
          'Mcp-Name',
        ],
      });
      const environment = Object.fromEntries(
        runtime?.envVars.map((entry) => [entry.name, entry.value]) ?? [],
      );
      expect(environment).toMatchObject({
        QLIK_HARNESS_TARGET_MODE: 'cloud',
        QLIK_AGENTCORE_STATE_TABLE: 'qlik-ai-harness-agentcore-dev',
        QLIK_AGENTCORE_QLIK_SECRET_ID: '/qlik-ai-harness/agentcore/dev/qlik-cloud-oauth',
      });
      expect(Object.keys(environment)).not.toContain('QLIK_CLOUD_OAUTH_CLIENT_SECRET');
      expect(JSON.stringify(config)).not.toContain('provider-secret-value');
      expect(JSON.parse(readFileSync(targetsPath, 'utf8'))).toEqual([
        { name: 'dev', account: '123456789012', region: 'us-east-1' },
      ]);
      if (process.platform !== 'win32') {
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
        expect(statSync(targetsPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('requires an explicit bounded production sheet grant and retains it in runtime policy', () => {
    const valid = deploymentInput();
    const production = { ...valid, qlikCloud: { ...valid.qlikCloud, environment: 'production' } };
    expect(() => renderAgentCoreConfig(production)).toThrow('explicit sheetGeneration grant');
    const grant = {
      actors: valid.governance.mutationActors,
      appIds: [valid.qlikCloud.appId],
      chartTypes: ['bar', 'kpi'],
      maxCharts: 4,
      allowProduction: true,
    };
    const rendered = renderAgentCoreConfig({
      ...production,
      qlikCloud: {
        ...production.qlikCloud,
        sheetGeneration: grant,
      },
    }) as { runtimes: Array<{ envVars: Array<{ name: string; value: string }> }> };
    const policy = rendered.runtimes[0]?.envVars.find(
      (entry) => entry.name === 'QLIK_HARNESS_CONNECTIONS_JSON',
    );
    expect(JSON.parse(policy!.value)).toMatchObject({
      allowedEnvironments: ['production'],
      connections: [{ productionUse: true, sheetGeneration: grant }],
    });
    expect(() =>
      renderAgentCoreConfig({
        ...production,
        qlikCloud: {
          ...production.qlikCloud,
          sheetGeneration: { ...grant, appIds: ['unapproved-app'] },
        },
      }),
    ).toThrow('configured app');
  });

  it('rejects non-origin tenant hosts and ambiguous OIDC discovery URLs', () => {
    const valid = deploymentInput();
    expect(() =>
      renderAgentCoreConfig({
        ...valid,
        qlikCloud: { ...valid.qlikCloud, tenantHost: 'https://tenant.example/path?mode=x#y' },
      }),
    ).toThrow('qlikCloud.tenantHost');
    expect(() =>
      renderAgentCoreConfig({
        ...valid,
        oidc: {
          ...valid.oidc,
          discoveryUrl:
            'https://identity.example.com/.well-known/openid-configuration?tenant=other',
        },
      }),
    ).toThrow('oidc.discoveryUrl');
  });

  it('rejects CSV delimiter expansion and multiple edge invocation scopes', () => {
    const valid = deploymentInput();
    expect(() =>
      renderAgentCoreConfig({
        ...valid,
        governance: {
          mutationActors: ['alice,bob'],
          reviewerActors: ['bob'],
        },
      }),
    ).toThrow('commas or control characters');
    expect(() =>
      renderAgentCoreConfig({
        ...valid,
        oidc: { ...valid.oidc, allowedClients: ['client-a\nclient-b'] },
      }),
    ).toThrow('commas or control characters');
    expect(() =>
      renderAgentCoreConfig({
        ...valid,
        oidc: { ...valid.oidc, allowedScopes: ['qlik.invoke', 'qlik.admin'] },
      }),
    ).toThrow('exactly one Runtime invocation scope');
  });
});
