import type { HostConfig } from '@qlik/api/auth';
import type { ConnectionAlias } from '../../domain/types.js';

/** Supplies a client secret from an approved runtime secret system. */
export type CloudOAuthClientSecretProvider = (connection: ConnectionAlias) => Promise<string>;

/** Produces an authenticated SDK host configuration for one allowlisted connection. */
export interface CloudHostConfigFactory {
  getHostConfig(connection: ConnectionAlias): Promise<HostConfig>;
}

/** Sanitized transport failure; response bodies and credential values are never retained. */
export class CloudOAuthRequestError extends Error {
  readonly code: 'CLOUD_OAUTH_AUTHORIZATION_FAILED' | 'CLOUD_OAUTH_UNAVAILABLE';

  constructor(readonly status: number) {
    super('Qlik Cloud OAuth token acquisition failed.');
    this.name = 'CloudOAuthRequestError';
    this.code =
      status === 400 || status === 401 || status === 403
        ? 'CLOUD_OAUTH_AUTHORIZATION_FAILED'
        : 'CLOUD_OAUTH_UNAVAILABLE';
  }
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

/**
 * Normalizes a public tenant origin and rejects credentials, paths, queries,
 * fragments, and non-TLS endpoints before the value reaches the SDK.
 */
export function normalizeCloudTenantHost(rawHost: string): string {
  const parsed = new URL(requireNonEmpty(rawHost, 'tenantHost'));
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('tenantHost must be an HTTPS origin without credentials or a path.');
  }
  return parsed.origin;
}

export interface OAuthHostConfigFactoryOptions {
  readonly connection: ConnectionAlias;
  readonly tenantHost: string;
  readonly clientId: string;
  readonly clientSecrets: CloudOAuthClientSecretProvider;
}

/** Builds the short-lived OAuth host config required by the Node.js Qlik SDK. */
export class OAuthHostConfigFactory implements CloudHostConfigFactory {
  private readonly tenantHost: string;
  private readonly clientId: string;

  constructor(private readonly options: OAuthHostConfigFactoryOptions) {
    this.tenantHost = normalizeCloudTenantHost(options.tenantHost);
    this.clientId = requireNonEmpty(options.clientId, 'clientId');
  }

  async getHostConfig(connection: ConnectionAlias): Promise<HostConfig> {
    if (connection !== this.options.connection) throw new CloudOAuthRequestError(403);
    const clientSecret = requireNonEmpty(
      await this.options.clientSecrets(connection),
      'OAuth client secret',
    );
    return {
      host: this.tenantHost,
      authType: 'oauth2',
      clientId: this.clientId,
      clientSecret,
    };
  }
}
