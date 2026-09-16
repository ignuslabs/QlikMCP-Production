// Executed over stdin inside the image by smoke-container.mjs; no mounts or exposed ports.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const { fetch, AbortSignal } = globalThis;
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.notEqual(process.getuid(), 0, 'The running container must not use root.');
const runtime = spawn(process.execPath, [process.argv[2]], {
  env: {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    PORT: '8000',
    DOTENV_CONFIG_PATH: '/dev/null',
    QLIK_AGENTCORE_LOCAL_DEV: 'true',
    QLIK_AGENTCORE_LOCAL_HOST: '127.0.0.1',
    QLIK_HARNESS_TARGET_MODE: 'fixture',
    QLIK_HARNESS_MCP_ROLE: 'all',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
const recordLog = (chunk) => {
  logs = (logs + chunk.toString()).slice(-65_536);
};
runtime.stdout.on('data', recordLog);
runtime.stderr.on('data', recordLog);
let exitState;
const exited = new Promise((resolve) => {
  runtime.once('error', (error) => {
    exitState = { error };
    resolve(exitState);
  });
  runtime.once('close', (code, signal) => {
    exitState = { code, signal };
    resolve(exitState);
  });
});
const endpoint = 'http://127.0.0.1:8000';

async function ready() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    assert(!exitState, `The real runtime exited during startup:\n${logs}`);
    try {
      const response = await fetch(`${endpoint}/ping`, { signal: AbortSignal.timeout(1_000) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'Healthy' });
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`The real runtime did not become healthy:\n${logs}`);
}

async function rpc(id, method, params) {
  const response = await fetch(`${endpoint}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, `MCP ${method} must succeed.`);
  const raw = await response.text();
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? raw
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .at(-1)
        ?.slice(6)
    : raw;
  assert(json, `MCP ${method} must return a response body.`);
  const body = JSON.parse(json);
  assert.equal(body.id, id);
  assert.equal(body.error, undefined, `MCP ${method} must not return an RPC error.`);
  return body.result;
}

try {
  await ready();
  assert.match(logs, /"host":"127\.0\.0\.1"/u, 'Fixture mode must bind only to loopback.');
  const initialized = await rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'container-smoke', version: '1.0.0' },
  });
  assert.equal(initialized.serverInfo.name, 'qlik-ai-harness');
  const listed = await rpc(2, 'tools/list', {});
  assert.equal(listed.tools.length, 16, 'Management-disabled runtime must expose 16 tools.');
  const names = listed.tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, 16);
  assert(names.includes('qlik_apply_visualization'));
  assert(names.includes('qlik_plan_sheet'));
  assert(!names.some((name) => name.startsWith('qlik_management_')));
  runtime.kill('SIGTERM');
  const stopped = await Promise.race([exited, delay(5_000, { timedOut: true }, { ref: false })]);
  assert.deepEqual(stopped, { code: 0, signal: null }, 'The runtime must exit cleanly on SIGTERM.');
  assert.match(logs, /Received SIGTERM; shutting down AgentCore Runtime/u);
  process.stdout.write(
    '[container-smoke] fixture runtime passed: non-root ARM64, loopback /ping, MCP initialize, 16 tools, graceful SIGTERM\n',
  );
} catch (error) {
  process.stderr.write(`[container-smoke] ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (!exitState) {
    runtime.kill('SIGKILL');
    await exited;
  }
}
