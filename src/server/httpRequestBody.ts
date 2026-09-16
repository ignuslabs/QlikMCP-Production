import type { IncomingMessage } from 'node:http';

export const MAX_MCP_BODY_BYTES = 1024 * 1024;

export class HttpBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
  }
}

/** Bound both declared and chunked bodies before MCP classification/parsing. */
export async function readMcpRequestBody(request: IncomingMessage): Promise<unknown> {
  if (request.method !== 'POST') return undefined;
  const length = Number(request.headers['content-length'] ?? 0);
  if (length > MAX_MCP_BODY_BYTES) {
    request.resume();
    throw new HttpBodyError(413, 'request body too large');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_MCP_BODY_BYTES) {
      request.resume();
      throw new HttpBodyError(413, 'request body too large');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpBodyError(400, 'invalid JSON request');
  }
}
