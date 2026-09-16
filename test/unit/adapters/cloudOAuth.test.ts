import { describe, expect, it } from 'vitest';
import {
  CloudOAuthRequestError,
  OAuthHostConfigFactory,
} from '../../../src/adapters/cloud/cloudOAuth.js';

describe('Qlik Cloud OAuth factories', () => {
  it('builds an SDK host config with a lazily resolved client secret', async () => {
    const secretRequests: string[] = [];
    const factory = new OAuthHostConfigFactory({
      connection: 'cloud-dev',
      tenantHost: 'https://tenant.example.qlikcloud.com',
      clientId: 'public-client-id',
      clientSecrets: async (connection) => {
        secretRequests.push(connection);
        return 'runtime-secret';
      },
    });

    expect(secretRequests).toEqual([]);
    const config = await factory.getHostConfig('cloud-dev');
    expect(config).toMatchObject({
      host: 'https://tenant.example.qlikcloud.com',
      authType: 'oauth2',
      clientId: 'public-client-id',
      clientSecret: 'runtime-secret',
    });
    expect('getAccessToken' in config).toBe(false);
    expect(secretRequests).toEqual(['cloud-dev']);
  });

  it('rejects unsafe tenant hosts and unexpected connections without resolving secrets', async () => {
    expect(
      () =>
        new OAuthHostConfigFactory({
          connection: 'cloud-dev',
          tenantHost: 'http://tenant.example.qlikcloud.com/path',
          clientId: 'client',
          clientSecrets: async () => 'secret',
        }),
    ).toThrow('tenantHost must be an HTTPS origin');

    const factory = new OAuthHostConfigFactory({
      connection: 'cloud-dev',
      tenantHost: 'https://tenant.example.qlikcloud.com',
      clientId: 'client',
      clientSecrets: async () => 'secret-value',
    });
    const error = await factory.getHostConfig('other-cloud').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudOAuthRequestError);
    expect(error).toMatchObject({
      status: 403,
      message: 'Qlik Cloud OAuth token acquisition failed.',
    });
    expect(String(error)).not.toContain('secret-value');
  });
});
