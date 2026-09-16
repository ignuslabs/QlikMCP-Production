import { isForbiddenKey } from './redaction.js';

/**
 * Typed, sanitized error taxonomy for the Qlik AI Harness.
 *
 * The canonical set of codes below matches the shared operation contract in
 * `test/fixtures/operations.json` (`operationContract.typedFailures`) exactly
 * (code, category, retryable, stage, message). A small number of additional
 * codes are defined for conditions the fixture contract does not enumerate
 * (for example a missing plan or approval record); they follow the identical
 * envelope shape and are clearly marked as harness extensions below.
 *
 * Every error carries only sanitized, bounded data. Never attach a secret,
 * token, certificate, private key, header, QIX handle, raw property tree, or
 * unrestricted data value to a HarnessError's `details`.
 */

export type ErrorCategory =
  | 'catalog'
  | 'validation'
  | 'policy'
  | 'authorization'
  | 'capacity'
  | 'transient'
  | 'rate-limit'
  | 'not-found'
  | 'approval'
  | 'idempotency'
  | 'mutation'
  | 'internal';

export type ErrorStage =
  'request' | 'discovery' | 'planning' | 'preview' | 'approval' | 'apply' | 'operation';

/** Bounded, sanitized context attached to an error. Keep this small and non-sensitive. */
export type SafeErrorDetails = Readonly<
  Record<string, string | number | boolean | readonly string[]>
>;

export interface ErrorEnvelope {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly stage: ErrorStage;
  readonly message: string;
  readonly retryAfterSeconds?: number;
  readonly details?: SafeErrorDetails;
}

export class HarnessError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly stage: ErrorStage;
  readonly retryAfterSeconds: number | undefined;
  readonly details: SafeErrorDetails | undefined;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = 'HarnessError';
    this.code = envelope.code;
    this.category = envelope.category;
    this.retryable = envelope.retryable;
    this.stage = envelope.stage;
    this.retryAfterSeconds = envelope.retryAfterSeconds;
    this.details = envelope.details ? assertSafeDetails(envelope.details) : undefined;
    Object.setPrototypeOf(this, HarnessError.prototype);
  }

  /** A plain, sanitized envelope safe to store in audit records or return to a caller. */
  toEnvelope(): ErrorEnvelope {
    return {
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      stage: this.stage,
      message: this.message,
      ...(this.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: this.retryAfterSeconds }
        : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

function assertSafeDetails(details: SafeErrorDetails): SafeErrorDetails {
  for (const key of Object.keys(details)) {
    if (isForbiddenKey(key)) {
      throw new Error(`Refusing to attach forbidden error detail key "${key}"`);
    }
  }
  return details;
}

type TypedFailureTemplate = Omit<ErrorEnvelope, 'message' | 'details'> & { message: string };

/**
 * Canonical typed-failure templates. Codes 1-21 mirror
 * `test/fixtures/operations.json#/operationContract/typedFailures` exactly.
 * Codes below the divider are harness extensions with the same envelope shape.
 */
const TYPED_FAILURES = {
  EMPTY_CATALOG: {
    code: 'EMPTY_CATALOG',
    category: 'catalog',
    retryable: false,
    stage: 'discovery',
    message: 'No policy-visible fields, master items, or sheets are available.',
  },
  AMBIGUOUS_FIELD: {
    code: 'AMBIGUOUS_FIELD',
    category: 'validation',
    retryable: false,
    stage: 'planning',
    message: 'The requested display label resolves to more than one authorized field.',
  },
  SENSITIVE_FIELD: {
    code: 'SENSITIVE_FIELD',
    category: 'policy',
    retryable: false,
    stage: 'planning',
    message: 'The requested field is excluded by sensitive-data policy.',
  },
  PERMISSION_DENIED: {
    code: 'PERMISSION_DENIED',
    category: 'authorization',
    retryable: false,
    stage: 'apply',
    message: 'The effective identity is not authorized for this operation.',
  },
  CAPACITY_EXHAUSTED: {
    code: 'CAPACITY_EXHAUSTED',
    category: 'capacity',
    retryable: true,
    stage: 'preview',
    retryAfterSeconds: 30,
    message: 'The target cannot accept another preview session within its capacity policy.',
  },
  TRANSIENT_UNAVAILABLE: {
    code: 'TRANSIENT_UNAVAILABLE',
    category: 'transient',
    retryable: true,
    stage: 'preview',
    retryAfterSeconds: 5,
    message: 'The target session is temporarily unavailable.',
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    category: 'rate-limit',
    retryable: true,
    stage: 'discovery',
    retryAfterSeconds: 15,
    message: 'The target request limit was reached; retry after the supplied delay.',
  },
  NOT_FOUND: {
    code: 'NOT_FOUND',
    category: 'not-found',
    retryable: false,
    stage: 'discovery',
    message: 'The requested policy-visible target or resource was not found.',
  },
  MALFORMED_REQUEST: {
    code: 'MALFORMED_REQUEST',
    category: 'validation',
    retryable: false,
    stage: 'request',
    message: 'The request does not match the supported typed operation contract.',
  },
  APPROVAL_EXPIRED: {
    code: 'APPROVAL_EXPIRED',
    category: 'approval',
    retryable: false,
    stage: 'apply',
    message: 'The approval is past its expiry and cannot authorize a mutation.',
  },
  APPROVAL_REPLAYED: {
    code: 'APPROVAL_REPLAYED',
    category: 'approval',
    retryable: false,
    stage: 'apply',
    message: 'The single-use approval has already been consumed.',
  },
  APPROVAL_ACTOR_MISMATCH: {
    code: 'APPROVAL_ACTOR_MISMATCH',
    category: 'approval',
    retryable: false,
    stage: 'apply',
    message: 'The approval actor does not match the applying actor.',
  },
  APPROVAL_TARGET_MISMATCH: {
    code: 'APPROVAL_TARGET_MISMATCH',
    category: 'approval',
    retryable: false,
    stage: 'apply',
    message: 'The approval target does not match the requested connection, app, or sheet.',
  },
  APPROVAL_PLAN_HASH_MISMATCH: {
    code: 'APPROVAL_PLAN_HASH_MISMATCH',
    category: 'approval',
    retryable: false,
    stage: 'apply',
    message: 'The approval plan hash does not match the requested plan.',
  },
  IDEMPOTENCY_CONFLICT: {
    code: 'IDEMPOTENCY_CONFLICT',
    category: 'idempotency',
    retryable: false,
    stage: 'apply',
    message: 'The idempotency key is already bound to a different actor, target, or plan.',
  },
  UNKNOWN_FIELD: {
    code: 'UNKNOWN_FIELD',
    category: 'validation',
    retryable: false,
    stage: 'planning',
    message: 'The requested field is not present in the authorized semantic catalog.',
  },
  UNSUPPORTED_CHART: {
    code: 'UNSUPPORTED_CHART',
    category: 'validation',
    retryable: false,
    stage: 'planning',
    message: 'The requested chart type is not enabled for this target catalog.',
  },
  DISALLOWED_EXPRESSION: {
    code: 'DISALLOWED_EXPRESSION',
    category: 'policy',
    retryable: false,
    stage: 'planning',
    message:
      'The requested expression is outside the approved aggregation and expression allowlist.',
  },
  INVALID_DIMENSION: {
    code: 'INVALID_DIMENSION',
    category: 'validation',
    retryable: false,
    stage: 'planning',
    message: 'The requested dimension is not a valid dimension for the selected chart plan.',
  },
  INVALID_MEASURE: {
    code: 'INVALID_MEASURE',
    category: 'validation',
    retryable: false,
    stage: 'planning',
    message: 'The requested measure is not a valid measure for the selected chart plan.',
  },
  PARTIAL_APPLY: {
    code: 'PARTIAL_APPLY',
    category: 'mutation',
    retryable: false,
    stage: 'apply',
    message: 'A persistent object was created but the complete apply workflow did not finish.',
  },
  // --- Harness extensions (same envelope shape; not present in the fixture list) ---
  PLAN_NOT_FOUND: {
    code: 'PLAN_NOT_FOUND',
    category: 'not-found',
    retryable: false,
    stage: 'apply',
    message: 'The requested plan hash does not match a stored, unexpired plan.',
  },
  PLAN_STALE: {
    code: 'PLAN_STALE',
    category: 'validation',
    retryable: false,
    stage: 'apply',
    message: 'The plan has expired and must be regenerated before it can be previewed or applied.',
  },
  APPROVAL_NOT_FOUND: {
    code: 'APPROVAL_NOT_FOUND',
    category: 'approval',
    retryable: false,
    stage: 'apply',
    message: 'The requested approval token does not match a known approval record.',
  },
  APPROVAL_REQUEST_NOT_FOUND: {
    code: 'APPROVAL_REQUEST_NOT_FOUND',
    category: 'approval',
    retryable: false,
    stage: 'approval',
    message: 'The approval request was not found.',
  },
  APPROVAL_REQUEST_EXPIRED: {
    code: 'APPROVAL_REQUEST_EXPIRED',
    category: 'approval',
    retryable: false,
    stage: 'approval',
    message: 'The pending approval request has expired and can no longer be decided.',
  },
  APPROVAL_ALREADY_DECIDED: {
    code: 'APPROVAL_ALREADY_DECIDED',
    category: 'approval',
    retryable: false,
    stage: 'approval',
    message: 'The approval request already has a terminal decision.',
  },
  NOT_CONFIGURED: {
    code: 'NOT_CONFIGURED',
    category: 'not-found',
    retryable: false,
    stage: 'discovery',
    message: 'The target adapter has no readiness evidence and performs no live operations.',
  },
  INVALID_CHART_CONFIGURATION: {
    code: 'INVALID_CHART_CONFIGURATION',
    category: 'validation',
    retryable: false,
    stage: 'planning',
    message:
      'The requested dimension/measure/target combination is not valid for the selected chart type.',
  },
  OPERATION_ACCESS_DENIED: {
    code: 'OPERATION_ACCESS_DENIED',
    category: 'authorization',
    retryable: false,
    stage: 'operation',
    message: 'The operation record is not owned by the requesting actor.',
  },
  PREVIEW_TIMEOUT: {
    code: 'PREVIEW_TIMEOUT',
    category: 'transient',
    retryable: true,
    stage: 'preview',
    message: 'The bounded preview deadline expired.',
  },
  OPERATION_CANCELLED: {
    code: 'OPERATION_CANCELLED',
    category: 'transient',
    retryable: false,
    stage: 'preview',
    message: 'The preview was cancelled by the caller.',
  },
} as const satisfies Record<string, TypedFailureTemplate>;

export type TypedFailureCode = keyof typeof TYPED_FAILURES;

/** Builds a HarnessError from a canonical typed-failure template plus optional overrides. */
export function createError(
  code: TypedFailureCode,
  overrides?: { message?: string; details?: SafeErrorDetails; retryAfterSeconds?: number },
): HarnessError {
  const template = TYPED_FAILURES[code];
  return new HarnessError({
    ...template,
    message: overrides?.message ?? template.message,
    ...(overrides?.details ? { details: overrides.details } : {}),
    ...(overrides?.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: overrides.retryAfterSeconds }
      : {}),
  });
}

export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof HarnessError;
}

/** Converts any thrown value into a safe, typed internal-error envelope for defense in depth. */
export function toSafeUnexpectedError(value: unknown): HarnessError {
  if (isHarnessError(value)) {
    return value;
  }
  return new HarnessError({
    code: 'INTERNAL_ERROR',
    category: 'internal',
    retryable: false,
    stage: 'operation',
    message: value instanceof Error ? value.message : 'An unexpected internal error occurred.',
  });
}
