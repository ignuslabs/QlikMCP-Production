import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Locates the repository root by walking up from this module's own
 * directory until a directory containing both `package.json` and
 * `test/fixtures` is found. Works identically whether the code is running
 * from `src` (via `tsx`/vitest) or from a compiled `dist` (same relative
 * depth from the project root in both layouts).
 */
export function resolveRepoRoot(startDir?: string): string {
  let current = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (
      existsSync(path.join(current, 'package.json')) &&
      existsSync(path.join(current, 'test', 'fixtures'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(
    'Unable to locate the QlikAIHarness repository root (package.json + test/fixtures not found).',
  );
}

export function resolveFixturesDir(): string {
  return process.env.QLIK_HARNESS_FIXTURES_DIR ?? path.join(resolveRepoRoot(), 'test', 'fixtures');
}

export function resolveConfigDir(): string {
  return process.env.QLIK_HARNESS_CONFIG_DIR ?? path.join(resolveRepoRoot(), 'config');
}
