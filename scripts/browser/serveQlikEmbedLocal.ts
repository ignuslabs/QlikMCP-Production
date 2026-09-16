import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const QLIK_EMBED_SERVER_HOST = '127.0.0.1' as const;
export const QLIK_EMBED_SERVER_PORT = 4173 as const;

export const SAFE_STATIC_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  'Content-Security-Policy': "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
});

const ALLOWED_METHODS = 'GET, HEAD';
const INVALID_PATHNAME = '/<invalid>';
const MAX_DIAGNOSTIC_PATHNAME_LENGTH = 256;

export interface FixtureFileDecision {
  readonly kind: 'file';
  readonly method: 'GET' | 'HEAD';
  readonly pathname: string;
  readonly absolutePath: string;
  readonly contentType: string;
  readonly statusCode: 200;
}

export interface FixtureRejectionDecision {
  readonly kind: 'reject';
  readonly method: string;
  readonly pathname: string;
  readonly statusCode: 400 | 404 | 405;
}

export type FixtureRequestDecision = FixtureFileDecision | FixtureRejectionDecision;

function sanitizedMethod(method: string | undefined): string {
  const candidate = method?.toUpperCase() ?? 'UNKNOWN';
  return /^[A-Z]{1,16}$/.test(candidate) ? candidate : 'UNKNOWN';
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
}

function diagnosticPathname(pathname: string): string {
  const withoutControls = [...pathname]
    .filter((character) => !isControlCharacter(character))
    .join('');
  if (withoutControls.length <= MAX_DIAGNOSTIC_PATHNAME_LENGTH) return withoutControls;
  return `${withoutControls.slice(0, MAX_DIAGNOSTIC_PATHNAME_LENGTH)}...`;
}

function parseOriginFormTarget(
  target: string | undefined,
):
  | { readonly ok: true; readonly decodedPathname: string; readonly pathname: string }
  | { readonly ok: false } {
  if (!target?.startsWith('/') || target.startsWith('//')) return { ok: false };

  const queryIndex = target.indexOf('?');
  const hashIndex = target.indexOf('#');
  const boundaryCandidates = [queryIndex, hashIndex].filter((index) => index >= 0);
  const boundary = boundaryCandidates.length > 0 ? Math.min(...boundaryCandidates) : target.length;
  const pathname = target.slice(0, boundary);

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return { ok: false };
  }

  if (
    decodedPathname.includes('\\') ||
    [...decodedPathname].some(isControlCharacter) ||
    decodedPathname.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return { ok: false };
  }

  return { ok: true, decodedPathname, pathname: diagnosticPathname(pathname) };
}

function isContainedPath(rootDirectory: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootDirectory, candidatePath);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  );
}

export function resolveFixtureRequest(
  method: string | undefined,
  target: string | undefined,
  rootDirectory: string,
): FixtureRequestDecision {
  const safeMethod = sanitizedMethod(method);
  const parsedTarget = parseOriginFormTarget(target);
  if (!parsedTarget.ok) {
    return { kind: 'reject', method: safeMethod, pathname: INVALID_PATHNAME, statusCode: 400 };
  }

  if (safeMethod !== 'GET' && safeMethod !== 'HEAD') {
    return {
      kind: 'reject',
      method: safeMethod,
      pathname: parsedTarget.pathname,
      statusCode: 405,
    };
  }

  if (parsedTarget.decodedPathname !== '/' && parsedTarget.decodedPathname.endsWith('/')) {
    return {
      kind: 'reject',
      method: safeMethod,
      pathname: parsedTarget.pathname,
      statusCode: 404,
    };
  }

  const relativeFile =
    parsedTarget.decodedPathname === '/' ? 'index.html' : parsedTarget.decodedPathname.slice(1);
  const contentType = CONTENT_TYPES[extname(relativeFile) as keyof typeof CONTENT_TYPES];
  const normalizedRoot = resolve(rootDirectory);
  const absolutePath = resolve(normalizedRoot, relativeFile);
  if (!contentType || !isContainedPath(normalizedRoot, absolutePath)) {
    return {
      kind: 'reject',
      method: safeMethod,
      pathname: parsedTarget.pathname,
      statusCode: 404,
    };
  }

  return {
    kind: 'file',
    method: safeMethod,
    pathname: parsedTarget.pathname,
    absolutePath,
    contentType,
    statusCode: 200,
  };
}

export function formatRequestDiagnostic(decision: FixtureRequestDecision): string {
  return `[qlik-browser-server] request method=${decision.method} pathname=${decision.pathname} status=${decision.statusCode}`;
}

function writeDiagnostic(message: string): void {
  process.stderr.write(`${message}\n`);
}

function writeResponse(
  response: ServerResponse,
  statusCode: number,
  body: Buffer | string,
  headers: Readonly<Record<string, string>> = {},
  headOnly = false,
): void {
  response.writeHead(statusCode, { ...SAFE_STATIC_HEADERS, ...headers });
  response.end(headOnly ? undefined : body);
}

function rejectionBody(statusCode: FixtureRejectionDecision['statusCode']): string {
  if (statusCode === 400) return 'Bad request.\n';
  if (statusCode === 405) return 'Method not allowed.\n';
  return 'Not found.\n';
}

async function readContainedFile(
  rootDirectory: string,
  absolutePath: string,
): Promise<Buffer | undefined> {
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([
      realpath(rootDirectory),
      realpath(absolutePath),
    ]);
    if (!isContainedPath(resolvedRoot, resolvedFile)) return undefined;
    const fileStat = await stat(resolvedFile);
    if (!fileStat.isFile()) return undefined;
    return await readFile(resolvedFile);
  } catch {
    return undefined;
  }
}

export function createQlikEmbedLocalServer(rootDirectory: string): Server {
  return createServer((request, response) => {
    void (async () => {
      const decision = resolveFixtureRequest(request.method, request.url, rootDirectory);
      if (decision.kind === 'reject') {
        const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' };
        if (decision.statusCode === 405) headers.Allow = ALLOWED_METHODS;
        writeResponse(
          response,
          decision.statusCode,
          rejectionBody(decision.statusCode),
          headers,
          decision.method === 'HEAD',
        );
        writeDiagnostic(formatRequestDiagnostic(decision));
        return;
      }

      const body = await readContainedFile(rootDirectory, decision.absolutePath);
      if (!body) {
        const missingDecision: FixtureRejectionDecision = {
          kind: 'reject',
          method: decision.method,
          pathname: decision.pathname,
          statusCode: 404,
        };
        writeResponse(
          response,
          404,
          rejectionBody(404),
          { 'Content-Type': 'text/plain; charset=utf-8' },
          decision.method === 'HEAD',
        );
        writeDiagnostic(formatRequestDiagnostic(missingDecision));
        return;
      }

      writeResponse(
        response,
        200,
        body,
        { 'Content-Type': decision.contentType },
        decision.method === 'HEAD',
      );
      writeDiagnostic(formatRequestDiagnostic(decision));
    })().catch(() => {
      if (!response.headersSent) {
        writeResponse(
          response,
          500,
          'Internal server error.\n',
          { 'Content-Type': 'text/plain; charset=utf-8' },
          request.method === 'HEAD',
        );
      } else {
        response.end();
      }
      const method = sanitizedMethod(request.method);
      const parsedTarget = parseOriginFormTarget(request.url);
      const pathname = parsedTarget.ok ? parsedTarget.pathname : INVALID_PATHNAME;
      writeDiagnostic(
        `[qlik-browser-server] request method=${method} pathname=${pathname} status=500 code=REQUEST_FAILURE`,
      );
    });
  });
}

function installGracefulShutdown(server: Server): void {
  let shuttingDown = false;
  const shutdown = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeDiagnostic(`[qlik-browser-server] shutdown signal=${signal}`);
    server.close((error) => {
      if (error) {
        writeDiagnostic('[qlik-browser-server] shutdown status=failed code=SERVER_CLOSE_FAILURE');
        process.exitCode = 1;
        return;
      }
      writeDiagnostic('[qlik-browser-server] shutdown status=complete');
    });
    server.closeIdleConnections();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const rootDirectory = resolve(scriptDirectory, '..', '..', 'examples', 'qlik-embed', '.local');
  try {
    const rootStat = await stat(rootDirectory);
    if (!rootStat.isDirectory()) throw new Error('Not a directory.');
  } catch {
    writeDiagnostic(
      '[qlik-browser-server] startup status=failed code=FIXTURE_NOT_PREPARED action=run-browser-prepare',
    );
    process.exitCode = 1;
    return;
  }
  const server = createQlikEmbedLocalServer(rootDirectory);
  installGracefulShutdown(server);

  server.once('error', (error: NodeJS.ErrnoException) => {
    const code =
      error.code === 'EADDRINUSE' || error.code === 'EACCES' ? error.code : 'SERVER_START_FAILURE';
    writeDiagnostic(`[qlik-browser-server] startup status=failed code=${code}`);
    process.exitCode = 1;
  });
  server.listen(QLIK_EMBED_SERVER_PORT, QLIK_EMBED_SERVER_HOST, () => {
    writeDiagnostic(
      `[qlik-browser-server] startup status=ready origin=http://${QLIK_EMBED_SERVER_HOST}:${QLIK_EMBED_SERVER_PORT} root=examples/qlik-embed/.local`,
    );
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void main();
}
