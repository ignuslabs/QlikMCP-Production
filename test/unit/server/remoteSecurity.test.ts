import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authenticateBearer,
  correlationId,
  FixedWindowQuota,
} from '../../../src/server/remoteSecurity.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let issuer = '';
let server: ReturnType<typeof createServer>;
function token(audience = 'api://harness', claims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'user-1',
      azp: 'host-1',
      aud: audience,
      iss: issuer,
      exp: Math.floor(Date.now() / 1000) + 60,
      ...claims,
    }),
  ).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString(
    'base64url',
  );
  return `${header}.${payload}.${signature}`;
}
beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  issuer = `http://127.0.0.1:${address.port}`;
});
afterAll(() => server.close());

describe('remote transport security', () => {
  it('verifies signature, issuer, lifetime, audience and maps host identity', async () => {
    await expect(
      authenticateBearer(`Bearer ${token()}`, {
        audience: 'api://harness',
        issuer,
        jwksUri: issuer,
      }),
    ).resolves.toEqual({ subject: 'user-1', clientId: 'host-1', scopes: [] });
    await expect(
      authenticateBearer(`Bearer ${token('wrong')}`, {
        audience: 'api://harness',
        issuer,
        jwksUri: issuer,
      }),
    ).rejects.toThrow('claims');
  });
  it('enforces AgentCore client and scope constraints including Cognito client_id', async () => {
    const config = {
      audience: 'api://harness',
      issuer,
      jwksUri: issuer,
      allowedClientIds: ['host-1'],
      requiredScopes: ['qlik.invoke'],
    };
    await expect(
      authenticateBearer(`Bearer ${token('api://harness', { scope: 'qlik.invoke' })}`, config),
    ).resolves.toMatchObject({ clientId: 'host-1', scopes: ['qlik.invoke'] });
    await expect(
      authenticateBearer(
        `Bearer ${token('api://harness', {
          azp: undefined,
          client_id: 'host-1',
          scp: ['qlik.invoke'],
        })}`,
        config,
      ),
    ).resolves.toMatchObject({ clientId: 'host-1', scopes: ['qlik.invoke'] });
    await expect(
      authenticateBearer(
        `Bearer ${token('api://harness', { azp: 'other-client', scope: 'qlik.invoke' })}`,
        config,
      ),
    ).rejects.toThrow('client is not allowed');
    await expect(authenticateBearer(`Bearer ${token()}`, config)).rejects.toThrow(
      'required invocation scope',
    );
    await expect(
      authenticateBearer(`Bearer ${token('api://harness', { scope: 42 })}`, config),
    ).rejects.toThrow('scopes are malformed');
  });
  it('isolates signing keys by identity provider and coalesces concurrent discovery', async () => {
    let requests = 0;
    const isolated = createServer((_request, response) => {
      requests += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [] }));
    });
    await new Promise<void>((resolve) => isolated.listen(0, '127.0.0.1', resolve));
    const address = isolated.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          authenticateBearer(`Bearer ${token()}`, {
            audience: 'api://harness',
            issuer,
            jwksUri: `http://127.0.0.1:${address.port}`,
          }),
        ),
      );
      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => isolated.close(() => resolve()));
    }
  });
  it('bounds subject quota state and rejects invalid limits', () => {
    expect(() => new FixedWindowQuota(0)).toThrow('positive');
    const quota = new FixedWindowQuota(1, 100);
    for (let index = 0; index < 10_000; index += 1)
      expect(quota.consume(String(index), 0)).toBe(true);
    expect(quota.consume('overflow', 1)).toBe(false);
    expect(quota.consume('overflow', 101)).toBe(true);
  });
  it('enforces a fixed-window subject quota', () => {
    const quota = new FixedWindowQuota(2, 100);
    expect(quota.consume('subject', 0)).toBe(true);
    expect(quota.consume('subject', 1)).toBe(true);
    expect(quota.consume('subject', 2)).toBe(false);
    expect(quota.consume('subject', 101)).toBe(true);
  });
  it('accepts only bounded safe correlation values', () => {
    expect(correlationId({ 'x-correlation-id': 'client_trace-1' })).toBe('client_trace-1');
    expect(correlationId({ 'x-correlation-id': 'bad value\n' })).toMatch(/^[0-9a-f-]{36}$/);
  });
});
