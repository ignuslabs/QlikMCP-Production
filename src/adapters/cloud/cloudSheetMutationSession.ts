import { createError } from '../../domain/errors.js';
import type { ActorContext, TargetRef } from '../../domain/types.js';
import type { SheetMutationScope, SheetMutationWriter } from '../targetAdapter.js';
import type { CloudSdkAppSession } from './qlikApiCloudClient.js';

const DEFAULT_MUTATION_TIMEOUT_MS = 120_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

export interface CloudSheetMutationLease {
  readonly scope: SheetMutationScope;
  readonly session: CloudSdkAppSession;
  assertActive(): void;
  isActive(): boolean;
}

function uncertain() {
  return createError('IDEMPOTENCY_CONFLICT', {
    message:
      'The native sheet attempt did not finish with a confirmed session close. Reconcile its saved state before retrying.',
    details: { outcome: 'uncertain' },
  });
}

function boundedTimeout(requested: number | undefined, fallback: number): number {
  return requested !== undefined && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, fallback)
    : fallback;
}

async function closeWithin(session: CloudSdkAppSession, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => session.close()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(uncertain()), timeoutMs);
      }),
    ]);
  } catch {
    throw uncertain();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A single callback owns the socket. Every exit revokes its writer, including late continuations. */
export async function withCloudSheetMutationSession<T>(options: {
  readonly scope: SheetMutationScope;
  readonly openSession: () => Promise<CloudSdkAppSession>;
  readonly createWriter: (lease: CloudSheetMutationLease) => SheetMutationWriter;
  readonly run: (writer: SheetMutationWriter) => Promise<T>;
  readonly timeoutMs?: number;
  readonly closeTimeoutMs?: number;
}): Promise<T> {
  const scope: SheetMutationScope = Object.freeze({
    target: Object.freeze({ ...options.scope.target }),
    actor: Object.freeze({ ...options.scope.actor }),
    ...(options.scope.signal ? { signal: options.scope.signal } : {}),
  });
  if (scope.signal?.aborted) throw uncertain();
  const closeTimeoutMs = boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
  let active = true;
  let interrupted = false;
  let pendingCalls = 0;
  let session: CloudSdkAppSession | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!session) return Promise.resolve();
    closing ??= closeWithin(session, closeTimeoutMs);
    return closing;
  };
  const assertActive = (): void => {
    if (!active) throw uncertain();
  };
  let interrupt: () => void = () => undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    interrupt = () => {
      interrupted = true;
      active = false;
      // Close immediately to stop pending native calls; the exit path also awaits this promise.
      void close().catch(() => undefined);
      reject(uncertain());
    };
  });
  scope.signal?.addEventListener('abort', interrupt, { once: true });
  const timer = setTimeout(
    interrupt,
    boundedTimeout(options.timeoutMs, DEFAULT_MUTATION_TIMEOUT_MS),
  );

  const bindCall =
    <
      Request extends { readonly target: Required<TargetRef>; readonly actor?: ActorContext },
      Result,
    >(
      operation: (request: Request) => Promise<Result>,
    ): ((request: Request) => Promise<Result>) =>
    (request) => {
      const result = (async () => {
        assertActive();
        const copied = structuredClone(request);
        if (
          copied.target.connection !== scope.target.connection ||
          copied.target.appId !== scope.target.appId ||
          copied.target.sheetId !== scope.target.sheetId ||
          (copied.actor &&
            (copied.actor.actor !== scope.actor.actor ||
              copied.actor.hostClientId !== scope.actor.hostClientId))
        ) {
          throw createError('PERMISSION_DENIED', {
            message: 'The sheet writer is bound to one exact target and caller.',
          });
        }
        if (pendingCalls > 0) {
          throw createError('MALFORMED_REQUEST', {
            message: 'Native sheet writer operations must be awaited in order.',
          });
        }
        pendingCalls += 1;
        try {
          const value = await operation(copied);
          assertActive();
          return value;
        } finally {
          pendingCalls -= 1;
        }
      })();
      // A callback may escape or forget to await a call. Its rejection remains observable to
      // its caller, while this handler prevents an unhandled rejection after lease revocation.
      void result.catch(() => undefined);
      return result;
    };

  const attempt = (async () => {
    session = await options.openSession();
    if (!active) {
      // Opening cannot be cancelled by the SDK. A late socket is closed and never handed out.
      await close();
      throw uncertain();
    }
    const implementation = options.createWriter({
      scope,
      session,
      assertActive,
      isActive: () => active,
    });
    const writer: SheetMutationWriter = Object.freeze({
      ensureSheet: bindCall(implementation.ensureSheet.bind(implementation)),
      persistChart: bindCall(implementation.persistChart.bind(implementation)),
      attachChartToSheet: bindCall(implementation.attachChartToSheet.bind(implementation)),
      verifyChart: bindCall(implementation.verifyChart.bind(implementation)),
    });
    return options.run(writer);
  })();
  let outcome:
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  try {
    outcome = { ok: true, value: await Promise.race([attempt, interruption]) };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    active = false;
    clearTimeout(timer);
  }
  const unsettled = pendingCalls > 0;
  try {
    await close();
  } finally {
    scope.signal?.removeEventListener('abort', interrupt);
  }
  // Cleanup uncertainty takes precedence over a callback result, including a known failure.
  if (interrupted || unsettled) throw uncertain();
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
