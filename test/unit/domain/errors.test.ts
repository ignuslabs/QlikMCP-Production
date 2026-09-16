import { describe, expect, it } from 'vitest';
import {
  createError,
  HarnessError,
  isHarnessError,
  toSafeUnexpectedError,
} from '../../../src/domain/errors.js';

describe('errors', () => {
  it('builds the canonical envelope for a fixture-defined typed failure', () => {
    const error = createError('SENSITIVE_FIELD', {
      details: { excludedMetadataId: 'field-customer-email' },
    });
    expect(error).toBeInstanceOf(HarnessError);
    expect(error.toEnvelope()).toEqual({
      code: 'SENSITIVE_FIELD',
      category: 'policy',
      retryable: false,
      stage: 'planning',
      message: 'The requested field is excluded by sensitive-data policy.',
      details: { excludedMetadataId: 'field-customer-email' },
    });
  });

  it('matches the exact code/category/retryable/stage for every fixture-defined typed failure', () => {
    const expectations: Array<[string, string, boolean, string]> = [
      ['EMPTY_CATALOG', 'catalog', false, 'discovery'],
      ['AMBIGUOUS_FIELD', 'validation', false, 'planning'],
      ['SENSITIVE_FIELD', 'policy', false, 'planning'],
      ['PERMISSION_DENIED', 'authorization', false, 'apply'],
      ['CAPACITY_EXHAUSTED', 'capacity', true, 'preview'],
      ['TRANSIENT_UNAVAILABLE', 'transient', true, 'preview'],
      ['RATE_LIMITED', 'rate-limit', true, 'discovery'],
      ['NOT_FOUND', 'not-found', false, 'discovery'],
      ['MALFORMED_REQUEST', 'validation', false, 'request'],
      ['APPROVAL_EXPIRED', 'approval', false, 'apply'],
      ['APPROVAL_REPLAYED', 'approval', false, 'apply'],
      ['APPROVAL_ACTOR_MISMATCH', 'approval', false, 'apply'],
      ['APPROVAL_TARGET_MISMATCH', 'approval', false, 'apply'],
      ['APPROVAL_PLAN_HASH_MISMATCH', 'approval', false, 'apply'],
      ['IDEMPOTENCY_CONFLICT', 'idempotency', false, 'apply'],
      ['UNKNOWN_FIELD', 'validation', false, 'planning'],
      ['UNSUPPORTED_CHART', 'validation', false, 'planning'],
      ['DISALLOWED_EXPRESSION', 'policy', false, 'planning'],
      ['INVALID_DIMENSION', 'validation', false, 'planning'],
      ['INVALID_MEASURE', 'validation', false, 'planning'],
      ['PARTIAL_APPLY', 'mutation', false, 'apply'],
    ];
    for (const [code, category, retryable, stage] of expectations) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const error = createError(code as any);
      expect(error.code, code).toBe(code);
      expect(error.category, code).toBe(category);
      expect(error.retryable, code).toBe(retryable);
      expect(error.stage, code).toBe(stage);
    }
  });

  it('attaches retryAfterSeconds for retryable capacity/transient/rate-limit failures', () => {
    expect(createError('CAPACITY_EXHAUSTED').retryAfterSeconds).toBe(30);
    expect(createError('TRANSIENT_UNAVAILABLE').retryAfterSeconds).toBe(5);
    expect(createError('RATE_LIMITED').retryAfterSeconds).toBe(15);
  });

  it('refuses to attach a forbidden detail key', () => {
    expect(() => createError('PERMISSION_DENIED', { details: { password: 'hunter2' } })).toThrow(
      /forbidden error detail key/,
    );
  });

  it('isHarnessError narrows correctly and toSafeUnexpectedError wraps unknown errors', () => {
    const harnessError = createError('NOT_FOUND');
    expect(isHarnessError(harnessError)).toBe(true);
    expect(isHarnessError(new Error('plain'))).toBe(false);

    const wrapped = toSafeUnexpectedError(new Error('boom'));
    expect(wrapped.code).toBe('INTERNAL_ERROR');
    expect(wrapped.category).toBe('internal');
    expect(wrapped.retryable).toBe(false);

    const passthrough = toSafeUnexpectedError(harnessError);
    expect(passthrough).toBe(harnessError);
  });
});
