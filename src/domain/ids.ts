import { randomUUID, createHash } from 'node:crypto';

/**
 * Deterministically stringifies a JSON-serializable value with object keys
 * sorted recursively, so semantically-equivalent inputs always produce the
 * same string (and therefore the same hash) regardless of key order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      sorted[key] = sortKeysDeep(entryValue);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Computes a deterministic `sha256:<hex>` plan hash from a canonical, JSON-serializable input. */
export function computePlanHash(canonicalInput: unknown): string {
  return `sha256:${sha256Hex(stableStringify(canonicalInput))}`;
}

export function generateOperationId(prefix = 'operation'): string {
  return `${prefix}-${randomUUID()}`;
}

export function generateApprovalToken(): string {
  return `approval-${randomUUID()}`;
}

export function generateApprovalRequestId(): string {
  return `approval-request-${randomUUID()}`;
}

export function generateCorrelationId(): string {
  return `corr-${randomUUID()}`;
}

export function generateObjectId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
