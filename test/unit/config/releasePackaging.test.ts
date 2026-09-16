import {
  closeSync,
  copyFileSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function checkHygieneSnapshot(prepare: (directory: string) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), 'qlik-hygiene-test-'));
  try {
    const scannerPath = path.join(directory, 'scripts/package/checkRepositoryHygiene.mjs');
    mkdirSync(path.dirname(scannerPath), { recursive: true });
    for (const filename of ['checkRepositoryHygiene.mjs', 'privateMaterial.mjs']) {
      copyFileSync(
        path.join(repositoryRoot, 'scripts/package', filename),
        path.join(path.dirname(scannerPath), filename),
      );
    }
    prepare(directory);
    return spawnSync(process.execPath, [scannerPath], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('production release packaging', () => {
  it('declares a private executable artifact with every runtime asset', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      private: boolean;
      license: string;
      engines: { node: string };
      main?: string;
      bin: Record<string, string>;
      files: string[];
      scripts: Record<string, string>;
    };

    expect(packageJson.private).toBe(true);
    expect(packageJson.license).toBe('UNLICENSED');
    expect(packageJson.engines.node).toBe('>=22.23.2 <23');
    expect(packageJson.main).toBeUndefined();
    expect(packageJson.bin).toEqual({
      'qlik-ai-harness': 'dist/index.js',
      'qlik-ai-harness-agentcore': 'dist/agentcore/runtime.js',
    });
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        'dist/**/*.js',
        'config/*.example.json',
        'infra/aws/*.yaml',
        'scripts/**/*.mjs',
        'test/fixtures/**/*.json',
        '.env.example',
        'README.md',
        'SECURITY.md',
        'CHANGELOG.md',
      ]),
    );
    expect(packageJson.scripts.prepack).toContain('npm run build');
    expect(packageJson.scripts.check).toContain('npm run package:check');
    expect(read('src/index.ts')).toMatch(/^#!\/usr\/bin\/env node\n/u);
    expect(read('src/agentcore/runtime.ts')).toMatch(/^#!\/usr\/bin\/env node\n/u);
  });

  it('keeps AgentCore source trackable while ignoring root deployment output', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qlik-git-ignore-'));
    try {
      copyFileSync(path.join(repositoryRoot, '.gitignore'), path.join(directory, '.gitignore'));
      const initialized = spawnSync('git', ['init', '--quiet'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(initialized.status, initialized.stderr).toBe(0);
      const emptyGlobalIgnore = path.join(directory, '.git', 'empty-global-ignore');
      writeFileSync(emptyGlobalIgnore, '');

      const sourceFiles = [
        'src/agentcore/runtime.ts',
        'src/agentcore/state/index.ts',
        'scripts/agentcore/render-config.mjs',
        'test/unit/agentcore/dynamoState.test.ts',
      ];
      const deploymentFiles = ['agentcore/agentcore.json', 'agentcore/aws-targets.json'];
      for (const relativePath of [...sourceFiles, ...deploymentFiles]) {
        const absolutePath = path.join(directory, relativePath);
        mkdirSync(path.dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, '{}');
        const checked = spawnSync(
          'git',
          [
            '-c',
            `core.excludesFile=${emptyGlobalIgnore}`,
            'check-ignore',
            '--no-index',
            '--',
            relativePath,
          ],
          { cwd: directory, encoding: 'utf8', timeout: 10_000 },
        );
        const shouldBeIgnored = deploymentFiles.includes(relativePath);
        expect(checked.status, `${relativePath}: ${checked.stderr}`).toBe(shouldBeIgnored ? 0 : 1);
        expect(checked.stdout.trim()).toBe(shouldBeIgnored ? relativePath : '');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('only admits the inputs needed to build the runtime container', () => {
    const ignored = read('.dockerignore').split('\n');
    expect(ignored).toContain('**');
    const allowed = ignored.filter((line) => line.startsWith('!'));
    expect(allowed).toEqual([
      '!package.json',
      '!package-lock.json',
      '!.npmrc',
      '!tsconfig.json',
      '!tsconfig.build.json',
      '!Dockerfile',
      '!.dockerignore',
      '!src/',
      '!src/**/',
      '!src/**/*.ts',
      '!scripts/',
      '!scripts/package/',
      '!scripts/package/preparePackage.mjs',
      '!scripts/package/cleanDist.mjs',
      '!config/',
      '!config/connections.example.json',
      '!test/',
      '!test/fixtures/',
      '!test/fixtures/**/',
      '!test/fixtures/**/*.json',
    ]);
    expect(read('Dockerfile')).toContain('node:22.23.2-bookworm-slim@sha256:');
    expect(read('Dockerfile')).toContain('USER node');
    expect(read('Dockerfile')).toContain(
      'COPY --chown=node:node config/connections.example.json ./config/connections.example.json',
    );
    expect(read('Dockerfile')).not.toContain('COPY --chown=node:node config ./config');
    expect(read('Dockerfile')).toContain('CMD ["node", "dist/agentcore/runtime.js"]');
  });

  it('does not pack local credentials or historical evidence placed beside release sources', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qlik-pack-policy-'));
    try {
      copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(directory, 'package.json'));
      const privateFiles = [
        '.env',
        '.env.production',
        '.mcp.json',
        '.codex/config.toml',
        'config/connections.json',
        'config/management.json',
        'config/agentcore-deployment.json',
        'infra/aws/live.parameters.json',
        'agentcore/aws-targets.json',
        'docs/evidence/history.md',
        'docs/logs/capture.md',
        'examples/qlik-embed/.local/config.json',
      ];
      for (const relativePath of [
        ...privateFiles,
        'config/connections.example.json',
        'docs/management.md',
      ]) {
        const absolutePath = path.join(directory, relativePath);
        mkdirSync(path.dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, '{}');
      }
      const npmCli =
        process.env.npm_execpath ||
        path.resolve(
          path.dirname(process.execPath),
          process.platform === 'win32'
            ? 'node_modules/npm/bin/npm-cli.js'
            : '../lib/node_modules/npm/bin/npm-cli.js',
        );
      const packed = spawnSync(
        process.execPath,
        [npmCli, 'pack', '--dry-run', '--ignore-scripts', '--json'],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 15_000,
        },
      );
      expect(packed.status, packed.stderr).toBe(0);
      const report = JSON.parse(packed.stdout) as { files: { path: string }[] }[];
      const packedPaths = report[0]?.files.map((entry) => entry.path);
      expect(packedPaths).toContain('config/connections.example.json');
      expect(packedPaths).toContain('docs/management.md');
      for (const relativePath of privateFiles) expect(packedPaths).not.toContain(relativePath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps packaged fixture checks isolated from an ambient dotenv file and override settings', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qlik-smoke-env-'));
    try {
      const ambientDotenv = path.join(directory, '.env');
      writeFileSync(
        ambientDotenv,
        'QLIK_HARNESS_TARGET_MODE=cloud\nQLIK_CLOUD_OAUTH_CLIENT_SECRET=synthetic-private-value\n',
      );
      const program = `
        import { spawnSync } from 'node:child_process';
        import { sanitizedSmokeEnvironment } from './scripts/package/smokeEnvironment.mjs';
        const environment = sanitizedSmokeEnvironment(${JSON.stringify(directory)}, {
          ...process.env,
          QLIK_HARNESS_TARGET_MODE: 'cloud',
          DOTENV_CONFIG_PATH: ${JSON.stringify(ambientDotenv)},
          DOTENV_CONFIG_OVERRIDE: 'true',
          DOTENV_KEY: 'synthetic-key',
          NODE_OPTIONS: '--throw-deprecation',
        });
        const child = spawnSync(process.execPath, ['--import', 'dotenv/config', '--input-type=module', '-e',
          'process.stdout.write(JSON.stringify({mode: process.env.QLIK_HARNESS_TARGET_MODE, secret: process.env.QLIK_CLOUD_OAUTH_CLIENT_SECRET, key: process.env.DOTENV_KEY, nodeOptions: process.env.NODE_OPTIONS}))'
        ], { cwd: process.cwd(), env: environment, encoding: 'utf8' });
        process.stdout.write(child.stdout);
        process.stderr.write(child.stderr);
        process.exitCode = child.status;
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ mode: 'fixture' });
      expect(result.stdout + result.stderr).not.toContain('synthetic-private-value');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the tracked VS Code fallback configuration portable and role-scoped', () => {
    const vscode = read('.vscode/mcp.json');
    expect(vscode).toContain('${workspaceFolder}/scripts/mcp/start.mjs');
    expect(vscode).toContain('"--role", "requester"');
    expect(vscode).toContain('"--role", "reviewer"');
    expect(vscode).toContain('"--role", "verifier"');
    expect(vscode).not.toContain('QLIK_HARNESS_TARGET_MODE');
    expect(vscode).not.toMatch(/(?:[A-Za-z]:\\\\Users\\\\|\/Users\/)/u);
  });

  it('keeps raw diagnostic extensions aligned across ignore and hygiene gates', () => {
    const gitignore = read('.gitignore');
    const hygieneCheck = read('scripts/package/privateMaterial.mjs');
    for (const extension of [
      '.har',
      '.netlog',
      '.pcap',
      '.pcapng',
      '.saz',
      '.txtog',
      '.websocket',
    ]) {
      expect(gitignore).toContain(`*${extension}`);
      expect(hygieneCheck).toContain(extension.slice(1));
    }
    expect(gitignore).toContain('docs/logs/*');
    expect(gitignore).toContain('!docs/logs/README.md');
  });

  it.each([
    '.env.production',
    '.mcp.json',
    '.codex/config.toml',
    'config/connections.json',
    'config/management.json',
    'config/agentcore-deployment.json',
    'agentcore/aws-targets.json',
    'infra/aws/live.parameters.json',
    'docs/evidence/old-run.md',
    'artifacts/upload.json',
  ])(
    'rejects force-added local material at %s without needing a recognized secret',
    (relativePath) => {
      const result = checkHygieneSnapshot((directory) => {
        const absolutePath = path.join(directory, relativePath);
        mkdirSync(path.dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, '{}');
        const initialized = spawnSync('git', ['init', '--quiet'], { cwd: directory });
        expect(initialized.status).toBe(0);
        const staged = spawnSync('git', ['add', '--force', '.'], { cwd: directory });
        expect(staged.status).toBe(0);
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(relativePath);
      expect(result.stderr).toMatch(/private machine|local runtime/);
    },
  );

  it('skips a sparse binary recording larger than the whole-file read limit', () => {
    const result = checkHygieneSnapshot((directory) => {
      const recordingPath = path.join(directory, 'process.mov');
      writeFileSync(recordingPath, Buffer.from([0, 0, 0, 20]));
      const descriptor = openSync(recordingPath, 'r+');
      try {
        ftruncateSync(descriptor, 2 ** 31 + 1);
      } finally {
        closeSync(descriptor);
      }
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('no blocked material');
  });

  it('scans text past the binary-detection prefix without printing matched secrets', () => {
    const syntheticToken = `AKIA${'0'.repeat(16)}`;
    const result = checkHygieneSnapshot((directory) => {
      writeFileSync(path.join(directory, 'notes.md'), `${'a'.repeat(8192)}\n${syntheticToken}\n`);
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('notes.md: AWS access key');
    expect(result.stderr).not.toContain(syntheticToken);
  });

  it('fails clearly for oversized files without a binary prefix instead of skipping them', () => {
    const result = checkHygieneSnapshot((directory) => {
      const textPath = path.join(directory, 'oversized.txt');
      writeFileSync(textPath, 'a'.repeat(8192));
      const descriptor = openSync(textPath, 'r+');
      try {
        ftruncateSync(descriptor, 2 ** 31 + 1);
      } finally {
        closeSync(descriptor);
      }
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('oversized.txt: text candidate exceeds the bounded scan size');
    expect(result.stderr).not.toContain('ERR_FS_FILE_TOO_LARGE');
  });

  it('still rejects raw diagnostic artifacts even when their prefix is binary', () => {
    const result = checkHygieneSnapshot((directory) => {
      writeFileSync(path.join(directory, 'capture.har'), Buffer.from([0]));
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('capture.har: raw diagnostic or credential artifact extension');
  });
});
