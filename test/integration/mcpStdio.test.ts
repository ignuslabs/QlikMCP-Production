import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Real STDIO transport integration test. Spawns the actual MCP entrypoint
 * (`src/index.ts`, via the `tsx` runtime already used by `npm run dev`, so
 * this test needs no prior build step) as a separate OS process and speaks
 * newline-delimited JSON-RPC to it directly over stdin/stdout, exactly as
 * documented in docs/08-mcp-server-contract.md ("Transport Policy": "A
 * STDIO server must reserve stdout for JSON-RPC only; log to stderr").
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');

let child: ChildProcessWithoutNullStreams;
let stdoutChunks: Buffer[];
let stderrChunks: Buffer[];
let nextId = 1;

function send(method: string, params?: unknown, id?: number): void {
  const message: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (params !== undefined) message.params = params;
  if (id !== undefined) message.id = id;
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitForResponse(id: number, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = Buffer.concat(stdoutChunks).toString('utf8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.id === id) {
        return parsed;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for a response to request id ${id}. stdout so far: ${text}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(async () => {
  stdoutChunks = [];
  stderrChunks = [];
  child = spawn(process.execPath, [tsxCli, entrypoint], {
    cwd: repoRoot,
    env: {
      ...process.env,
      QLIK_HARNESS_TARGET_MODE: 'fixture',
      QLIK_HARNESS_MUTATION_ACTORS: 'local-dev-actor',
      QLIK_HARNESS_LOG_LEVEL: 'info',
      QLIK_HARNESS_MCP_ROLE: 'all',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  send(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-integration-test', version: '0.0.1' },
    },
    (nextId += 1),
  );
  await waitForResponse(nextId);
  send('notifications/initialized');
}, 20_000);

afterEach(() => {
  child.kill();
});

describe('STDIO transport purity', () => {
  it('emits only newline-delimited JSON-RPC messages on stdout', async () => {
    const id = (nextId += 1);
    send('tools/list', {}, id);
    const response = await waitForResponse(id);
    expect(response.jsonrpc).toBe('2.0');

    const text = Buffer.concat(stdoutChunks).toString('utf8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.jsonrpc).toBe('2.0');
    }
  });

  it('writes diagnostics to stderr, not stdout', async () => {
    const id = (nextId += 1);
    send('tools/list', {}, id);
    await waitForResponse(id);

    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    expect(stderrText.length).toBeGreaterThan(0);
    const stderrLines = stderrText.split('\n').filter((line) => line.trim().length > 0);
    for (const line of stderrLines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.message).toBeDefined();
    }

    const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
    expect(stdoutText).not.toMatch(/"message":"Qlik AI Harness/);
  });

  it('discovers all required tools and strict readiness schema over real STDIO', async () => {
    const id = (nextId += 1);
    send('tools/list', {}, id);
    const response = await waitForResponse(id);
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(
      [
        'qlik_plan_sheet',
        'qlik_preview_sheet',
        'qlik_apply_sheet',
        'qlik_verify_sheet',
        'qlik_apply_visualization',
        'qlik_get_app_catalog',
        'qlik_get_operation',
        'qlik_get_readiness',
        'qlik_list_apps',
        'qlik_list_sheet_objects',
        'qlik_plan_visualization',
        'qlik_preview_visualization',
        'qlik_request_visualization_approval',
        'qlik_approve_visualization_request',
        'qlik_reject_visualization_request',
        'qlik_get_visualization_approval',
      ].sort(),
    );

    const readinessTool = result.tools.find((tool) => tool.name === 'qlik_get_readiness') as
      | {
          inputSchema: { additionalProperties?: boolean };
          outputSchema: { additionalProperties?: boolean };
        }
      | undefined;
    expect(readinessTool?.inputSchema.additionalProperties).toBe(false);
    expect(readinessTool?.outputSchema.additionalProperties).toBe(false);
  });

  it('returns sanitized readiness and rejects unknown readiness input over real STDIO', async () => {
    let id = (nextId += 1);
    send('tools/call', { name: 'qlik_get_readiness', arguments: {} }, id);
    const response = await waitForResponse(id);
    const result = response.result as {
      isError?: boolean;
      structuredContent: { status: string; adapters: unknown[] };
    };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.status).toBe('ready');
    expect(result.structuredContent.adapters).toHaveLength(2);
    expect(JSON.stringify(result.structuredContent)).not.toMatch(
      /token|password|private.?key|client.?secret|certificate/i,
    );

    id = nextId += 1;
    send(
      'tools/call',
      { name: 'qlik_get_readiness', arguments: { unexpectedProperty: 'value' } },
      id,
    );
    const rejected = await waitForResponse(id);
    expect((rejected.result as { isError?: boolean }).isError).toBe(true);
  });

  it('rejects a tool call with an unrecognized property over real STDIO', async () => {
    const id = (nextId += 1);
    send(
      'tools/call',
      {
        name: 'qlik_list_apps',
        arguments: { connection: 'cloud-dev', unexpectedProperty: 'value' },
      },
      id,
    );
    const response = await waitForResponse(id);
    const result = response.result as { isError?: boolean } | undefined;
    expect(result?.isError).toBe(true);
  });
});
