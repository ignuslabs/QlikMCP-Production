import type { CleanupRequest, CleanupResult } from '../../src/adapters/targetAdapter.js';
import type { TargetRef } from '../../src/domain/types.js';
import {
  cloudLiveProbeDiagnosticsCarrier,
  type CloudLiveProbeDiagnostics,
  type CloudLiveProbeDiagnosticsCarrier,
  type CloudLiveProbeStage,
} from './cloudProbeDiagnostics.js';

interface CleanupRequiredTarget {
  readonly objectId: string;
  readonly appId: string;
  readonly sheetId: string;
}

export class RetainedObjectCleanupRequiredError extends Error {
  readonly code = 'CLEANUP_NOT_CONFIRMED';
  readonly stage = 'cleanup' as const;
  readonly cleanupAttempted = true;
  readonly cleanupSucceeded = false;
  readonly cleanupRequired: CleanupRequiredTarget;

  constructor(
    readonly primaryCode: string,
    readonly primaryStage: CloudLiveProbeStage | undefined,
    target: Required<TargetRef>,
    objectId: string,
  ) {
    super('The live probe failed after persistence and automatic cleanup was not confirmed.');
    this.name = 'RetainedObjectCleanupRequiredError';
    this.cleanupRequired = { objectId, appId: target.appId, sheetId: target.sheetId };
    Object.setPrototypeOf(this, RetainedObjectCleanupRequiredError.prototype);
  }
}

export class RetainedObjectFailureAfterConfirmedCleanupError
  extends Error
  implements CloudLiveProbeDiagnosticsCarrier
{
  readonly cleanupAttempted = true;
  readonly cleanupSucceeded = true;
  readonly [cloudLiveProbeDiagnosticsCarrier]: CloudLiveProbeDiagnostics | undefined;

  constructor(
    readonly code: string,
    readonly stage: CloudLiveProbeStage | undefined,
    readonly diagnostics: CloudLiveProbeDiagnostics | undefined,
  ) {
    super('The live probe failed after persistence; exact-object cleanup was confirmed.');
    this.name = 'RetainedObjectFailureAfterConfirmedCleanupError';
    this[cloudLiveProbeDiagnosticsCarrier] = diagnostics;
    Object.setPrototypeOf(this, RetainedObjectFailureAfterConfirmedCleanupError.prototype);
  }
}

export async function preserveFailureAfterCleanup(params: {
  readonly primaryError: unknown;
  readonly primaryCode: string;
  readonly primaryStage?: CloudLiveProbeStage;
  readonly primaryDiagnostics?: CloudLiveProbeDiagnostics;
  readonly target: Required<TargetRef>;
  readonly objectId: string;
  readonly sheetAttachmentId?: string;
  readonly cleanup: (request: CleanupRequest) => Promise<CleanupResult>;
}): Promise<never> {
  let cleanupConfirmed: boolean;
  try {
    const cleanup = await params.cleanup({
      target: params.target,
      objectId: params.objectId,
      ...(params.sheetAttachmentId ? { sheetAttachmentId: params.sheetAttachmentId } : {}),
    });
    cleanupConfirmed = cleanup.outcome === 'cleanup-complete';
  } catch {
    cleanupConfirmed = false;
  }

  if (!cleanupConfirmed) {
    throw new RetainedObjectCleanupRequiredError(
      params.primaryCode,
      params.primaryStage,
      params.target,
      params.objectId,
    );
  }
  throw new RetainedObjectFailureAfterConfirmedCleanupError(
    params.primaryCode,
    params.primaryStage,
    params.primaryDiagnostics,
  );
}
