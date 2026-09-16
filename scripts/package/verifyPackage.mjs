#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { privateMaterialReason } from './privateMaterial.mjs';
import { sanitizedSmokeEnvironment } from './smokeEnvironment.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const requiredFiles = [
  '.env.example',
  'CHANGELOG.md',
  'README.md',
  'SECURITY.md',
  'config/README.md',
  'config/agentcore-deployment.example.json',
  'config/connections.example.json',
  'config/management.example.json',
  'docs/management.md',
  'docs/runbooks/production-operations.md',
  'docs/provenance.md',
  'scripts/package/checkMarkdownLinks.mjs',
  'dist/management/context.js',
  'scripts/mcp/uploadDataset.mjs',
  'dist/agentcore/runtime.js',
  'dist/index.js',
  'package.json',
  'Dockerfile',
  'infra/aws/foundation.yaml',
  'scripts/agentcore/render-config.mjs',
  'scripts/agentcore/require-mmdsv2.mjs',
  'scripts/mcp/doctor.mjs',
  'scripts/mcp/launcher-lib.mjs',
  'scripts/mcp/run-node.mjs',
  'scripts/mcp/start.mjs',
  'test/fixtures/catalog.json',
  'test/fixtures/operations.json',
];

function run(command, args, options = {}) {
  let executable = command;
  let effectiveArgs = args;
  if (process.platform === 'win32' && command === 'npm') {
    const bundledNpmCli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    const npmCli = process.env.npm_execpath || bundledNpmCli;
    if (!existsSync(npmCli)) {
      throw new Error('Unable to resolve npm-cli.js for the Windows package check.');
    }
    executable = process.execPath;
    effectiveArgs = [npmCli, ...args];
  }
  const result = spawnSync(executable, effectiveArgs, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? 'signal'}):\n${result.stderr}`,
    );
  }
  return result;
}

function assertEntrypoint(relativePath, root = repositoryRoot) {
  const absolutePath = path.join(root, relativePath);
  const source = readFileSync(absolutePath, 'utf8');
  if (!source.startsWith('#!/usr/bin/env node\n')) {
    throw new Error(`${relativePath} is not directly executable by Node.js.`);
  }
  if (process.platform !== 'win32' && (lstatSync(absolutePath).mode & 0o111) === 0) {
    throw new Error(`${relativePath} does not have an executable mode.`);
  }
}

async function smokePackagedStdio(entrypoint, cwd) {
  const command = process.platform === 'win32' ? process.execPath : entrypoint;
  const args = process.platform === 'win32' ? [entrypoint] : [];
  const child = spawn(command, args, {
    cwd,
    env: sanitizedSmokeEnvironment(cwd),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  let stdoutBuffer = '';
  const responses = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (typeof message.id === 'number') responses.set(message.id, message);
    }
  });

  function send(method, params, id) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(id ? { id } : {}) })}\n`,
    );
  }

  async function response(id) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (responses.has(id)) return responses.get(id);
      if (child.exitCode !== null) {
        throw new Error(`Packaged CLI exited before response ${id}: ${stderr}`);
      }
      await delay(25);
    }
    throw new Error(`Timed out waiting for packaged CLI response ${id}: ${stderr}`);
  }

  try {
    send(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'package-smoke', version: '0.1.0' },
      },
      1,
    );
    const initialized = await response(1);
    if (initialized.error)
      throw new Error(`Packaged CLI initialize failed: ${initialized.error.message}`);
    const expectedVersion = JSON.parse(
      readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    ).version;
    if (initialized.result?.serverInfo?.version !== expectedVersion) {
      throw new Error('Packaged MCP server version does not match its package version.');
    }
    send('notifications/initialized');
    send('tools/call', { name: 'qlik_get_readiness', arguments: {} }, 2);
    const readiness = await response(2);
    const content = readiness.result?.structuredContent;
    if (
      readiness.result?.isError ||
      content?.status !== 'ready' ||
      content?.adapters?.length !== 2
    ) {
      throw new Error('Packaged CLI did not return fixture readiness for both adapters.');
    }
    return { adapters: content.adapters.length, status: content.status };
  } finally {
    child.kill('SIGTERM');
  }
}

for (const entrypoint of ['dist/index.js', 'dist/agentcore/runtime.js']) {
  assertEntrypoint(entrypoint);
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'qlik-ai-harness-package-'));
try {
  const packResult = run('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    temporaryDirectory,
  ]);
  const packReport = JSON.parse(packResult.stdout)[0];
  const packagedFiles = new Set(packReport.files.map((entry) => entry.path));
  for (const requiredFile of requiredFiles) {
    if (!packagedFiles.has(requiredFile)) throw new Error(`Package is missing ${requiredFile}.`);
  }
  for (const packagedFile of packagedFiles) {
    const privateReason = privateMaterialReason(packagedFile);
    if (privateReason) {
      throw new Error(
        `Package contains forbidden local material: ${packagedFile}: ${privateReason}.`,
      );
    }
  }

  const tarballPath = path.join(temporaryDirectory, packReport.filename);
  if (!existsSync(tarballPath)) throw new Error('npm pack did not create the reported tarball.');
  const installRoot = path.join(temporaryDirectory, 'install');
  mkdirSync(installRoot);
  writeFileSync(
    path.join(installRoot, 'package.json'),
    `${JSON.stringify({ name: 'qlik-package-smoke', private: true, version: '0.0.0' })}\n`,
    { mode: 0o600 },
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org/',
      tarballPath,
    ],
    { cwd: installRoot },
  );
  const installedPackageRoot = path.join(
    installRoot,
    'node_modules',
    'qlik-ai-harness-bedrock-agentcore',
  );
  run(
    process.execPath,
    [path.join(installedPackageRoot, 'scripts/package/checkMarkdownLinks.mjs')],
    {
      cwd: installedPackageRoot,
    },
  );
  const installedDoctor = path.join(installedPackageRoot, 'scripts', 'mcp', 'doctor.mjs');
  const doctorHelp = run(process.execPath, [installedDoctor, '--help'], {
    cwd: installedPackageRoot,
  });
  if (!doctorHelp.stdout.includes('Usage: node scripts/mcp/doctor.mjs')) {
    throw new Error('Packaged MCP doctor did not return its help contract.');
  }
  const installedBin = path.join(
    installRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'qlik-ai-harness.cmd' : 'qlik-ai-harness',
  );
  const installedEntrypoint =
    process.platform === 'win32'
      ? path.join(installedPackageRoot, 'dist', 'index.js')
      : installedBin;
  const readiness = await smokePackagedStdio(installedEntrypoint, installedPackageRoot);
  assertEntrypoint('dist/agentcore/runtime.js', installedPackageRoot);
  process.stderr.write(
    `[package] verified ${packReport.entryCount} files, ${packReport.size} bytes, fixture readiness=${readiness.status}, adapters=${readiness.adapters}\n`,
  );
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
