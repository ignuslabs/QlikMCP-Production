import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatRequestDiagnostic,
  QLIK_EMBED_SERVER_HOST,
  QLIK_EMBED_SERVER_PORT,
  resolveFixtureRequest,
  SAFE_STATIC_HEADERS,
} from '../../../scripts/browser/serveQlikEmbedLocal.js';

const fixtureRoot = resolve('/tmp', 'qlik-browser-fixture-test');

describe('safe qlik-embed localhost server', () => {
  it('uses a fixed loopback address and port', () => {
    expect(QLIK_EMBED_SERVER_HOST).toBe('127.0.0.1');
    expect(QLIK_EMBED_SERVER_PORT).toBe(4173);
  });

  it('maps the root to index.html and ignores query and fragment data', () => {
    const decision = resolveFixtureRequest(
      'GET',
      '/?code=query-secret&state=state-secret#hash-secret',
      fixtureRoot,
    );

    expect(decision).toMatchObject({
      kind: 'file',
      method: 'GET',
      pathname: '/',
      statusCode: 200,
      contentType: 'text/html; charset=utf-8',
      absolutePath: resolve(fixtureRoot, 'index.html'),
    });
    const diagnostic = formatRequestDiagnostic(decision);
    expect(diagnostic).toBe('[qlik-browser-server] request method=GET pathname=/ status=200');
    expect(diagnostic).not.toMatch(/query-secret|state-secret|hash-secret|code=|state=/);
  });

  it.each([
    '/../outside.html',
    '/nested/../outside.html',
    '/%2e%2e/outside.html',
    '/nested/%2E%2E/outside.html',
    '/..%2foutside.html',
    '/%2e%2e%5coutside.html',
    '//outside.example/index.html',
  ])('rejects traversal-shaped target %s', (target) => {
    expect(resolveFixtureRequest('GET', target, fixtureRoot)).toMatchObject({
      kind: 'reject',
      statusCode: 400,
    });
  });

  it('allows only GET and HEAD', () => {
    expect(resolveFixtureRequest('HEAD', '/render-example.js', fixtureRoot)).toMatchObject({
      kind: 'file',
      method: 'HEAD',
      statusCode: 200,
      contentType: 'text/javascript; charset=utf-8',
    });
    expect(resolveFixtureRequest('POST', '/index.html?token=not-logged', fixtureRoot)).toEqual({
      kind: 'reject',
      method: 'POST',
      pathname: '/index.html',
      statusCode: 405,
    });
  });

  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['render-example.js', 'text/javascript; charset=utf-8'],
    ['fixture.css', 'text/css; charset=utf-8'],
    ['descriptor.json', 'application/json; charset=utf-8'],
  ])('assigns a fixed content type to %s', (filename, contentType) => {
    expect(resolveFixtureRequest('GET', `/${filename}`, fixtureRoot)).toMatchObject({
      kind: 'file',
      contentType,
    });
  });

  it('does not provide directory listings or unsupported content types', () => {
    expect(resolveFixtureRequest('GET', '/nested/', fixtureRoot)).toMatchObject({
      kind: 'reject',
      statusCode: 404,
    });
    expect(resolveFixtureRequest('GET', '/private.pem', fixtureRoot)).toMatchObject({
      kind: 'reject',
      statusCode: 404,
    });
  });

  it('sets no-store and defensive response headers', () => {
    expect(SAFE_STATIC_HEADERS).toMatchObject({
      'Cache-Control': 'no-store, max-age=0',
      'Content-Security-Policy': "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
  });
});
