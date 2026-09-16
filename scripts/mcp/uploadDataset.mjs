#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { open, link, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const CHUNK_BYTES = 192 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const ARTIFACT_ID = /^artifact-[0-9a-f-]{36}$/;
const SAFE_ERROR_CODES = new Set([
  'MALFORMED_REQUEST',
  'PERMISSION_DENIED',
  'CAPACITY_EXHAUSTED',
  'RATE_LIMITED',
  'IDEMPOTENCY_CONFLICT',
  'NOT_CONFIGURED',
  'AUTHENTICATION_FAILED',
]);
const INSPECTION_LEVELS = new Set(['parsed-csv', 'parsed-xlsx', 'qvd-header-only']);

export class TransferError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransferError';
  }
}

export const HELP = `Usage:
  node scripts/mcp/uploadDataset.mjs --endpoint URL --connection ALIAS --file PATH [--space-id ID] [--delimiter comma|semicolon|tab|pipe]
  node scripts/mcp/uploadDataset.mjs --endpoint URL --connection ALIAS --download ARTIFACT_ID --output PATH

Environment:
  QLIK_MANAGEMENT_BEARER_TOKEN  Required bearer token, injected securely; never pass it as a command argument.
  QLIK_MANAGEMENT_MCP_URL       Optional default endpoint if --endpoint is omitted.

Uploads create a private sealed artifact (up to 50 MiB). They do not write to Qlik;
use its artifactId in an approved datafile.upload workflow. Downloads verify each
chunk and the complete artifact (up to 200 MiB), then create the exact output path
without overwriting an existing file. File contents and preview rows are not printed.
This helper requires Node.js 22.23.2 or a later Node.js 22 patch release and the installed package dependencies.
`;

export function parseArguments(argv, environment = process.env) {
  const options = {};
  const accepted = new Set([
    'endpoint',
    'connection',
    'file',
    'space-id',
    'delimiter',
    'download',
    'output',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help') {
      if (argv.length !== 1) throw new TransferError('Use --help by itself.');
      return { help: true };
    }
    const key = argv[index]?.startsWith('--') ? argv[index].slice(2) : '';
    if (!accepted.has(key) || Object.hasOwn(options, key))
      throw new TransferError('An unsupported or duplicate command option was supplied.');
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
      throw new TransferError('Every command option requires a value.');
    options[key] = value;
    index += 1;
  }
  let endpoint;
  try {
    endpoint = new URL(options.endpoint ?? environment.QLIK_MANAGEMENT_MCP_URL ?? '');
  } catch {
    throw new TransferError('Supply a valid MCP endpoint URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname.toLowerCase());
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))
  )
    throw new TransferError(
      'The endpoint must use HTTPS or loopback HTTP without embedded credentials.',
    );
  if (!options.connection || options.connection.length > 128)
    throw new TransferError('Supply a bounded connection alias.');
  if (!!options.file === !!options.download)
    throw new TransferError('Choose exactly one upload file or download artifact.');
  if (
    options.download &&
    (!ARTIFACT_ID.test(options.download) ||
      !options.output ||
      options['space-id'] ||
      options.delimiter)
  )
    throw new TransferError(
      'Downloads require a valid artifact ID and output path without upload-only options.',
    );
  if (options.file && options.output)
    throw new TransferError('The output option is only valid for downloads.');
  if (options['space-id'] && options['space-id'].length > 128)
    throw new TransferError('The space ID exceeds the supported length.');
  const delimiters = { comma: ',', semicolon: ';', tab: '\t', pipe: '|' };
  if (options.delimiter && !Object.hasOwn(delimiters, options.delimiter))
    throw new TransferError('Choose comma, semicolon, tab, or pipe as the delimiter.');
  return {
    ...options,
    endpoint,
    csvDelimiter: options.delimiter ? delimiters[options.delimiter] : undefined,
  };
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeEnvelope(result) {
  for (const item of result.content ?? []) {
    if (item.type !== 'text') continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* Unstructured provider errors are not printed. */
    }
  }
  return {};
}

async function call(client, name, input, retrySafe = false, wait = delay) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let result;
    try {
      result = await client.callTool({ name, arguments: input }, { timeout: 30_000 });
    } catch {
      throw new TransferError('The MCP request failed. Reconnect before retrying the transfer.');
    }
    if (!result.isError) {
      if (!result.structuredContent || typeof result.structuredContent !== 'object')
        throw new TransferError('The MCP server returned an invalid transfer response.');
      return result.structuredContent;
    }
    const envelope = safeEnvelope(result);
    if (
      retrySafe &&
      attempt < 2 &&
      envelope.retryable === true &&
      Number.isFinite(envelope.retryAfterSeconds) &&
      envelope.retryAfterSeconds >= 0 &&
      envelope.retryAfterSeconds <= 10
    ) {
      await wait(envelope.retryAfterSeconds * 1000);
      continue;
    }
    const code = SAFE_ERROR_CODES.has(envelope.code) ? envelope.code : 'REQUEST_REJECTED';
    throw new TransferError(`The MCP server rejected the transfer (${code}).`);
  }
  throw new TransferError('The bounded transfer retry limit was reached.');
}

async function readUpload(filename, maximum) {
  let handle;
  try {
    handle = await open(filename, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum)
      throw new TransferError(
        'The source must be a non-empty regular file within the supported upload limit.',
      );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead)
        throw new TransferError('The source file changed while it was being read.');
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new TransferError('The source file changed while it was being read.');
    return bytes;
  } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError('The source file could not be opened or read.');
  } finally {
    await handle?.close();
  }
}

async function upload(client, options, wait) {
  const filename = path.basename(options.file);
  const extension = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.csv': 'text/csv',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.qvd': 'application/octet-stream',
  };
  if (!Object.hasOwn(mimeTypes, extension) || (options.csvDelimiter && extension !== '.csv'))
    throw new TransferError('Upload CSV, XLSX, or QVD files; delimiter options require CSV.');
  const catalog = await call(client, 'qlik_management_catalog', {}, true, wait);
  if (
    !Number.isSafeInteger(catalog.maxUploadBytes) ||
    catalog.maxUploadBytes < 1 ||
    catalog.uploadChunkBytes !== CHUNK_BYTES
  )
    throw new TransferError('The server advertises unsupported upload limits.');
  const bytes = await readUpload(options.file, Math.min(MAX_UPLOAD_BYTES, catalog.maxUploadBytes));
  const sha256 = digest(bytes);
  const begun = await call(client, 'qlik_upload_begin', {
    connection: options.connection,
    ...(options['space-id'] ? { spaceId: options['space-id'] } : {}),
    filename,
    mimeType: mimeTypes[extension],
    byteLength: bytes.length,
    sha256,
    ...(options.csvDelimiter ? { csvDelimiter: options.csvDelimiter } : {}),
  });
  if (!ARTIFACT_ID.test(begun.artifactId) || begun.chunkBytes !== CHUNK_BYTES)
    throw new TransferError('The server returned an invalid upload manifest.');
  try {
    for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_BYTES, index += 1) {
      const sent = await call(
        client,
        'qlik_upload_chunk',
        {
          connection: options.connection,
          artifactId: begun.artifactId,
          index,
          contentBase64: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64'),
        },
        true,
        wait,
      );
      if (sent.accepted !== true || sent.index !== index || sent.artifactId !== begun.artifactId)
        throw new TransferError('The server did not confirm the expected upload chunk.');
    }
    const finished = await call(
      client,
      'qlik_upload_finish',
      { connection: options.connection, artifactId: begun.artifactId },
      true,
      wait,
    );
    if (
      finished.artifactId !== begun.artifactId ||
      finished.status !== 'sealed' ||
      finished.sha256 !== sha256 ||
      finished.byteLength !== bytes.length
    )
      throw new TransferError(
        'The completed upload did not match the local file checksum and size.',
      );
    return {
      artifactId: begun.artifactId,
      status: 'sealed',
      filename,
      sha256,
      byteLength: bytes.length,
      inspection: INSPECTION_LEVELS.has(finished.inspection?.level)
        ? finished.inspection.level
        : 'unspecified',
    };
  } catch (error) {
    const safe = error instanceof TransferError ? error.message : 'The dataset transfer failed.';
    throw new TransferError(`${safe} Staged artifact: ${begun.artifactId}`);
  }
}

function validateDownloadedChunk(chunk, artifactId, index, expected) {
  if (
    chunk.artifactId !== artifactId ||
    chunk.index !== index ||
    !Number.isSafeInteger(chunk.chunkCount) ||
    chunk.chunkCount < 1 ||
    !Number.isSafeInteger(chunk.byteLength) ||
    chunk.byteLength < 1 ||
    chunk.byteLength > MAX_DOWNLOAD_BYTES ||
    chunk.chunkCount !== Math.ceil(chunk.byteLength / CHUNK_BYTES) ||
    !DIGEST.test(chunk.artifactSha256) ||
    !DIGEST.test(chunk.sha256) ||
    typeof chunk.contentBase64 !== 'string' ||
    chunk.contentBase64.length > 4 * Math.ceil(CHUNK_BYTES / 3)
  )
    throw new TransferError('The downloaded artifact metadata exceeds the supported bounds.');
  if (
    expected &&
    (chunk.chunkCount !== expected.chunkCount ||
      chunk.byteLength !== expected.byteLength ||
      chunk.artifactSha256 !== expected.artifactSha256)
  )
    throw new TransferError('The artifact metadata changed during download.');
  const bytes = Buffer.from(chunk.contentBase64, 'base64');
  const expectedLength =
    index === chunk.chunkCount - 1 ? chunk.byteLength - index * CHUNK_BYTES : CHUNK_BYTES;
  if (
    bytes.toString('base64') !== chunk.contentBase64 ||
    bytes.length !== expectedLength ||
    digest(bytes) !== chunk.sha256
  )
    throw new TransferError('An artifact chunk failed its encoding, size, or checksum check.');
  return bytes;
}

async function download(client, options, wait) {
  const output = path.resolve(options.output);
  try {
    await lstat(output);
    throw new TransferError('The output path already exists; choose a new path.');
  } catch (error) {
    if (error?.code !== 'ENOENT')
      throw error instanceof TransferError
        ? error
        : new TransferError('The output path could not be inspected.');
  }
  const temporary = path.join(
    path.dirname(output),
    `.${path.basename(output)}.partial-${randomUUID()}`,
  );
  let handle;
  let created = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    let expected;
    let byteLength = 0;
    const checksum = createHash('sha256');
    for (let index = 0; index === 0 || index < expected.chunkCount; index += 1) {
      const chunk = await call(
        client,
        'qlik_artifact_chunk',
        { connection: options.connection, artifactId: options.download, index },
        true,
        wait,
      );
      const bytes = validateDownloadedChunk(chunk, options.download, index, expected);
      expected ??= {
        chunkCount: chunk.chunkCount,
        byteLength: chunk.byteLength,
        artifactSha256: chunk.artifactSha256,
      };
      checksum.update(bytes);
      byteLength += bytes.length;
      await handle.writeFile(bytes);
    }
    const sha256 = checksum.digest('hex');
    if (byteLength !== expected.byteLength || sha256 !== expected.artifactSha256)
      throw new TransferError('The complete artifact failed its checksum or size check.');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // A same-directory hard link publishes a verified file atomically and
    // fails if another process created the target after the initial check.
    await link(temporary, output);
    return { artifactId: options.download, output, sha256, byteLength, verified: true };
  } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError(
      'The download output could not be created. Existing files were not overwritten.',
    );
  } finally {
    await handle?.close();
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

/** Dependency injection is used only by local tests; the CLI never runs shell commands. */
export async function runTransfer(argv, options = {}) {
  const environment = options.environment ?? process.env;
  const parsed = parseArguments(argv, environment);
  if (parsed.help) return { help: HELP };
  const token = environment.QLIK_MANAGEMENT_BEARER_TOKEN;
  if (
    typeof token !== 'string' ||
    token.length < 1 ||
    token.length > 8192 ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(token)
  )
    throw new TransferError('Inject a valid QLIK_MANAGEMENT_BEARER_TOKEN through the environment.');
  let client;
  try {
    if (options.connect) client = await options.connect(parsed.endpoint, token);
    else {
      client = new Client({ name: 'qlik-dataset-transfer', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(parsed.endpoint, {
          requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: 'error' },
        }),
      );
    }
    return await (parsed.file
      ? upload(client, parsed, options.wait)
      : download(client, parsed, options.wait));
  } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError('The MCP endpoint could not complete the transfer.');
  } finally {
    await client?.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runTransfer(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(result.help ?? `${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof TransferError ? error.message : 'Dataset transfer failed.'}\n`,
      );
      process.exitCode = 1;
    });
}
