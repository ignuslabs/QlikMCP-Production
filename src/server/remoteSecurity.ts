import { createPublicKey, randomUUID, verify, type JsonWebKey } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface RemotePrincipal {
  readonly subject: string;
  readonly clientId: string;
  readonly scopes?: readonly string[];
}

interface JwtPayload {
  readonly sub?: string;
  readonly aud?: string | string[];
  readonly iss?: string;
  readonly exp?: number;
  readonly nbf?: number;
  readonly azp?: string;
  readonly appid?: string;
  readonly client_id?: string;
  readonly scope?: string;
  readonly scp?: string | string[];
}

interface Jwk {
  readonly kid?: string;
  readonly kty: string;
  readonly alg?: string;
  [key: string]: unknown;
}

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

const keyCache = new Map<string, { expires: number; keys: Jwk[] }>();
const keyRequests = new Map<string, Promise<Jwk[]>>();

async function getKeys(jwksUri: string): Promise<Jwk[]> {
  const cached = keyCache.get(jwksUri);
  if (cached && cached.expires > Date.now()) return cached.keys;
  const pending = keyRequests.get(jwksUri);
  if (pending) return pending;
  const request = (async () => {
    const response = await fetch(jwksUri, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error('identity provider key discovery failed');
    const body = (await response.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys)) throw new Error('identity provider returned no signing keys');
    // Cache by trust source and coalesce cold concurrent requests. Never reuse a
    // signing key fetched from a different configured identity provider.
    if (keyCache.size >= 16) keyCache.delete(keyCache.keys().next().value!);
    keyCache.set(jwksUri, { expires: Date.now() + 300_000, keys: body.keys });
    return body.keys;
  })();
  keyRequests.set(jwksUri, request);
  try {
    return await request;
  } finally {
    keyRequests.delete(jwksUri);
  }
}

/** Validates signature, issuer, lifetime and the configured API audience. */
export async function authenticateBearer(
  authorization: string | undefined,
  config: {
    audience: string;
    issuer: string;
    jwksUri: string;
    allowedClientIds?: readonly string[];
    requiredScopes?: readonly string[];
  },
): Promise<RemotePrincipal> {
  if (!authorization?.startsWith('Bearer ')) throw new Error('missing bearer token');
  const parts = authorization.slice(7).split('.');
  if (parts.length !== 3) throw new Error('malformed bearer token');
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = decodePart<{ alg?: string; kid?: string }>(encodedHeader);
  const payload = decodePart<JwtPayload>(encodedPayload);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('unsupported token signing algorithm');
  const key = (await getKeys(config.jwksUri)).find(
    (candidate) => candidate.kid === header.kid && candidate.kty === 'RSA',
  );
  if (!key) throw new Error('unknown token signing key');
  const valid = verify(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    createPublicKey({ key: key as JsonWebKey, format: 'jwk' }),
    Buffer.from(encodedSignature, 'base64url'),
  );
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!valid || payload.iss !== config.issuer || !audiences.includes(config.audience))
    throw new Error('token claims are invalid');
  if (
    typeof payload.exp !== 'number' ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= now ||
    (payload.nbf !== undefined &&
      (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > now + 30))
  )
    throw new Error('token is outside its validity window');
  if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 500)
    throw new Error('token has no valid subject');
  if (
    (payload.azp !== undefined && typeof payload.azp !== 'string') ||
    (payload.appid !== undefined && typeof payload.appid !== 'string') ||
    (payload.client_id !== undefined && typeof payload.client_id !== 'string')
  )
    throw new Error('token has no valid client identity');
  const clientId = payload.azp ?? payload.client_id ?? payload.appid ?? 'unknown-client';
  if (
    !clientId.trim() ||
    clientId.length > 500 ||
    (config.allowedClientIds && !config.allowedClientIds.includes(clientId))
  ) {
    throw new Error('token client is not allowed');
  }
  if (
    (payload.scope !== undefined && typeof payload.scope !== 'string') ||
    (payload.scp !== undefined &&
      typeof payload.scp !== 'string' &&
      (!Array.isArray(payload.scp) || payload.scp.some((scope) => typeof scope !== 'string')))
  ) {
    throw new Error('token scopes are malformed');
  }
  const scopes = Array.from(
    new Set(
      [
        ...(payload.scope?.split(/\s+/u) ?? []),
        ...(Array.isArray(payload.scp) ? payload.scp : (payload.scp?.split(/\s+/u) ?? [])),
      ].filter(Boolean),
    ),
  );
  if (config.requiredScopes?.some((scope) => !scopes.includes(scope))) {
    throw new Error('token is missing a required invocation scope');
  }
  return { subject: payload.sub, clientId, scopes };
}

export function correlationId(headers: IncomingHttpHeaders): string {
  const supplied = headers['x-correlation-id'];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  return value && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : randomUUID();
}

export class FixedWindowQuota {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error('Quota limit and window must be positive.');
    }
  }
  consume(subject: string, now = Date.now()): boolean {
    const current = this.windows.get(subject);
    if (!current || now - current.start >= this.windowMs) {
      if (this.windows.size >= 10_000) {
        for (const [key, entry] of this.windows) {
          if (now - entry.start >= this.windowMs) this.windows.delete(key);
        }
        if (this.windows.size >= 10_000 && !this.windows.has(subject)) return false;
      }
      this.windows.set(subject, { start: now, count: 1 });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }
}
