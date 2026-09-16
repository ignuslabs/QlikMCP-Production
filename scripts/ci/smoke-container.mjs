#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const image = process.argv[2] ?? 'qlik-mcp-production:local';
assert(process.argv.length <= 3 && !image.startsWith('-'), 'Usage: smoke-container.mjs [image]');
const context = process.env.DOCKER_CONTEXT?.trim();
const prefix = context ? ['--context', context] : [];
const cancellation = new globalThis.AbortController();
const containers = new Set();
const interrupted = (signal) => cancellation.abort(new Error(`Interrupted by ${signal}.`));
const sigint = () => interrupted('SIGINT');
const sigterm = () => interrupted('SIGTERM');
process.once('SIGINT', sigint);
process.once('SIGTERM', sigterm);

function docker(args, { input, timeout = 30_000, cleanup = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      [...prefix, ...args],
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: 1024 * 1024,
        ...(cleanup ? {} : { signal: cancellation.signal }),
      },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== 'number' || error.killed)) {
          reject(new Error(`Docker command could not finish: ${error.message}`));
          return;
        }
        resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function containerArgs(name) {
  containers.add(name);
  return [
    'run',
    '--pull',
    'never',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--memory',
    '512m',
  ];
}

async function main() {
  const inspected = await docker(['image', 'inspect', image]);
  assert.equal(inspected.code, 0, `The local image ${image} must already be built.`);
  const [metadata] = JSON.parse(inspected.stdout);
  const imageId = metadata.Id;
  assert.equal(metadata.Os, 'linux', 'The runtime image must target Linux.');
  assert.equal(metadata.Architecture, 'arm64', 'The runtime image must target ARM64.');
  const user = metadata.Config.User?.split(':')[0];
  assert(user && user !== 'root' && user !== '0', 'The image must configure a non-root user.');
  assert.deepEqual(
    metadata.Config.Cmd,
    ['node', 'dist/agentcore/runtime.js'],
    'The image must launch the real AgentCore runtime by default.',
  );
  process.stdout.write('[container-smoke] image is Linux ARM64 with a non-root default user\n');

  const suffix = randomUUID();
  const unconfigured = await docker(
    [...containerArgs(`qlik-smoke-unconfigured-${suffix}`), imageId],
    { timeout: 45_000 },
  );
  assert.equal(unconfigured.code, 1, 'Unconfigured production startup must exit with code 1.');
  const startupLogs = unconfigured.stdout + unconfigured.stderr;
  assert.match(startupLogs, /QLIK_AGENTCORE_STATE_TABLE is required/u);
  assert.doesNotMatch(startupLogs, /MCP endpoint listening/u);
  process.stdout.write(
    '[container-smoke] normal production entrypoint fails closed without configuration\n',
  );

  const probe = await readFile(new URL('./container-runtime-probe.mjs', import.meta.url), 'utf8');
  const fixture = await docker(
    [
      ...containerArgs(`qlik-smoke-fixture-${suffix}`),
      '-i',
      '--entrypoint',
      'node',
      imageId,
      '--input-type=module',
      '-',
      metadata.Config.Cmd[1],
    ],
    { input: probe, timeout: 45_000 },
  );
  assert.equal(
    fixture.code,
    0,
    `Fixture runtime smoke failed:\n${fixture.stdout}${fixture.stderr}`,
  );
  assert.match(fixture.stdout, /\[container-smoke\] fixture runtime passed/u);
  process.stdout.write(fixture.stdout);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[container-smoke] ${error.message}\n`);
  process.exitCode = 1;
} finally {
  for (const name of containers) {
    try {
      const removed = await docker(['rm', '--force', name], { timeout: 10_000, cleanup: true });
      assert(
        removed.code === 0 || /No such container/u.test(removed.stderr),
        `Could not remove smoke container ${name}.`,
      );
    } catch (error) {
      process.stderr.write(`[container-smoke] cleanup failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
  process.off('SIGINT', sigint);
  process.off('SIGTERM', sigterm);
}
