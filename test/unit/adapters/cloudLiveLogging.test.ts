import { describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/logging/logger.js';
import { createCloudLiveReporter } from '../../live/cloudLiveLogging.js';

interface CapturedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly context: Record<string, unknown> | undefined;
}

function capturingLogger(events: CapturedLog[], bindings: Record<string, unknown> = {}): Logger {
  const capture =
    (level: CapturedLog['level']) =>
    (message: string, context?: Record<string, unknown>): void => {
      events.push({ level, message, context: { ...bindings, ...(context ?? {}) } });
    };
  return {
    debug: capture('debug'),
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    child: (childBindings) => capturingLogger(events, { ...bindings, ...childBindings }),
  };
}

describe('Cloud live JSONL reporter', () => {
  it('emits deterministic stage start, completion, and debug diagnostics', async () => {
    const events: CapturedLog[] = [];
    const reporter = createCloudLiveReporter('visualization-matrix', capturingLogger(events));

    await expect(
      reporter.stage(
        'preview-validate',
        async () => ({ rows: 4 }),
        (result) => ({
          returnedRowCount: result.rows,
          rawDataIncluded: false,
        }),
      ),
    ).resolves.toEqual({ rows: 4 });

    expect(events.map(({ level, message }) => ({ level, message }))).toEqual([
      { level: 'info', message: 'Live stage started.' },
      { level: 'info', message: 'Live stage completed.' },
      { level: 'debug', message: 'Live stage diagnostics.' },
    ]);
    expect(events[2]?.context).toMatchObject({
      kind: 'live-progress',
      runKind: 'visualization-matrix',
      stage: 'preview-validate',
      returnedRowCount: 4,
      rawDataIncluded: false,
    });
  });

  it('emits a fixed failure code without serializing an exception message', async () => {
    const events: CapturedLog[] = [];
    const reporter = createCloudLiveReporter('readiness-probe', capturingLogger(events));
    const failure = Object.assign(new Error('provider secret response'), {
      code: 'PERSISTED_OBJECT_CONTRACT_MISMATCH',
    });

    await expect(
      reporter.stage('retained-contract', async () => Promise.reject(failure)),
    ).rejects.toBe(failure);

    expect(events.at(-1)).toMatchObject({
      level: 'error',
      message: 'Live stage failed.',
      context: {
        stage: 'retained-contract',
        code: 'PERSISTED_OBJECT_CONTRACT_MISMATCH',
      },
    });
    expect(JSON.stringify(events)).not.toContain('provider secret response');
    expect(reporter.failureStage(failure)).toBe('retained-contract');
  });

  it('preserves the active live stage over a conflicting provider stage', async () => {
    const events: CapturedLog[] = [];
    const reporter = createCloudLiveReporter('visualization-matrix', capturingLogger(events));
    const failure = Object.assign(new Error('provider failure'), {
      code: 'TRANSIENT_UNAVAILABLE',
      stage: 'preview',
    });

    await expect(reporter.stage('persist', async () => Promise.reject(failure))).rejects.toBe(
      failure,
    );

    expect(reporter.failureStage(failure)).toBe('persist');
  });
});
