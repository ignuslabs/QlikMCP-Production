import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES } from '../../../src/adapters/windows/environmentWindowsSecretProvider.js';
import {
  createWindowsRuntimeAdapter,
  type WindowsRuntimeEnvironment,
} from '../../../src/adapters/windows/windowsRuntime.js';
import type {
  WindowsEngineSession,
  WindowsEngineSessionFactory,
} from '../../../src/adapters/windows/windowsAdapter.js';
import { MUTATOR_ACTOR } from '../../helpers/testContext.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const completeEnvironment: WindowsRuntimeEnvironment = {
  QLIK_WINDOWS_CONNECTION_ALIAS: 'windows-dev',
  QLIK_WINDOWS_SERVER_ALIAS: 'windows.example.test',
  QLIK_WINDOWS_AUTH_MODE: 'proxy-session',
  QLIK_WINDOWS_VIRTUAL_PROXY_ALIAS: 'jwt',
  QLIK_WINDOWS_DISCOVERY_APP_ID: 'app-discovery',
  QLIK_WINDOWS_WRITE_APP_ID: 'app-dev',
  QLIK_WINDOWS_WRITE_SHEET_ID: 'sheet-dev',
  QLIK_WINDOWS_READINESS_APPROVED: 'true',
  QLIK_WINDOWS_READINESS_EXPIRES_AT: '2099-01-01T00:00:00.000Z',
  QLIK_WINDOWS_READINESS_CAN_READ: 'true',
  QLIK_WINDOWS_READINESS_CAN_PREVIEW: 'true',
  QLIK_WINDOWS_READINESS_CAN_WRITE_DESIGNATED_SHEET: 'true',
  QLIK_WINDOWS_READINESS_CLEANUP_VERIFIED: 'true',
};

function jwt(expiresAtSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expiresAtSeconds })).toString('base64url');
  return `${header}.${payload}.runtime-signature`;
}

function sessionFrom(partial: object): WindowsEngineSession {
  return partial as WindowsEngineSession;
}

describe('Windows runtime factory', () => {
  it('returns undefined for missing or unsafe core routing without reading credentials', () => {
    let credentialReads = 0;
    const secretEnvironment = Object.defineProperty(
      {},
      DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.proxyJwt,
      {
        get: () => {
          credentialReads += 1;
          return jwt(Math.floor(NOW.getTime() / 1_000) + 300);
        },
      },
    ) as Readonly<Record<string, string | undefined>>;
    const unsafeEnvironments: readonly WindowsRuntimeEnvironment[] = [
      { ...completeEnvironment, QLIK_WINDOWS_CONNECTION_ALIAS: undefined },
      { ...completeEnvironment, QLIK_WINDOWS_SERVER_ALIAS: 'http://windows.example.test' },
      { ...completeEnvironment, QLIK_WINDOWS_SERVER_ALIAS: 'https://windows.example.test/path' },
      { ...completeEnvironment, QLIK_WINDOWS_AUTH_MODE: 'PROXY-SESSION' },
      { ...completeEnvironment, QLIK_WINDOWS_VIRTUAL_PROXY_ALIAS: undefined },
      {
        ...completeEnvironment,
        QLIK_WINDOWS_AUTH_MODE: 'trusted-backend',
        QLIK_WINDOWS_VIRTUAL_PROXY_ALIAS: 'jwt',
      },
      { ...completeEnvironment, QLIK_WINDOWS_DISCOVERY_APP_ID: 'app\ndiscovery' },
    ];

    for (const environment of unsafeEnvironments) {
      expect(createWindowsRuntimeAdapter(environment, { secretEnvironment })).toBeUndefined();
    }
    expect(credentialReads).toBe(0);
  });

  it('constructs the concrete credential/QIX stack and reads the JWT only on session open', async () => {
    let credentialReads = 0;
    const accessToken = jwt(Math.floor(NOW.getTime() / 1_000) + 300);
    const secretEnvironment = Object.defineProperty(
      {},
      DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.proxyJwt,
      {
        get: () => {
          credentialReads += 1;
          return accessToken;
        },
      },
    ) as Readonly<Record<string, string | undefined>>;
    const opened: Parameters<WindowsEngineSessionFactory['open']>[0][] = [];
    let closes = 0;
    const sessions: WindowsEngineSessionFactory = {
      open: async (options) => {
        opened.push(options);
        return sessionFrom({
          listAccessibleApps: async () => ({
            apps: [
              {
                appId: 'app-dev',
                name: 'Development app',
                connection: 'windows-dev',
                platform: 'windows',
              },
            ],
            truncated: false,
          }),
          close: async () => {
            closes += 1;
          },
        });
      },
    };
    const adapter = createWindowsRuntimeAdapter(completeEnvironment, {
      secretEnvironment,
      sessions,
      now: () => NOW,
    });

    expect(adapter).toBeDefined();
    expect(credentialReads).toBe(0);
    expect(opened).toHaveLength(0);
    await expect(adapter?.getEnvironmentCapabilities('windows-dev')).resolves.toMatchObject({
      configured: true,
      canRead: true,
      canPreview: true,
      canWriteDesignatedSheet: true,
      cleanupVerified: true,
    });
    expect(credentialReads).toBe(0);

    await expect(adapter?.listAccessibleApps('windows-dev', MUTATOR_ACTOR)).resolves.toMatchObject({
      apps: [{ appId: 'app-dev', name: 'Development app' }],
    });
    expect(credentialReads).toBe(1);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      connection: 'windows-dev',
      serverAlias: 'https://windows.example.test',
      virtualProxyAlias: 'jwt',
      discoveryAppId: 'app-discovery',
      writeTarget: {
        connection: 'windows-dev',
        appId: 'app-dev',
        sheetId: 'sheet-dev',
      },
      authMode: 'proxy-session',
      secret: { authMode: 'proxy-session', accessToken },
    });
    expect(closes).toBe(1);
  });

  it('keeps readiness and writes fail-closed when evidence or target fields are incomplete', async () => {
    const incompleteEvidence = createWindowsRuntimeAdapter(
      { ...completeEnvironment, QLIK_WINDOWS_READINESS_CLEANUP_VERIFIED: undefined },
      { now: () => NOW },
    );
    await expect(
      incompleteEvidence?.getEnvironmentCapabilities('windows-dev'),
    ).resolves.toMatchObject({ configured: false, canRead: false });

    const invalidEvidence = createWindowsRuntimeAdapter(
      { ...completeEnvironment, QLIK_WINDOWS_READINESS_APPROVED: 'yes' },
      { now: () => NOW },
    );
    await expect(invalidEvidence?.getEnvironmentCapabilities('windows-dev')).resolves.toMatchObject(
      { configured: false, canRead: false },
    );

    const incompleteTarget = createWindowsRuntimeAdapter(
      { ...completeEnvironment, QLIK_WINDOWS_WRITE_SHEET_ID: undefined },
      { now: () => NOW },
    );
    await expect(
      incompleteTarget?.getEnvironmentCapabilities('windows-dev'),
    ).resolves.toMatchObject({
      configured: true,
      canRead: true,
      canWriteDesignatedSheet: false,
      cleanupVerified: false,
    });
  });

  it('does not require a credential for capability probing but fails closed before QIX without one', async () => {
    let opens = 0;
    const adapter = createWindowsRuntimeAdapter(completeEnvironment, {
      secretEnvironment: {},
      sessions: {
        open: async () => {
          opens += 1;
          throw new Error('must not open');
        },
      },
      now: () => NOW,
    });

    await expect(adapter?.getEnvironmentCapabilities('windows-dev')).resolves.toMatchObject({
      configured: true,
    });
    await expect(adapter?.listAccessibleApps('windows-dev', MUTATOR_ACTOR)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(opens).toBe(0);
  });
});
