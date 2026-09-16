import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ArtifactService, ARTIFACT_CHUNK_BYTES } from '../../../src/management/artifacts.js';
import { MemoryManagementStore } from '../../../src/management/state.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
describe('private artifact staging', () => {
  it('round trips several chunks with owner isolation and checksum validation', async () => {
    const service = new ArtifactService(new MemoryManagementStore(), 1024 * 1024);
    const bytes = Buffer.alloc(ARTIFACT_CHUNK_BYTES * 2 + 27, 42);
    const saved = await service.save('owner', bytes, {
      connection: 'cloud',
      spaceId: 'sandbox',
      filename: 'sample.csv',
      mimeType: 'text/csv',
      purpose: 'dataset',
    });
    expect((await service.read('owner', saved.artifactId)).bytes).toEqual(bytes);
    await expect(service.read('other', saved.artifactId)).rejects.toBeDefined();
    expect((await service.downloadChunk('owner', saved.artifactId, 2)).contentBase64).toBe(
      bytes.subarray(ARTIFACT_CHUNK_BYTES * 2).toString('base64'),
    );
    await expect(service.downloadChunk('owner', saved.artifactId, 3)).rejects.toBeDefined();
  });
  it('accepts exact chunk replay but rejects conflicting content and unsealed reads', async () => {
    const service = new ArtifactService(new MemoryManagementStore(), 1000);
    const bytes = Buffer.from('abcdef');
    const started = await service.begin('owner', {
      connection: 'cloud',
      filename: 'sample.csv',
      mimeType: 'text/csv',
      purpose: 'dataset',
      byteLength: bytes.length,
      sha256: digest(bytes),
    });
    const id = String(started.artifactId);
    await expect(service.read('owner', id)).rejects.toBeDefined();
    await service.chunk('owner', id, 0, bytes.toString('base64'));
    expect((await service.chunk('owner', id, 0, bytes.toString('base64'))).replayed).toBe(true);
    await expect(
      service.chunk('owner', id, 0, Buffer.from('ghijkl').toString('base64')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await service.finish('owner', id);
    await expect(service.chunk('owner', id, 0, bytes.toString('base64'))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
  it('rejects over-limit, malformed chunks, missing chunks, checksum mismatch, traversal and expiration', async () => {
    let time = 0;
    const service = new ArtifactService(
      new MemoryManagementStore(),
      ARTIFACT_CHUNK_BYTES + 1,
      () => time,
    );
    const meta = {
      connection: 'cloud',
      filename: 'sample.csv',
      mimeType: 'text/csv',
      purpose: 'dataset' as const,
      byteLength: 3,
      sha256: digest(Buffer.from('abc')),
    };
    await expect(
      service.begin('owner', { ...meta, byteLength: ARTIFACT_CHUNK_BYTES + 2 }),
    ).rejects.toBeDefined();
    await expect(
      service.begin('owner', { ...meta, filename: '../sample.csv' }),
    ).rejects.toBeDefined();
    const started = await service.begin('owner', meta);
    const id = String(started.artifactId);
    await expect(service.finish('owner', id)).rejects.toBeDefined();
    await expect(service.chunk('owner', id, 0, 'Y Q==')).rejects.toBeDefined();
    await service.chunk('owner', id, 0, Buffer.from('xyz').toString('base64'));
    await expect(service.finish('owner', id)).rejects.toBeDefined();
    time = 24 * 60 * 60 * 1000;
    await expect(service.inspect('owner', id)).rejects.toBeDefined();
  });
});
