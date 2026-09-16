import { existsSync } from 'node:fs';
import { createError } from '../../src/domain/errors.js';

export function assertRetainedManifestSlotAvailable(
  manifestPath: string,
  manifestExists: (path: string) => boolean = existsSync,
): void {
  if (!manifestExists(manifestPath)) return;
  throw createError('NOT_CONFIGURED', {
    message:
      'A retained-object manifest already exists; run cleanup or reconcile before another retain.',
  });
}
