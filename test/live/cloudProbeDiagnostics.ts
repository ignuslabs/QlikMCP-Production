export type CloudLiveProbeStage =
  | 'configuration'
  | 'readiness'
  | 'discovery'
  | 'catalog'
  | 'compile'
  | 'preview-create'
  | 'preview-validate'
  | 'preview-dispose'
  | 'approval'
  | 'persist'
  | 'replay'
  | 'retained-attachment'
  | 'retained-verification'
  | 'retained-discovery'
  | 'retained-contract'
  | 'cleanup';

export type CloudLiveProbeFailureCode =
  | 'ENGINE_LAYOUT_CONTRACT_FAILED'
  | 'PERSISTED_OBJECT_NOT_FOUND'
  | 'PERSISTED_OBJECT_VERIFICATION_FAILED'
  | 'PERSISTED_OBJECT_CONTRACT_MISMATCH'
  | 'CLEANUP_NOT_CONFIRMED';

export type CloudLiveProbeDiagnostics = Readonly<
  Record<string, string | number | boolean | readonly string[]>
>;

export const cloudLiveProbeDiagnosticsCarrier = Symbol('cloudLiveProbeDiagnosticsCarrier');

export interface CloudLiveProbeDiagnosticsCarrier {
  readonly [cloudLiveProbeDiagnosticsCarrier]: CloudLiveProbeDiagnostics | undefined;
}

/** A data-free, stage-specific failure used only by explicit live probes. */
export class CloudLiveProbeError extends Error {
  constructor(
    readonly code: CloudLiveProbeFailureCode,
    readonly stage: CloudLiveProbeStage,
    readonly diagnostics: CloudLiveProbeDiagnostics,
    message: string,
  ) {
    super(message);
    this.name = 'CloudLiveProbeError';
    Object.setPrototypeOf(this, CloudLiveProbeError.prototype);
  }
}

export function cloudLiveProbeError(
  code: Exclude<CloudLiveProbeFailureCode, 'CLEANUP_NOT_CONFIRMED'>,
  stage: CloudLiveProbeStage,
  diagnostics: CloudLiveProbeDiagnostics,
  message: string,
): CloudLiveProbeError {
  return new CloudLiveProbeError(code, stage, diagnostics, message);
}

export function liveProbeStage(error: unknown): CloudLiveProbeStage | undefined {
  if (error instanceof CloudLiveProbeError) return error.stage;
  if (error && typeof error === 'object') {
    const stage = (error as { readonly stage?: unknown }).stage;
    if (typeof stage === 'string' && /^[a-z][a-z-]{1,40}$/.test(stage)) {
      return stage as CloudLiveProbeStage;
    }
  }
  return undefined;
}

export function liveProbeDiagnostics(error: unknown): CloudLiveProbeDiagnostics | undefined {
  if (error instanceof CloudLiveProbeError) return error.diagnostics;
  if (error instanceof Error && cloudLiveProbeDiagnosticsCarrier in error) {
    return (error as CloudLiveProbeDiagnosticsCarrier)[cloudLiveProbeDiagnosticsCarrier];
  }
  return undefined;
}
