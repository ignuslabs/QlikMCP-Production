/**
 * Recursive redaction utilities.
 *
 * Applied before any value is persisted to the operation/audit store and
 * again before any value is serialized as an MCP tool result. Redaction is
 * defense in depth: DTOs built by this harness should already omit secrets,
 * tokens, certificates, headers, QIX handles, raw property trees, load
 * scripts, connection/security metadata, and full layouts, but this pass
 * catches anything that slips through a field name or value pattern.
 *
 * A small, explicit allowlist exists alongside the forbidden-fragment list
 * because this harness's own opaque, single-use, narrowly-scoped identifiers
 * (`approvalToken`, `idempotencyKey`, and similar) are intentionally part of
 * the MCP tool contract and must reach the caller; they are never a Qlik
 * credential, OAuth secret, or certificate.
 */

const SAFE_KEY_ALLOWLIST = [
  'approvaltoken',
  'idempotencykey',
  'consumedbyidempotencykey',
  'operationid',
  'originaloperationid',
  'planhash',
  'objectid',
  'createdobjectid',
  'originalobjectid',
  'sheetattachmentid',
  'sessionobjectid',
  'connectionalias',
  'correlationid',
  'tracereference',
  'hostclientid',
  'requestingprincipal',
  'rawpayloadsremoved',
  'sensitivevaluesremoved',
  'credentialmaterialpresent',
] as const;

const FORBIDDEN_KEY_FRAGMENTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'authorization',
  'authheader',
  'certificate',
  'privatekey',
  'private_key',
  'cert',
  'pem',
  'cookie',
  'qixhandle',
  'handle',
  'rawqixpayload',
  'rawqixrequest',
  'rawpayload',
  'loadscript',
  'dataconnection',
  'securityrule',
  'credential',
  'xqlikuser',
  'clientsecret',
  'refreshtoken',
  'accesstoken',
] as const;

// Matches common bearer/JWT-shaped or long opaque-token-shaped string values.
const SECRET_LIKE_VALUE_PATTERNS: readonly RegExp[] = [
  /^bearer\s+\S+/i,
  /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/, // JWT-shaped
  /^-----BEGIN [A-Z ]+-----/, // PEM material
];

const REDACTED_MARKER = '[redacted]';
const MAX_DEPTH = 12;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when a property key is a known-safe harness identifier that must never be redacted. */
export function isAllowlistedKey(key: string): boolean {
  return (SAFE_KEY_ALLOWLIST as readonly string[]).includes(normalizeKey(key));
}

/** True when a property key looks like a secret/credential/raw-payload field and must be redacted. */
export function isForbiddenKey(key: string): boolean {
  if (isAllowlistedKey(key)) {
    return false;
  }
  const normalized = normalizeKey(key);
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment.replace(/[^a-z0-9]/g, '')),
  );
}

function valueLooksSecret(value: string): boolean {
  return SECRET_LIKE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Returns a deep, redacted copy of `value`. Never mutates the input.
 * Arrays and plain objects are walked recursively up to a bounded depth;
 * anything deeper is replaced with the redaction marker rather than thrown
 * away silently, so truncation is visible instead of hidden.
 */
export function redact<T>(value: T, depth = 0): T {
  if (depth >= MAX_DEPTH) {
    return REDACTED_MARKER as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1)) as unknown as T;
  }
  if (value instanceof Date) {
    return value;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(source)) {
      if (isForbiddenKey(key)) {
        output[key] = REDACTED_MARKER;
        continue;
      }
      output[key] = redact(entryValue, depth + 1);
    }
    return output as unknown as T;
  }
  if (typeof value === 'string' && valueLooksSecret(value)) {
    return REDACTED_MARKER as unknown as T;
  }
  return value;
}

/** Recursively lists dotted paths whose key or value looks like forbidden/secret content. */
export function findForbiddenPaths(value: unknown, path = '$', depth = 0): string[] {
  if (depth >= MAX_DEPTH) {
    return [];
  }
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      hits.push(...findForbiddenPaths(item, `${path}[${index}]`, depth + 1));
    });
    return hits;
  }
  if (value && typeof value === 'object') {
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = `${path}.${key}`;
      if (isForbiddenKey(key)) {
        hits.push(nextPath);
      }
      hits.push(...findForbiddenPaths(entryValue, nextPath, depth + 1));
    }
    return hits;
  }
  if (typeof value === 'string' && valueLooksSecret(value)) {
    hits.push(path);
  }
  return hits;
}

/** Redacts a value intended for the sanitized operation/audit store. */
export function redactForAudit<T>(value: T): T {
  return redact(value);
}

/** Redacts a value intended for MCP tool structured output. */
export function redactForOutput<T>(value: T): T {
  return redact(value);
}
