import { rootLogger, type Logger } from '../../src/logging/logger.js';
import type { CloudLiveProbeStage } from './cloudProbeDiagnostics.js';

function sanitizedCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  }
  return 'LIVE_CLOUD_PROBE_FAILED';
}

export interface CloudLiveReporter {
  stage<T>(
    stage: CloudLiveProbeStage,
    operation: () => Promise<T> | T,
    completedContext?: (result: T) => Record<string, unknown>,
  ): Promise<T>;
  debug(stage: CloudLiveProbeStage, context: Record<string, unknown>): void;
  failureStage(error: unknown): CloudLiveProbeStage | undefined;
  terminal(code: string, stage?: CloudLiveProbeStage, context?: Record<string, unknown>): void;
}

/** JSONL progress reporter. It uses the redacting harness logger and never writes stdout. */
export function createCloudLiveReporter(
  runKind: 'readiness-probe' | 'visualization-matrix' | 'retained-cleanup',
  logger: Logger = rootLogger,
): CloudLiveReporter {
  const failureStages = new WeakMap<object, CloudLiveProbeStage>();
  const liveLogger = logger.child({
    component: 'qlik-cloud-live',
    kind: 'live-progress',
    runKind,
  });
  return {
    async stage<T>(
      stage: CloudLiveProbeStage,
      operation: () => Promise<T> | T,
      completedContext?: (result: T) => Record<string, unknown>,
    ): Promise<T> {
      const started = Date.now();
      liveLogger.info('Live stage started.', { stage });
      try {
        const result = await operation();
        liveLogger.info('Live stage completed.', {
          stage,
          durationMilliseconds: Date.now() - started,
        });
        if (completedContext) {
          liveLogger.debug('Live stage diagnostics.', {
            stage,
            ...completedContext(result),
          });
        }
        return result;
      } catch (error) {
        if (error && typeof error === 'object') failureStages.set(error, stage);
        liveLogger.error('Live stage failed.', {
          stage,
          code: sanitizedCode(error),
          durationMilliseconds: Date.now() - started,
        });
        throw error;
      }
    },
    debug(stage, context): void {
      liveLogger.debug('Live stage diagnostics.', { stage, ...context });
    },
    failureStage(error): CloudLiveProbeStage | undefined {
      return error && typeof error === 'object' ? failureStages.get(error) : undefined;
    },
    terminal(code, stage, context): void {
      liveLogger.error('Live run failed.', {
        code,
        ...(stage ? { stage } : {}),
        ...(context ?? {}),
      });
    },
  };
}
