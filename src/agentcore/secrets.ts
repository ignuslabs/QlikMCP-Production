import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type SecretsManagerClientConfig,
} from '@aws-sdk/client-secrets-manager';
import type { CloudOAuthClientSecretProvider } from '../adapters/cloud/cloudOAuth.js';

interface QlikSecretDocument {
  readonly clientSecret?: unknown;
  readonly connectionAlias?: unknown;
}

export interface AgentCoreQlikSecretProviderOptions {
  readonly secretId: string;
  readonly connectionAlias: string;
  readonly cacheTtlMs?: number;
  readonly client?: SecretsManagerClient;
  readonly clientConfig?: SecretsManagerClientConfig;
  readonly now?: () => number;
}

function decodeSecret(binary: Uint8Array | undefined): string | undefined {
  return binary ? Buffer.from(binary).toString('utf8') : undefined;
}

function parseSecret(raw: string, expectedConnection: string): string {
  let document: QlikSecretDocument;
  try {
    document = JSON.parse(raw) as QlikSecretDocument;
  } catch {
    throw new Error('The Qlik secret must be a JSON object containing clientSecret.');
  }
  if (document.connectionAlias !== undefined && document.connectionAlias !== expectedConnection) {
    throw new Error('The Qlik secret is bound to a different connection alias.');
  }
  if (typeof document.clientSecret !== 'string' || document.clientSecret.trim().length === 0) {
    throw new Error('The Qlik secret does not contain a non-empty clientSecret.');
  }
  return document.clientSecret;
}

/** Resolves the Qlik OAuth client secret on demand without placing it in process configuration. */
export function createAgentCoreQlikSecretProvider(
  options: AgentCoreQlikSecretProviderOptions,
): CloudOAuthClientSecretProvider {
  const secretId = options.secretId.trim();
  const connectionAlias = options.connectionAlias.trim();
  if (!secretId) throw new Error('QLIK_AGENTCORE_QLIK_SECRET_ID is required.');
  if (!connectionAlias) throw new Error('QLIK_CLOUD_CONNECTION_ALIAS is required.');
  const client = options.client ?? new SecretsManagerClient(options.clientConfig ?? {});
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 300_000) {
    throw new Error('Secret cache TTL must be from 0 through 300000 milliseconds.');
  }
  const now = options.now ?? Date.now;
  let cached: { readonly value: string; readonly expiresAt: number } | undefined;

  let inFlight: Promise<string> | undefined;

  return async (requestedConnection) => {
    if (requestedConnection !== connectionAlias) {
      throw new Error('No Qlik secret is configured for the requested connection alias.');
    }
    if (cached && cached.expiresAt > now()) return cached.value;
    // Collapse concurrent cold starts and rotations to one provider request.
    inFlight ??= (async () => {
      const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      const raw = result.SecretString ?? decodeSecret(result.SecretBinary);
      if (!raw) throw new Error('Secrets Manager returned an empty Qlik secret.');
      const value = parseSecret(raw, connectionAlias);
      cached = { value, expiresAt: now() + cacheTtlMs };
      return value;
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
