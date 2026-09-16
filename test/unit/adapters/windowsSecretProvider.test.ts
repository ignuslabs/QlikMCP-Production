import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES,
  EnvironmentWindowsSecretProvider,
} from '../../../src/adapters/windows/environmentWindowsSecretProvider.js';

const NOW = new Date('2030-01-01T00:00:00.000Z');

function jwt(claims: Readonly<Record<string, unknown>>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

function pfxBase64(): string {
  const bytes = Buffer.alloc(64, 0x01);
  bytes[0] = 0x30;
  return bytes.toString('base64');
}

describe('EnvironmentWindowsSecretProvider', () => {
  it('returns a validated short-lived proxy JWT only for its assigned connection', async () => {
    const accessToken = jwt({ exp: Math.floor(NOW.getTime() / 1000) + 300 });
    const provider = new EnvironmentWindowsSecretProvider({
      connection: 'windows-dev',
      environment: { [DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.proxyJwt]: accessToken },
      now: () => NOW,
    });

    await expect(provider.get('windows-dev', 'proxy-session')).resolves.toEqual({
      authMode: 'proxy-session',
      accessToken,
    });
    await expect(provider.get('another-connection', 'proxy-session')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('fails closed for missing, malformed, unsigned, expired, or unsafe-lifetime proxy JWT values', async () => {
    const nowSeconds = Math.floor(NOW.getTime() / 1000);
    const values = [
      undefined,
      'not-a-jwt',
      `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(
        JSON.stringify({ exp: nowSeconds + 60 }),
      ).toString('base64url')}.signature`,
      jwt({ exp: nowSeconds - 120 }),
      jwt({ exp: nowSeconds + 30 }),
      jwt({ exp: nowSeconds + 300, nbf: 'not-a-number' }),
    ];

    for (const value of values) {
      const provider = new EnvironmentWindowsSecretProvider({
        connection: 'windows-dev',
        environment: { [DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.proxyJwt]: value },
        now: () => NOW,
      });
      const failure = provider.get('windows-dev', 'proxy-session');
      await expect(failure).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
      await expect(failure).rejects.not.toThrow(value ?? 'unavailable-value');
    }
  });

  it('decodes a Key-Vault-injected PFX and validates the trusted identity header', async () => {
    const encodedPfx = pfxBase64();
    let validatedPassphrase: string | undefined;
    const provider = new EnvironmentWindowsSecretProvider({
      connection: 'windows-dev',
      environment: {
        [DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.trustedPfxBase64]: encodedPfx,
        [DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.trustedPfxPassphrase]: 'pfx-passphrase',
        [DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.trustedUserHeader]:
          'UserDirectory=HARNESS; UserId=svc_windows',
      },
      validatePfx: (_pfx, passphrase) => {
        validatedPassphrase = passphrase;
      },
    });

    const secret = await provider.get('windows-dev', 'trusted-backend');

    expect(secret).toMatchObject({
      authMode: 'trusted-backend',
      passphrase: 'pfx-passphrase',
      userHeader: 'UserDirectory=HARNESS;UserId=svc_windows',
    });
    expect(
      secret.authMode === 'trusted-backend' && Buffer.from(secret.pfx).toString('base64'),
    ).toBe(encodedPfx);
    expect(validatedPassphrase).toBe('pfx-passphrase');
  });

  it('rejects invalid PFX bytes, a missing passphrase, and header injection without echoing secrets', async () => {
    const encodedPfx = pfxBase64();
    const cases = [
      {
        pfx: Buffer.from('not-pkcs12').toString('base64'),
        passphrase: 'pfx-passphrase',
        header: 'UserDirectory=HARNESS;UserId=svc_windows',
      },
      {
        pfx: encodedPfx,
        passphrase: undefined,
        header: 'UserDirectory=HARNESS;UserId=svc_windows',
      },
      {
        pfx: encodedPfx,
        passphrase: 'pfx-passphrase',
        header: 'UserDirectory=HARNESS;UserId=svc_windows\r\nInjected: true',
      },
      {
        pfx: encodedPfx,
        passphrase: 'wrong-passphrase',
        header: 'UserDirectory=HARNESS;UserId=svc_windows',
        parseFails: true,
      },
    ];

    for (const entry of cases) {
      const provider = new EnvironmentWindowsSecretProvider({
        connection: 'windows-dev',
        environment: {
          [DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.trustedPfxBase64]: entry.pfx,
          [DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.trustedPfxPassphrase]: entry.passphrase,
          [DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.trustedUserHeader]: entry.header,
        },
        ...(entry.parseFails
          ? {
              validatePfx: () => {
                throw new Error('OpenSSL parse failure with secret details');
              },
            }
          : {}),
      });
      const failure = provider.get('windows-dev', 'trusted-backend');
      await expect(failure).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
      await expect(failure).rejects.not.toThrow(entry.header);
      await expect(failure).rejects.not.toThrow(entry.pfx);
    }
  });

  it('permits an explicitly approved passwordless PFX without inventing a passphrase', async () => {
    const provider = new EnvironmentWindowsSecretProvider({
      connection: 'windows-dev',
      requirePfxPassphrase: false,
      environment: {
        [DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.trustedPfxBase64]: pfxBase64(),
        [DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES.trustedUserHeader]:
          'UserDirectory=HARNESS;UserId=svc_windows',
      },
      validatePfx: () => undefined,
    });

    await expect(provider.get('windows-dev', 'trusted-backend')).resolves.not.toHaveProperty(
      'passphrase',
    );
  });
});
