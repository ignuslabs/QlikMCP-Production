import { createSecureContext } from 'node:tls';
import { createError } from '../../domain/errors.js';
import type { ConnectionAlias } from '../../domain/types.js';
import type {
  WindowsAdapterConfig,
  WindowsSecret,
  WindowsSecretProvider,
} from './windowsAdapter.js';

const MAX_JWT_LENGTH = 32 * 1024;
const MAX_PFX_BASE64_LENGTH = 2 * 1024 * 1024;
const MIN_PFX_BYTES = 32;
const JWT_CLOCK_SKEW_SECONDS = 30;

export interface WindowsSecretEnvironmentNames {
  readonly proxyJwt: string;
  readonly trustedPfxBase64: string;
  readonly trustedPfxPassphrase: string;
  readonly trustedUserHeader: string;
}

export const DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES: WindowsSecretEnvironmentNames = {
  proxyJwt: 'QLIK_WINDOWS_PROXY_SESSION_JWT',
  trustedPfxBase64: 'QLIK_WINDOWS_TRUSTED_BACKEND_PFX_BASE64',
  trustedPfxPassphrase: 'QLIK_WINDOWS_TRUSTED_BACKEND_PFX_PASSPHRASE',
  trustedUserHeader: 'QLIK_WINDOWS_TRUSTED_BACKEND_USER_HEADER',
};

export interface EnvironmentWindowsSecretProviderOptions {
  /** Prevents a credential set from being reused under another connection alias. */
  readonly connection: ConnectionAlias;
  /** Injectable environment view for tests and non-process secret injection. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly names?: Partial<WindowsSecretEnvironmentNames>;
  readonly now?: () => Date;
  /** Passwordless PFX files must be opted into explicitly. */
  readonly requirePfxPassphrase?: boolean;
  /** Injection seam for deterministic tests; production parses PKCS#12 through Node TLS. */
  readonly validatePfx?: (pfx: Uint8Array, passphrase: string | undefined) => void;
}

function notConfigured(message: string): never {
  throw createError('NOT_CONFIGURED', { message });
}

function requiredValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    return notConfigured(`The required Windows secret injection "${name}" is unavailable.`);
  }
  return value;
}

function decodeJwtPart(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return notConfigured('The injected Windows JWT is invalid.');
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  } catch {
    return notConfigured('The injected Windows JWT is invalid.');
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function validateProxyJwt(raw: string, now: Date): string {
  const token = raw.trim();
  if (!token || token.length > MAX_JWT_LENGTH || /\s/.test(token)) {
    return notConfigured('The injected Windows JWT is invalid.');
  }
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    parts.some((part) => part.length === 0 || !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    return notConfigured('The injected Windows JWT is invalid.');
  }
  const header = asRecord(decodeJwtPart(parts[0]!));
  const claims = asRecord(decodeJwtPart(parts[1]!));
  if (!header || !claims || typeof header.alg !== 'string' || header.alg.toLowerCase() === 'none') {
    return notConfigured('The injected Windows JWT is invalid.');
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    !Number.isFinite(nowSeconds) ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= nowSeconds + JWT_CLOCK_SKEW_SECONDS
  ) {
    return notConfigured('The injected Windows JWT is expired or has no valid expiry.');
  }
  if (
    claims.nbf !== undefined &&
    (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf))
  ) {
    return notConfigured('The injected Windows JWT has an invalid activation time.');
  }
  if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds + JWT_CLOCK_SKEW_SECONDS) {
    return notConfigured('The injected Windows JWT is not active yet.');
  }
  return token;
}

function decodePfxBase64(raw: string): Uint8Array {
  if (
    !raw ||
    raw.length > MAX_PFX_BASE64_LENGTH ||
    /\s/.test(raw) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(raw) ||
    raw.length % 4 === 1
  ) {
    return notConfigured('The injected Windows PFX value is not valid base64.');
  }
  const decoded = Buffer.from(raw, 'base64');
  const canonicalInput = raw.replace(/=+$/, '');
  const canonicalDecoded = decoded.toString('base64').replace(/=+$/, '');
  if (
    canonicalInput !== canonicalDecoded ||
    decoded.byteLength < MIN_PFX_BYTES ||
    decoded[0] !== 0x30
  ) {
    return notConfigured('The injected Windows PFX value is not a valid PKCS#12 payload.');
  }
  return Uint8Array.from(decoded);
}

function validateUserHeader(raw: string): string {
  if (raw.length > 320 || /[\r\n\0]/.test(raw)) {
    return notConfigured('The injected Windows user header is invalid.');
  }
  const match = /^UserDirectory=([^;]{1,128});\s*UserId=([^;]{1,128})$/.exec(raw);
  const userDirectory = match?.[1]?.trim();
  const userId = match?.[2]?.trim();
  if (!userDirectory || !userId) {
    return notConfigured('The injected Windows user header is invalid.');
  }
  return `UserDirectory=${userDirectory};UserId=${userId}`;
}

/**
 * Reads Azure-Key-Vault-injected environment values without ever falling back to files,
 * interactive login, default Qlik credentials, or caller-supplied secret material.
 */
export class EnvironmentWindowsSecretProvider implements WindowsSecretProvider {
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly names: WindowsSecretEnvironmentNames;
  private readonly now: () => Date;
  private readonly requirePfxPassphrase: boolean;
  private readonly validatePfx: (pfx: Uint8Array, passphrase: string | undefined) => void;

  constructor(private readonly options: EnvironmentWindowsSecretProviderOptions) {
    this.environment = options.environment ?? process.env;
    this.names = { ...DEFAULT_WINDOWS_SECRET_ENVIRONMENT_NAMES, ...options.names };
    this.now = options.now ?? (() => new Date());
    this.requirePfxPassphrase = options.requirePfxPassphrase ?? true;
    this.validatePfx =
      options.validatePfx ??
      ((pfx, passphrase) => {
        createSecureContext({ pfx: Buffer.from(pfx), ...(passphrase ? { passphrase } : {}) });
      });
  }

  async get(
    connection: ConnectionAlias,
    authMode: NonNullable<WindowsAdapterConfig['authMode']>,
  ): Promise<WindowsSecret> {
    if (connection !== this.options.connection) {
      return notConfigured('No Windows secret injection is assigned to this connection alias.');
    }
    if (authMode === 'proxy-session') {
      const accessToken = validateProxyJwt(
        requiredValue(this.environment, this.names.proxyJwt),
        this.now(),
      );
      return { authMode, accessToken };
    }

    const pfx = decodePfxBase64(requiredValue(this.environment, this.names.trustedPfxBase64));
    const userHeader = validateUserHeader(
      requiredValue(this.environment, this.names.trustedUserHeader),
    );
    const passphrase = this.environment[this.names.trustedPfxPassphrase];
    if (this.requirePfxPassphrase && (!passphrase || passphrase.length === 0)) {
      return notConfigured('The required Windows PFX passphrase injection is unavailable.');
    }
    try {
      this.validatePfx(pfx, passphrase);
    } catch {
      return notConfigured(
        'The injected Windows PFX could not be parsed with the supplied passphrase.',
      );
    }
    return {
      authMode,
      pfx,
      ...(passphrase ? { passphrase } : {}),
      userHeader,
    };
  }
}
