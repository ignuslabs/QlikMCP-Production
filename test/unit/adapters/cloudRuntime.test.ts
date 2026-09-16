import type { HostConfig } from '@qlik/api/auth';
import { describe, expect, it, vi } from 'vitest';
import {
  createCloudRuntimeAdapter,
  type CloudRuntimeEnvironment,
} from '../../../src/adapters/cloud/cloudRuntime.js';
import type {
  CloudAppPage,
  CloudQlikClient,
  CloudSdkAppSession,
} from '../../../src/adapters/cloud/qlikApiCloudClient.js';
import { MUTATOR_ACTOR } from '../../helpers/testContext.js';

const completeEnvironment: CloudRuntimeEnvironment = {
  QLIK_CLOUD_CONNECTION_ALIAS: 'cloud-dev',
  QLIK_CLOUD_TENANT_HOST: 'https://tenant.example.qlikcloud.com',
  QLIK_CLOUD_TENANT_ALIAS: 'development-tenant',
  QLIK_CLOUD_REGION_ALIAS: 'us-east',
  QLIK_CLOUD_OAUTH_CLIENT_ID: 'public-client-id',
  QLIK_CLOUD_ENVIRONMENT: 'development',
  QLIK_CLOUD_WRITE_APP_ID: 'app-dev',
  QLIK_CLOUD_WRITE_SHEET_ID: 'sheet-dev',
  QLIK_CLOUD_READINESS_APPROVED: 'true',
  QLIK_CLOUD_READINESS_EXPIRES_AT: '2099-01-01T00:00:00.000Z',
  QLIK_CLOUD_READINESS_CAN_READ: 'true',
  QLIK_CLOUD_READINESS_CAN_PREVIEW: 'true',
  QLIK_CLOUD_READINESS_CAN_WRITE_DESIGNATED_SHEET: 'true',
  QLIK_CLOUD_READINESS_CLEANUP_VERIFIED: 'true',
};

class CapturingCloudClient implements CloudQlikClient {
  hostConfig?: HostConfig;

  async listApps(hostConfig: HostConfig): Promise<CloudAppPage> {
    this.hostConfig = hostConfig;
    return { apps: [{ appId: 'app-dev', name: 'Development app' }] };
  }

  async openAppSession(): Promise<CloudSdkAppSession> {
    throw new Error('Not used by this runtime-construction test.');
  }
}

describe('Cloud runtime factory', () => {
  it('returns undefined for missing or unsafe core routing values without resolving a secret', () => {
    const clientSecrets = vi.fn(async () => 'runtime-secret');

    expect(
      createCloudRuntimeAdapter(
        { ...completeEnvironment, QLIK_CLOUD_TENANT_HOST: undefined },
        { clientSecrets },
      ),
    ).toBeUndefined();
    expect(
      createCloudRuntimeAdapter(
        { ...completeEnvironment, QLIK_CLOUD_TENANT_HOST: 'http://tenant.invalid/path' },
        { clientSecrets },
      ),
    ).toBeUndefined();
    expect(clientSecrets).not.toHaveBeenCalled();
  });

  it('constructs OAuth/QIX dependencies and resolves the secret for the Node SDK host config', async () => {
    const qlik = new CapturingCloudClient();
    const clientSecrets = vi.fn(async () => 'runtime-secret');
    const adapter = createCloudRuntimeAdapter(completeEnvironment, {
      clientSecrets,
      qlik,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(adapter).toBeDefined();
    expect(clientSecrets).not.toHaveBeenCalled();
    await expect(adapter?.getEnvironmentCapabilities('cloud-dev')).resolves.toMatchObject({
      configured: true,
      canRead: true,
      canPreview: true,
      canWriteDesignatedSheet: true,
      cleanupVerified: true,
    });
    await expect(adapter?.listAccessibleApps('cloud-dev', MUTATOR_ACTOR)).resolves.toMatchObject({
      apps: [{ appId: 'app-dev', name: 'Development app' }],
    });
    expect(clientSecrets).toHaveBeenCalledOnce();
    expect(qlik.hostConfig).toMatchObject({
      host: 'https://tenant.example.qlikcloud.com',
      authType: 'oauth2',
      clientId: 'public-client-id',
      clientSecret: 'runtime-secret',
    });
    expect('getAccessToken' in (qlik.hostConfig ?? {})).toBe(false);
  });

  it('keeps readiness and writes fail-closed when evidence or target fields are incomplete', async () => {
    const qlik = new CapturingCloudClient();
    const incompleteEvidence = createCloudRuntimeAdapter(
      { ...completeEnvironment, QLIK_CLOUD_READINESS_CLEANUP_VERIFIED: undefined },
      { clientSecrets: async () => 'secret', qlik },
    );
    await expect(
      incompleteEvidence?.getEnvironmentCapabilities('cloud-dev'),
    ).resolves.toMatchObject({ configured: false, canRead: false });

    const incompleteTarget = createCloudRuntimeAdapter(
      { ...completeEnvironment, QLIK_CLOUD_WRITE_SHEET_ID: undefined },
      { clientSecrets: async () => 'secret', qlik },
    );
    await expect(incompleteTarget?.getEnvironmentCapabilities('cloud-dev')).resolves.toMatchObject({
      configured: true,
      canRead: true,
      canWriteDesignatedSheet: false,
      cleanupVerified: false,
    });
  });
});
