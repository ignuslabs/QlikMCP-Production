import { describe, expect, it } from 'vitest';
import {
  findForbiddenPaths,
  isForbiddenKey,
  redact,
  redactForAudit,
  redactForOutput,
} from '../../../src/domain/redaction.js';

// Suspicious-looking sample values are built at runtime (not as source-code
// literals) purely so this test file itself never contains a string that
// resembles a real credential.
const samplePemBlock = ['-----BEGIN', 'CERTIFICATE-----'].join(' ');
const sampleBearerValue = ['Bearer', 'abcdefghijklmno1234567890'].join(' ');
const sampleJwtShapedValue = [
  'headersegmentvalue',
  'payloadsegmentvalue',
  'signaturesegmentvalue',
].join('.');

describe('redaction', () => {
  it('redacts common secret-shaped keys recursively', () => {
    const input = {
      user: 'alice',
      apiKey: 'sk-abc123',
      nested: { authorizationHeader: sampleBearerValue, ok: true },
      records: [{ privateKey: samplePemBlock }],
    };
    const output = redact(input) as typeof input & { records: { privateKey: string }[] };
    expect(output.apiKey).toBe('[redacted]');
    expect((output.nested as { authorizationHeader: string }).authorizationHeader).toBe(
      '[redacted]',
    );
    expect(output.records[0]!.privateKey).toBe('[redacted]');
    expect(output.user).toBe('alice');
  });

  it('redacts bearer/JWT-shaped and PEM-shaped string values regardless of key name', () => {
    const output = redact({
      note: sampleBearerValue,
      other: sampleJwtShapedValue,
      pem: samplePemBlock,
      plain: 'just a normal sentence',
    });
    expect(output.note).toBe('[redacted]');
    expect(output.other).toBe('[redacted]');
    expect(output.pem).toBe('[redacted]');
    expect(output.plain).toBe('just a normal sentence');
  });

  it('does not mutate the input value', () => {
    const input = { apiKey: 'secret-value' };
    const output = redact(input);
    expect(input.apiKey).toBe('secret-value');
    expect(output).not.toBe(input);
  });

  it('findForbiddenPaths reports dotted paths of offending keys/values', () => {
    const paths = findForbiddenPaths({ a: { b: { token: 't' } }, c: [{ password: 'p' }] });
    expect(paths).toContain('$.a.b.token');
    expect(paths).toContain('$.c[0].password');
  });

  it('isForbiddenKey distinguishes real secrets from safe harness identifiers', () => {
    expect(isForbiddenKey('apiKey')).toBe(true);
    expect(isForbiddenKey('clientSecret')).toBe(true);
    expect(isForbiddenKey('xQlikUser')).toBe(true);
    expect(isForbiddenKey('approvalToken')).toBe(false);
    expect(isForbiddenKey('idempotencyKey')).toBe(false);
  });

  it("never redacts the harness's own opaque workflow identifiers", () => {
    const output = redact({
      approvalToken: 'approval-123',
      idempotencyKey: 'key-1',
      operationId: 'operation-1',
      planHash: 'sha256:abc',
      objectId: 'object-1',
      sheetAttachmentId: 'attachment-1',
      correlationId: 'corr-1',
      rawPayloadsRemoved: true,
      sensitiveValuesRemoved: true,
      credentialMaterialPresent: false,
    });
    expect(output).toEqual({
      approvalToken: 'approval-123',
      idempotencyKey: 'key-1',
      operationId: 'operation-1',
      planHash: 'sha256:abc',
      objectId: 'object-1',
      sheetAttachmentId: 'attachment-1',
      correlationId: 'corr-1',
      rawPayloadsRemoved: true,
      sensitiveValuesRemoved: true,
      credentialMaterialPresent: false,
    });
  });

  it('redactForAudit and redactForOutput both apply the same redaction rules', () => {
    const input = { secret: 's', operationId: 'op-1' };
    expect(redactForAudit(input)).toEqual({ secret: '[redacted]', operationId: 'op-1' });
    expect(redactForOutput(input)).toEqual({ secret: '[redacted]', operationId: 'op-1' });
  });
});
