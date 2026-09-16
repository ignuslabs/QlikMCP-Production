import type { ConnectionAlias } from '../../domain/types.js';
import { EnvironmentWindowsSecretProvider } from './environmentWindowsSecretProvider.js';
import {
  normalizeWindowsServerAlias,
  QlikWindowsEngineSessionFactory,
} from './qlikWindowsEngineSession.js';
import {
  createWindowsAdapter,
  type WindowsAdapter,
  type WindowsEngineSessionFactory,
  type WindowsReadinessEvidence,
  type WindowsWriteTarget,
} from './windowsAdapter.js';

const MAX_ROUTING_VALUE_LENGTH = 1_024;
const VIRTUAL_PROXY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Explicit, non-secret process configuration accepted by the Windows runtime.
 * Deliberately absent: JWTs, PFX bytes, passphrases, and trusted-user headers.
 */
export interface WindowsRuntimeEnvironment {
  readonly QLIK_WINDOWS_CONNECTION_ALIAS?: string;
  readonly QLIK_WINDOWS_SERVER_ALIAS?: string;
  readonly QLIK_WINDOWS_AUTH_MODE?: string;
  readonly QLIK_WINDOWS_VIRTUAL_PROXY_ALIAS?: string;
  readonly QLIK_WINDOWS_DISCOVERY_APP_ID?: string;
  readonly QLIK_WINDOWS_WRITE_APP_ID?: string;
  readonly QLIK_WINDOWS_WRITE_SHEET_ID?: string;
  readonly QLIK_WINDOWS_READINESS_APPROVED?: string;
  readonly QLIK_WINDOWS_READINESS_EXPIRES_AT?: string;
  readonly QLIK_WINDOWS_READINESS_CAN_READ?: string;
  readonly QLIK_WINDOWS_READINESS_CAN_PREVIEW?: string;
  readonly QLIK_WINDOWS_READINESS_CAN_WRITE_DESIGNATED_SHEET?: string;
  readonly QLIK_WINDOWS_READINESS_CLEANUP_VERIFIED?: string;
}

export interface WindowsRuntimeOptions {
  /** Secret-injection view. Values are read lazily only when an Engine session is opened. */
  readonly secretEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  /** Test seam; production uses the installed `@qlik/api` QIX implementation. */
  readonly sessions?: WindowsEngineSessionFactory;
}

function safeNonEmpty(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length > MAX_ROUTING_VALUE_LENGTH ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function exactBoolean(value: string | undefined): boolean | undefined {
  const normalized = safeNonEmpty(value)?.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function readinessFromEnvironment(
  environment: WindowsRuntimeEnvironment,
): WindowsReadinessEvidence | undefined {
  const approved = exactBoolean(environment.QLIK_WINDOWS_READINESS_APPROVED);
  const canRead = exactBoolean(environment.QLIK_WINDOWS_READINESS_CAN_READ);
  const canPreview = exactBoolean(environment.QLIK_WINDOWS_READINESS_CAN_PREVIEW);
  const canWriteDesignatedSheet = exactBoolean(
    environment.QLIK_WINDOWS_READINESS_CAN_WRITE_DESIGNATED_SHEET,
  );
  const cleanupVerified = exactBoolean(environment.QLIK_WINDOWS_READINESS_CLEANUP_VERIFIED);
  const rawExpiresAt = safeNonEmpty(environment.QLIK_WINDOWS_READINESS_EXPIRES_AT);
  const expiresAtMilliseconds = rawExpiresAt ? Date.parse(rawExpiresAt) : Number.NaN;

  if (
    approved === undefined ||
    canRead === undefined ||
    canPreview === undefined ||
    canWriteDesignatedSheet === undefined ||
    cleanupVerified === undefined ||
    !Number.isFinite(expiresAtMilliseconds)
  ) {
    return undefined;
  }

  return {
    approved,
    expiresAt: new Date(expiresAtMilliseconds).toISOString(),
    canRead,
    canPreview,
    canWriteDesignatedSheet,
    cleanupVerified,
  };
}

function writeTargetFromEnvironment(
  environment: WindowsRuntimeEnvironment,
  connection: ConnectionAlias,
): WindowsWriteTarget | undefined {
  const appId = safeNonEmpty(environment.QLIK_WINDOWS_WRITE_APP_ID);
  const sheetId = safeNonEmpty(environment.QLIK_WINDOWS_WRITE_SHEET_ID);
  return appId && sheetId ? { connection, appId, sheetId } : undefined;
}

/**
 * Constructs the production Windows credential/QIX stack from explicit routing and readiness
 * input. Missing or unsafe core values return `undefined`; incomplete readiness is omitted so
 * the resulting adapter reports `NOT_CONFIGURED`. Credential material remains lazy.
 */
export function createWindowsRuntimeAdapter(
  environment: WindowsRuntimeEnvironment,
  options: WindowsRuntimeOptions = {},
): WindowsAdapter | undefined {
  const connection = safeNonEmpty(environment.QLIK_WINDOWS_CONNECTION_ALIAS);
  const rawServerAlias = safeNonEmpty(environment.QLIK_WINDOWS_SERVER_ALIAS);
  const authModeValue = safeNonEmpty(environment.QLIK_WINDOWS_AUTH_MODE);
  const discoveryAppId = safeNonEmpty(environment.QLIK_WINDOWS_DISCOVERY_APP_ID);
  if (
    !connection ||
    !rawServerAlias ||
    !discoveryAppId ||
    (authModeValue !== 'proxy-session' && authModeValue !== 'trusted-backend')
  ) {
    return undefined;
  }

  let serverAlias: string;
  try {
    serverAlias = normalizeWindowsServerAlias(rawServerAlias);
  } catch {
    return undefined;
  }

  const virtualProxyAlias = safeNonEmpty(environment.QLIK_WINDOWS_VIRTUAL_PROXY_ALIAS);
  if (
    (authModeValue === 'proxy-session' &&
      (!virtualProxyAlias || !VIRTUAL_PROXY_PATTERN.test(virtualProxyAlias))) ||
    (authModeValue === 'trusted-backend' && virtualProxyAlias !== undefined)
  ) {
    return undefined;
  }

  const writeTarget = writeTargetFromEnvironment(environment, connection);
  const readiness = readinessFromEnvironment(environment);
  const now = options.now;
  const secrets = new EnvironmentWindowsSecretProvider({
    connection,
    ...(options.secretEnvironment ? { environment: options.secretEnvironment } : {}),
    ...(now ? { now } : {}),
  });

  return createWindowsAdapter(
    {
      connection,
      serverAlias,
      ...(virtualProxyAlias ? { virtualProxyAlias } : {}),
      authMode: authModeValue,
      discoveryAppId,
      ...(writeTarget ? { writeTarget } : {}),
      ...(readiness ? { readiness } : {}),
    },
    {
      secrets,
      sessions: options.sessions ?? new QlikWindowsEngineSessionFactory(),
      ...(now ? { now } : {}),
    },
  );
}
