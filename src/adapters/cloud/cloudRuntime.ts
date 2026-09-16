import type { ConnectionAlias } from '../../domain/types.js';
import {
  createCloudAdapter,
  type CloudAdapter,
  type CloudReadinessEvidence,
  type CloudWriteTarget,
} from './cloudAdapter.js';
import {
  OAuthHostConfigFactory,
  normalizeCloudTenantHost,
  type CloudOAuthClientSecretProvider,
} from './cloudOAuth.js';
import { QlikApiCloudClient, type CloudQlikClient } from './qlikApiCloudClient.js';

/**
 * Explicit, non-secret process configuration accepted by the Cloud runtime.
 * Deliberately absent: an OAuth client secret, access token, or secret-store value.
 */
export interface CloudRuntimeEnvironment {
  readonly QLIK_CLOUD_CONNECTION_ALIAS?: string;
  readonly QLIK_CLOUD_TENANT_HOST?: string;
  readonly QLIK_CLOUD_TENANT_ALIAS?: string;
  readonly QLIK_CLOUD_REGION_ALIAS?: string;
  readonly QLIK_CLOUD_OAUTH_CLIENT_ID?: string;
  readonly QLIK_CLOUD_ENVIRONMENT?: string;
  readonly QLIK_CLOUD_WRITE_APP_ID?: string;
  readonly QLIK_CLOUD_WRITE_SHEET_ID?: string;
  readonly QLIK_CLOUD_SHEET_CREATION_APP_IDS?: string;
  readonly QLIK_CLOUD_READINESS_APPROVED?: string;
  readonly QLIK_CLOUD_READINESS_EXPIRES_AT?: string;
  readonly QLIK_CLOUD_READINESS_CAN_READ?: string;
  readonly QLIK_CLOUD_READINESS_CAN_PREVIEW?: string;
  readonly QLIK_CLOUD_READINESS_CAN_WRITE_DESIGNATED_SHEET?: string;
  readonly QLIK_CLOUD_READINESS_CLEANUP_VERIFIED?: string;
}

export interface CloudRuntimeOptions {
  /** Resolves the secret at token-exchange time from the deployment secret system. */
  readonly clientSecrets: CloudOAuthClientSecretProvider;
  readonly now?: () => Date;
  readonly identityFactory?: () => string;
  /** Test seam; production uses the installed `@qlik/api` implementation. */
  readonly qlik?: CloudQlikClient;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function exactBoolean(value: string | undefined): boolean | undefined {
  const normalized = nonEmpty(value)?.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function readinessFromEnvironment(
  environment: CloudRuntimeEnvironment,
): CloudReadinessEvidence | undefined {
  const approved = exactBoolean(environment.QLIK_CLOUD_READINESS_APPROVED);
  const canRead = exactBoolean(environment.QLIK_CLOUD_READINESS_CAN_READ);
  const canPreview = exactBoolean(environment.QLIK_CLOUD_READINESS_CAN_PREVIEW);
  const canWriteDesignatedSheet = exactBoolean(
    environment.QLIK_CLOUD_READINESS_CAN_WRITE_DESIGNATED_SHEET,
  );
  const cleanupVerified = exactBoolean(environment.QLIK_CLOUD_READINESS_CLEANUP_VERIFIED);
  const rawExpiresAt = nonEmpty(environment.QLIK_CLOUD_READINESS_EXPIRES_AT);
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
  environment: CloudRuntimeEnvironment,
  connection: ConnectionAlias,
): CloudWriteTarget | undefined {
  const appId = nonEmpty(environment.QLIK_CLOUD_WRITE_APP_ID);
  const sheetId = nonEmpty(environment.QLIK_CLOUD_WRITE_SHEET_ID);
  return appId && sheetId ? { connection, appId, sheetId } : undefined;
}

/**
 * Constructs the production Cloud OAuth/QIX stack from explicit, non-secret
 * input. Missing or unsafe core routing values return `undefined`; incomplete
 * readiness is omitted so the resulting adapter reports `NOT_CONFIGURED`.
 */
export function createCloudRuntimeAdapter(
  environment: CloudRuntimeEnvironment,
  options: CloudRuntimeOptions,
): CloudAdapter | undefined {
  const connection = nonEmpty(environment.QLIK_CLOUD_CONNECTION_ALIAS);
  const rawTenantHost = nonEmpty(environment.QLIK_CLOUD_TENANT_HOST);
  const oauthClientId = nonEmpty(environment.QLIK_CLOUD_OAUTH_CLIENT_ID);
  if (!connection || !rawTenantHost || !oauthClientId) return undefined;

  let tenantHost: string;
  try {
    tenantHost = normalizeCloudTenantHost(rawTenantHost);
  } catch {
    return undefined;
  }

  const tenantAlias = nonEmpty(environment.QLIK_CLOUD_TENANT_ALIAS);
  const regionAlias = nonEmpty(environment.QLIK_CLOUD_REGION_ALIAS);
  const runtimeEnvironment = nonEmpty(environment.QLIK_CLOUD_ENVIRONMENT);
  const writeTarget = writeTargetFromEnvironment(environment, connection);
  const readiness = readinessFromEnvironment(environment);
  const now = options.now;
  const hostConfigs = new OAuthHostConfigFactory({
    connection,
    tenantHost,
    clientId: oauthClientId,
    clientSecrets: options.clientSecrets,
  });

  return createCloudAdapter(
    {
      connection,
      tenantHost,
      oauthClientId,
      ...(tenantAlias ? { tenantAlias } : {}),
      ...(regionAlias ? { regionAlias } : {}),
      ...(runtimeEnvironment ? { environment: runtimeEnvironment } : {}),
      ...(writeTarget ? { writeTarget } : {}),
      sheetCreationAppIds: parseSheetCreationAppIds(environment.QLIK_CLOUD_SHEET_CREATION_APP_IDS),
      ...(readiness ? { readiness } : {}),
    },
    {
      hostConfigs,
      qlik: options.qlik ?? new QlikApiCloudClient(),
      ...(now ? { now } : {}),
      ...(options.identityFactory ? { identityFactory: options.identityFactory } : {}),
    },
  );
}

/** Invalid scope input grants no additional apps. */
function parseSheetCreationAppIds(value: string | undefined): readonly string[] {
  if (!value || value.length > 8_192) return [];
  const ids = value.split(',').map((id) => id.trim());
  return ids.length <= 50 && ids.every((id) => /^[A-Za-z0-9_-]{1,160}$/.test(id))
    ? [...new Set(ids)]
    : [];
}
