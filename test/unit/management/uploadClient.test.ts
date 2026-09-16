import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone JavaScript CLI intentionally has no declaration package.
import { parseArguments, runTransfer } from '../../../scripts/mcp/uploadDataset.mjs';
import {
  ArtifactService,
  ARTIFACT_CHUNK_BYTES,
  type ArtifactMetadata,
} from '../../../src/management/artifacts.js';
import { validateDatasetUpload } from '../../../src/management/dataPreparation.js';
import { MemoryManagementStore } from '../../../src/management/state.js';

const directories: string[] = [];
const environment = { QLIK_MANAGEMENT_BEARER_TOKEN: 'synthetic-test-token' };
const baseArguments = ['--endpoint', 'https://qlik.example.test/mcp', '--connection', 'cloud-dev'];
const actor = 'test-owner';

async function directory(): Promise<string> {
  const result = await mkdtemp(path.join(tmpdir(), 'qlik-transfer-test-'));
  directories.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((name) => rm(name, { recursive: true, force: true })),
  );
});

function server() {
  const service = new ArtifactService(new MemoryManagementStore(), 50 * 1024 * 1024);
  const close = vi.fn(async () => undefined);
  const calls = vi.fn(async (request: { name: string; arguments: Record<string, unknown> }) => {
    const input = request.arguments;
    let structuredContent: Record<string, unknown>;
    switch (request.name) {
      case 'qlik_management_catalog':
        structuredContent = {
          maxUploadBytes: 50 * 1024 * 1024,
          uploadChunkBytes: ARTIFACT_CHUNK_BYTES,
        };
        break;
      case 'qlik_upload_begin':
        structuredContent = await service.begin(actor, {
          ...input,
          purpose: 'dataset',
        } as ArtifactMetadata);
        break;
      case 'qlik_upload_chunk':
        structuredContent = await service.chunk(
          actor,
          String(input.artifactId),
          Number(input.index),
          String(input.contentBase64),
        );
        break;
      case 'qlik_upload_finish': {
        let preview: Awaited<ReturnType<typeof validateDatasetUpload>> | undefined;
        const finished = await service.finish(
          actor,
          String(input.artifactId),
          async (bytes, metadata) => {
            preview = await validateDatasetUpload({
              filename: metadata.filename,
              mimeType: metadata.mimeType,
              contentBase64: bytes.toString('base64'),
              csvDelimiter: metadata.csvDelimiter,
            });
          },
        );
        structuredContent = {
          ...finished,
          inspection: preview?.inspection,
          preview: preview?.preview,
        };
        break;
      }
      case 'qlik_artifact_chunk':
        structuredContent = await service.downloadChunk(
          actor,
          String(input.artifactId),
          Number(input.index),
        );
        break;
      default:
        throw new Error('Unexpected test action');
    }
    return { content: [], structuredContent };
  });
  const client = { callTool: calls, close };
  return { service, calls, close, client, connect: async () => client };
}

describe('dataset transfer CLI', () => {
  it('requires an explicit upload or download, secure endpoint, known delimiter, and nonconflicting options', () => {
    expect(parseArguments(['--help'], {}).help).toBe(true);
    expect(
      parseArguments([...baseArguments, '--file', '/tmp/data.csv', '--delimiter', 'tab'], {})
        .csvDelimiter,
    ).toBe('\t');
    expect(
      parseArguments(['--connection', 'dev', '--file', '/tmp/data.csv'], {
        QLIK_MANAGEMENT_MCP_URL: 'http://127.0.0.1:8080/mcp',
      }).endpoint.hostname,
    ).toBe('127.0.0.1');
    for (const argv of [
      [],
      [...baseArguments],
      [...baseArguments, '--file', 'data.csv', '--file', 'other.csv'],
      [...baseArguments, '--file', 'data.csv', '--output', 'result.csv'],
      [...baseArguments, '--file', 'data.csv', '--delimiter', 'unsafe'],
      [...baseArguments, '--download', 'bad-id', '--output', 'result.csv'],
      ['--endpoint', 'http://remote.example.test/mcp', '--connection', 'dev', '--file', 'data.csv'],
      [
        '--endpoint',
        'https://user:password@example.test/mcp',
        '--connection',
        'dev',
        '--file',
        'data.csv',
      ],
      ['--endpoint', 'file:///tmp/server', '--connection', 'dev', '--file', 'data.csv'],
      [...baseArguments, '--file', 'data.csv', '--headers-command', 'echo private'],
      [...baseArguments, '--file', 'data.csv', '--token', 'private-token'],
    ])
      expect(() => parseArguments(argv, {})).toThrow();
  });

  it('reads a local file once, stages canonical chunks, validates it, and prints no preview content', async () => {
    const root = await directory();
    const filename = path.join(root, 'data.csv');
    const bytes = Buffer.from(`ID;Name\n${'001;PRIVATE_ROW_VALUE\n'.repeat(12_000)}`);
    await writeFile(filename, bytes);
    const remote = server();
    const result = await runTransfer(
      [...baseArguments, '--file', filename, '--space-id', 'space-dev', '--delimiter', 'semicolon'],
      { environment, connect: remote.connect },
    );
    expect(result).toMatchObject({
      status: 'sealed',
      filename: 'data.csv',
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      inspection: 'parsed-csv',
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ROW_VALUE');
    expect(JSON.stringify(result)).not.toContain('preview');
    expect(JSON.stringify(result)).not.toContain('contentBase64');
    const saved = await remote.service.read(actor, result.artifactId);
    expect(saved.bytes.equals(bytes)).toBe(true);
    expect(saved.metadata.csvDelimiter).toBe(';');
    expect(
      remote.calls.mock.calls.filter(([request]) => request.name === 'qlik_upload_chunk'),
    ).toHaveLength(2);
    expect(remote.close).toHaveBeenCalledOnce();
  });

  it('downloads exact verified bytes atomically with no overwrite and cleans up failed checksum output', async () => {
    const root = await directory();
    const output = path.join(root, 'download.qvf');
    const bytes = Buffer.from('synthetic application backup\n'.repeat(10_000));
    const remote = server();
    const artifact = await remote.service.save(actor, bytes, {
      connection: 'cloud-dev',
      appId: 'app',
      filename: 'app.qvf',
      mimeType: 'application/octet-stream',
      purpose: 'app-export',
    });
    const args = [...baseArguments, '--download', artifact.artifactId, '--output', output];
    const result = await runTransfer(args, { environment, connect: remote.connect });
    expect(result).toMatchObject({
      output,
      byteLength: bytes.length,
      verified: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect((await readFile(output)).equals(bytes)).toBe(true);
    expect(await readdir(root)).toEqual(['download.qvf']);
    await expect(runTransfer(args, { environment, connect: remote.connect })).rejects.toThrow(
      'already exists',
    );
    expect((await readFile(output)).equals(bytes)).toBe(true);

    const invalidOutput = path.join(root, 'corrupt.qvf');
    const failingClient = {
      close: remote.close,
      callTool: async (request: Parameters<typeof remote.calls>[0]) => {
        const result = await remote.calls(request);
        return {
          ...result,
          structuredContent: { ...result.structuredContent, artifactSha256: '0'.repeat(64) },
        };
      },
    };
    await expect(
      runTransfer(
        [...baseArguments, '--download', artifact.artifactId, '--output', invalidOutput],
        { environment, connect: async () => failingClient },
      ),
    ).rejects.toThrow('complete artifact');
    expect(await readdir(root)).toEqual(['download.qvf']);
  });

  it('retries only explicitly retryable read/chunk calls with bounded server delays', async () => {
    const root = await directory();
    const filename = path.join(root, 'data.csv');
    await writeFile(filename, 'ID\n1\n');
    const remote = server();
    let throttled = false;
    const callTool = vi.fn(async (request: Parameters<typeof remote.calls>[0]) => {
      if (request.name === 'qlik_upload_chunk' && !throttled) {
        throttled = true;
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 1 }),
            },
          ],
        };
      }
      return remote.calls(request);
    });
    const wait = vi.fn(async () => undefined);
    const result = await runTransfer([...baseArguments, '--file', filename], {
      environment,
      connect: async () => ({ callTool, close: remote.close }),
      wait,
    });
    expect(result.status).toBe('sealed');
    expect(wait).toHaveBeenCalledExactlyOnceWith(1000);
    expect(
      callTool.mock.calls.filter(([request]) => request.name === 'qlik_upload_chunk'),
    ).toHaveLength(2);
    expect(
      callTool.mock.calls.filter(([request]) => request.name === 'qlik_upload_begin'),
    ).toHaveLength(1);
  });

  it('never retries unknown transport outcomes or exposes token/provider response contents', async () => {
    const close = vi.fn(async () => undefined);
    const callTool = vi.fn(async () => {
      throw new Error(`provider text ${environment.QLIK_MANAGEMENT_BEARER_TOKEN}`);
    });
    let caught: unknown;
    try {
      await runTransfer([...baseArguments, '--file', 'data.csv'], {
        environment,
        connect: async () => ({ callTool, close }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(environment.QLIK_MANAGEMENT_BEARER_TOKEN);
    expect(callTool).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(
      runTransfer([...baseArguments, '--file', 'data.csv'], {
        environment: {},
        connect: async () => ({ callTool, close }),
      }),
    ).rejects.toThrow('BEARER_TOKEN');
  });
});
