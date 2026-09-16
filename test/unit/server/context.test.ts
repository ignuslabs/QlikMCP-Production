import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDefaultOperationService } from '../../../src/server/context.js';

function readiness(prefix: 'QLIK_CLOUD' | 'QLIK_WINDOWS'): void {
  vi.stubEnv(`${prefix}_READINESS_APPROVED`, 'true');
  vi.stubEnv(`${prefix}_READINESS_EXPIRES_AT`, '2099-01-01T00:00:00.000Z');
  vi.stubEnv(`${prefix}_READINESS_CAN_READ`, 'true');
  vi.stubEnv(`${prefix}_READINESS_CAN_PREVIEW`, 'true');
  vi.stubEnv(`${prefix}_READINESS_CAN_WRITE_DESIGNATED_SHEET`, 'true');
  vi.stubEnv(`${prefix}_READINESS_CLEANUP_VERIFIED`, 'true');
}

afterEach(() => vi.unstubAllEnvs());

describe('default provider runtime wiring', () => {
  it('wires Cloud readiness without resolving the OAuth secret during construction or probing', async () => {
    vi.stubEnv('QLIK_HARNESS_TARGET_MODE', 'cloud');
    vi.stubEnv('QLIK_CLOUD_CONNECTION_ALIAS', 'cloud-dev');
    vi.stubEnv('QLIK_CLOUD_TENANT_HOST', 'https://tenant.example.qlikcloud.com');
    vi.stubEnv('QLIK_CLOUD_OAUTH_CLIENT_ID', 'public-client-id');
    vi.stubEnv('QLIK_CLOUD_WRITE_APP_ID', 'app-sales-cloud-dev');
    vi.stubEnv('QLIK_CLOUD_WRITE_SHEET_ID', 'sheet-sales-overview-cloud-dev');
    vi.stubEnv('QLIK_CLOUD_OAUTH_CLIENT_SECRET', '');
    readiness('QLIK_CLOUD');

    const result = await buildDefaultOperationService().getReadiness();
    expect(result.adapters.find((adapter) => adapter.connection === 'cloud-dev')).toMatchObject({
      platform: 'cloud',
      configured: true,
      canRead: true,
      canPreview: true,
      canWriteDesignatedSheet: true,
    });
  });

  it('wires Windows readiness while leaving credentials lazy until a QIX call', async () => {
    vi.stubEnv('QLIK_HARNESS_TARGET_MODE', 'windows');
    vi.stubEnv('QLIK_WINDOWS_CONNECTION_ALIAS', 'windows-dev');
    vi.stubEnv('QLIK_WINDOWS_SERVER_ALIAS', 'windows.example.test');
    vi.stubEnv('QLIK_WINDOWS_AUTH_MODE', 'proxy-session');
    vi.stubEnv('QLIK_WINDOWS_VIRTUAL_PROXY_ALIAS', 'jwt');
    vi.stubEnv('QLIK_WINDOWS_DISCOVERY_APP_ID', 'app-sales-windows-dev');
    vi.stubEnv('QLIK_WINDOWS_WRITE_APP_ID', 'app-sales-windows-dev');
    vi.stubEnv('QLIK_WINDOWS_WRITE_SHEET_ID', 'sheet-sales-overview-windows-dev');
    vi.stubEnv('QLIK_WINDOWS_PROXY_SESSION_JWT', '');
    readiness('QLIK_WINDOWS');

    const result = await buildDefaultOperationService().getReadiness();
    expect(result.adapters.find((adapter) => adapter.connection === 'windows-dev')).toMatchObject({
      platform: 'windows',
      configured: true,
      canRead: true,
      canPreview: true,
      canWriteDesignatedSheet: true,
    });
  });

  it('rejects an unknown target mode instead of silently selecting a fixture', () => {
    vi.stubEnv('QLIK_HARNESS_TARGET_MODE', 'production');
    expect(() => buildDefaultOperationService()).toThrow(
      'QLIK_HARNESS_TARGET_MODE must be fixture, cloud, or windows.',
    );
  });
});
