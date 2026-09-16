import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const launcherSource = path.join(repoRoot, 'scripts', 'codex', 'run-node-with-secure-storage.sh');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const codexLauncher = readFileSync(
  path.join(repoRoot, 'scripts', 'codex', 'start-qlik-mcp.sh'),
  'utf8',
);
const posixIt = process.platform === 'win32' ? it.skip : it;

const storageNames = [
  'node-localstorage.json',
  'node-localstorage.json-wal',
  'node-localstorage.json-shm',
] as const;

interface LauncherFixture {
  fakeNodePath: string;
  fixtureRoot: string;
  launcherPath: string;
  repoPath: string;
  storageDirectory: string;
}

function createLauncherFixture(nodeVersion: string): LauncherFixture {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'qlik-secure-node-storage-'));
  const fixtureRepo = path.join(fixtureRoot, 'repo');
  const scriptsDirectory = path.join(fixtureRepo, 'scripts', 'codex');
  const launcherPath = path.join(scriptsDirectory, 'run-node-with-secure-storage.sh');
  const fakeNodePath = path.join(fixtureRoot, 'fake-node');

  mkdirSync(scriptsDirectory, { recursive: true });
  copyFileSync(launcherSource, launcherPath);
  chmodSync(launcherPath, 0o755);
  writeFileSync(
    fakeNodePath,
    `#!/bin/sh
if [ "\${1:-}" = '--version' ]; then
  printf '%s\\n' 'v${nodeVersion}'
  exit 0
fi
printf 'arg:%s\\n' "$@"
case "\${1:-}" in
  --localstorage-file=*)
    for state_file in node-localstorage.json node-localstorage.json-wal node-localstorage.json-shm; do
      : > ".qlik-ai-harness/$state_file"
    done
    ;;
esac
`,
    { mode: 0o755 },
  );

  return {
    fakeNodePath,
    fixtureRoot,
    launcherPath,
    repoPath: fixtureRepo,
    storageDirectory: path.join(fixtureRepo, '.qlik-ai-harness'),
  };
}

function runLauncher(fixture: LauncherFixture) {
  return spawnSync(
    fixture.launcherPath,
    ['--node', fixture.fakeNodePath, 'fixture-entrypoint.mjs', '--marker'],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
}

function permissions(filePath: string): number {
  return lstatSync(filePath).mode & 0o777;
}

describe('secure Node storage launcher', () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  function trackedFixture(nodeVersion: string): LauncherFixture {
    const fixture = createLauncherFixture(nodeVersion);
    fixtureRoots.push(fixture.fixtureRoot);
    return fixture;
  }

  it('routes every credentialed Cloud script through the portable helper', () => {
    const cloudScripts = Object.entries(packageJson.scripts).filter(([name]) =>
      name.startsWith('test:live:cloud'),
    );

    expect(cloudScripts).toHaveLength(6);
    for (const [, command] of cloudScripts) {
      expect(command).toContain('node scripts/mcp/run-node.mjs');
      expect(command).not.toContain('NODE_OPTIONS');
      expect(command).not.toMatch(/mkdir\s+-p\s+\.qlik-ai-harness/);
      expect(command).not.toMatch(/^QLIK_[A-Z_]+=/u);
    }
    expect(codexLauncher).toContain('export QLIK_HARNESS_MCP_ROLE="$role"');
  });

  posixIt('keeps the existing Codex shell launcher compatible with secure local storage', () => {
    expect(codexLauncher).toContain(
      'exec "$secure_storage_launcher" --node "$node_binary" "$entrypoint"',
    );
    expect(permissions(launcherSource) & 0o111).not.toBe(0);
  });

  posixIt(
    'creates the state directory and SQLite files with owner-only permissions on supported Node 22',
    () => {
      const fixture = trackedFixture('22.23.2');
      const result = runLauncher(fixture);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        'arg:--localstorage-file=.qlik-ai-harness/node-localstorage.json\n' +
          'arg:fixture-entrypoint.mjs\n' +
          'arg:--marker\n',
      );
      expect(permissions(fixture.storageDirectory)).toBe(0o700);
      for (const storageName of storageNames) {
        expect(permissions(path.join(fixture.storageDirectory, storageName))).toBe(0o600);
      }
    },
  );

  posixIt('repairs permissive existing state and SQLite sidecar file modes before launch', () => {
    for (const nodeVersion of ['22.23.2', '22.24.0']) {
      const fixture = trackedFixture(nodeVersion);
      mkdirSync(fixture.storageDirectory, { mode: 0o755 });
      for (const storageName of storageNames) {
        const storagePath = path.join(fixture.storageDirectory, storageName);
        writeFileSync(storagePath, 'fixture', { mode: 0o644 });
        chmodSync(storagePath, 0o644);
      }

      const result = runLauncher(fixture);

      expect(result.status).toBe(0);
      expect(permissions(fixture.storageDirectory)).toBe(0o700);
      for (const storageName of storageNames) {
        expect(permissions(path.join(fixture.storageDirectory, storageName))).toBe(0o600);
      }
    }
  });

  posixIt('rejects unsafe existing state before launch', () => {
    const fixture = trackedFixture('22.23.2');
    const symlinkTarget = path.join(path.dirname(fixture.repoPath), 'outside-state');
    mkdirSync(fixture.storageDirectory, { mode: 0o700 });
    writeFileSync(symlinkTarget, 'outside');
    symlinkSync(symlinkTarget, path.join(fixture.storageDirectory, storageNames[0]));

    const result = runLauncher(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('must be a regular, non-symlink file');
  });

  posixIt('rejects a symlink at every local state file path before starting Node', () => {
    for (const storageName of storageNames) {
      const fixture = trackedFixture('22.24.0');
      const symlinkTarget = path.join(path.dirname(fixture.repoPath), 'outside-state');
      mkdirSync(fixture.storageDirectory, { mode: 0o700 });
      writeFileSync(symlinkTarget, 'outside');
      symlinkSync(symlinkTarget, path.join(fixture.storageDirectory, storageName));

      const result = runLauncher(fixture);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('must be a regular, non-symlink file');
    }
  });

  posixIt('rejects a symlink in place of the repository-local state directory', () => {
    const fixture = trackedFixture('22.24.0');
    const outsideDirectory = path.join(path.dirname(fixture.repoPath), 'outside-directory');
    mkdirSync(outsideDirectory);
    symlinkSync(outsideDirectory, fixture.storageDirectory);

    const result = runLauncher(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('state directory must not be a symbolic link');
  });

  posixIt('rejects runtimes outside the declared supported range', () => {
    for (const nodeVersion of [
      '19.22.0',
      '20.19.0',
      '21.7.3',
      '22.12.0',
      '22.23.1',
      '23.0.0',
      '24.0.0',
    ]) {
      const fixture = trackedFixture(nodeVersion);
      const result = runLauncher(fixture);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Node.js 22.23.2');
    }
  });
});
