import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAgentCoreQlikSecretProvider } from '../../../src/agentcore/secrets.js';

const secrets = mockClient(SecretsManagerClient);

beforeEach(() => secrets.reset());

describe('AgentCore Qlik secret provider', () => {
  it('loads a connection-bound JSON secret from Secrets Manager and caches it', async () => {
    secrets.resolves({
      SecretString: JSON.stringify({
        connectionAlias: 'cloud-dev',
        clientSecret: 'provider-secret-value',
      }),
    });
    const provider = createAgentCoreQlikSecretProvider({
      secretId: '/qlik-ai-harness/agentcore/dev/qlik-cloud-oauth',
      connectionAlias: 'cloud-dev',
      cacheTtlMs: 60_000,
      now: () => 1_000,
    });
    await expect(provider('cloud-dev')).resolves.toBe('provider-secret-value');
    await expect(provider('cloud-dev')).resolves.toBe('provider-secret-value');
    expect(secrets.calls()).toHaveLength(1);
  });

  it('coalesces parallel reads, refreshes expired values, and recovers after a failed refresh', async () => {
    let now = 1_000;
    secrets
      .resolvesOnce({ SecretString: JSON.stringify({ clientSecret: 'first' }) })
      .rejectsOnce(new Error('temporary provider failure'))
      .resolves({ SecretString: JSON.stringify({ clientSecret: 'rotated' }) });
    const provider = createAgentCoreQlikSecretProvider({
      secretId: 'secret-id',
      connectionAlias: 'cloud-dev',
      cacheTtlMs: 100,
      now: () => now,
    });
    await expect(
      Promise.all(Array.from({ length: 12 }, () => provider('cloud-dev'))),
    ).resolves.toEqual(Array.from({ length: 12 }, () => 'first'));
    expect(secrets.calls()).toHaveLength(1);
    now += 101;
    await expect(provider('cloud-dev')).rejects.toThrow('temporary provider failure');
    await expect(provider('cloud-dev')).resolves.toBe('rotated');
    expect(secrets.calls()).toHaveLength(3);
  });

  it('rejects alias mismatches and malformed secret documents', async () => {
    const provider = createAgentCoreQlikSecretProvider({
      secretId: 'secret-id',
      connectionAlias: 'cloud-dev',
    });
    await expect(provider('other')).rejects.toThrow('requested connection alias');
    expect(secrets.calls()).toHaveLength(0);

    secrets.resolves({ SecretString: JSON.stringify({ connectionAlias: 'cloud-dev' }) });
    await expect(provider('cloud-dev')).rejects.toThrow('clientSecret');
  });
});
