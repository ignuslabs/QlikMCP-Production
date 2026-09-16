import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createError } from '../domain/errors.js';
import type { ManagementRecord, ManagementStore } from './state.js';

export const ARTIFACT_CHUNK_BYTES = 192 * 1024;
const metadataSchema = z
  .object({
    connection: z.string().trim().min(1).max(128),
    spaceId: z.string().trim().min(1).max(128).optional(),
    appId: z.string().trim().min(1).max(128).optional(),
    filename: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          !/[\\/]/.test(value) && ![...value].some((character) => character.charCodeAt(0) < 32),
      ),
    mimeType: z.string().min(1).max(150),
    csvDelimiter: z.enum([',', ';', '\t', '|']).optional(),
    byteLength: z
      .number()
      .int()
      .min(1)
      .max(200 * 1024 * 1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    purpose: z.enum(['dataset', 'app-export', 'reload-log', 'data-export']),
  })
  .strict();
export type ArtifactMetadata = z.infer<typeof metadataSchema>;

export class ArtifactService {
  constructor(
    private readonly store: ManagementStore,
    private readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  async begin(owner: string, metadata: ArtifactMetadata): Promise<Record<string, unknown>> {
    const parsed = metadataSchema.parse(metadata);
    if (parsed.byteLength > this.maxBytes)
      throw createError('MALFORMED_REQUEST', {
        message: 'Artifact exceeds the configured size limit.',
      });
    const artifactId = `artifact-${randomUUID()}`;
    const record: ManagementRecord = {
      id: artifactId,
      owner,
      version: 1,
      kind: 'artifact',
      expiresAt: new Date(this.now() + 24 * 60 * 60 * 1000).toISOString(),
      data: {
        ...parsed,
        status: 'uploading',
        chunkCount: Math.ceil(parsed.byteLength / ARTIFACT_CHUNK_BYTES),
      },
    };
    await this.store.put(record, null);
    return {
      artifactId,
      ...record.data,
      chunkBytes: ARTIFACT_CHUNK_BYTES,
      expiresAt: record.expiresAt,
    };
  }

  async inspect(owner: string, artifactId: string): Promise<ManagementRecord> {
    const record = await this.store.get(owner, artifactId);
    if (!record || record.kind !== 'artifact' || Date.parse(record.expiresAt) <= this.now())
      throw createError('MALFORMED_REQUEST', { message: 'Artifact is missing or expired.' });
    metadataSchema.parse(
      Object.fromEntries(
        Object.entries(record.data).filter(([name]) => name !== 'status' && name !== 'chunkCount'),
      ),
    );
    return record;
  }

  async chunk(
    owner: string,
    artifactId: string,
    index: number,
    contentBase64: string,
  ): Promise<Record<string, unknown>> {
    const artifact = await this.inspect(owner, artifactId);
    if (artifact.data.status !== 'uploading') throw createError('IDEMPOTENCY_CONFLICT');
    const count = Number(artifact.data.chunkCount);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= count ||
      contentBase64.length > Math.ceil(ARTIFACT_CHUNK_BYTES / 3) * 4
    )
      throw createError('MALFORMED_REQUEST');
    const bytes = Buffer.from(contentBase64, 'base64');
    const expected =
      index === count - 1
        ? Number(artifact.data.byteLength) - index * ARTIFACT_CHUNK_BYTES
        : ARTIFACT_CHUNK_BYTES;
    if (bytes.toString('base64') !== contentBase64 || bytes.length !== expected)
      throw createError('MALFORMED_REQUEST', {
        message: 'Chunk encoding or length does not match the upload manifest.',
      });
    const id = `${artifactId}/chunk/${index}`;
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const old = await this.store.get(owner, id);
    if (old) {
      if (old.data.sha256 !== checksum) throw createError('IDEMPOTENCY_CONFLICT');
      return { artifactId, index, accepted: true, replayed: true };
    }
    await this.store.put(
      {
        id,
        owner,
        version: 1,
        kind: 'chunk',
        expiresAt: artifact.expiresAt,
        data: { contentBase64, sha256: checksum },
      },
      null,
    );
    return { artifactId, index, accepted: true, replayed: false };
  }

  private async assemble(owner: string, artifact: ManagementRecord): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for (let index = 0; index < Number(artifact.data.chunkCount); index++) {
      const chunk = await this.store.get(owner, `${artifact.id}/chunk/${index}`);
      if (!chunk || chunk.kind !== 'chunk' || typeof chunk.data.contentBase64 !== 'string')
        throw createError('MALFORMED_REQUEST', { message: 'The upload has missing chunks.' });
      chunks.push(Buffer.from(chunk.data.contentBase64, 'base64'));
    }
    const bytes = Buffer.concat(chunks);
    if (
      bytes.length !== artifact.data.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.data.sha256
    )
      throw createError('MALFORMED_REQUEST', { message: 'Artifact checksum verification failed.' });
    return bytes;
  }

  async finish(
    owner: string,
    artifactId: string,
    validateContent?: (bytes: Buffer, metadata: ArtifactMetadata) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const artifact = await this.inspect(owner, artifactId);
    const bytes = await this.assemble(owner, artifact);
    const { status: _status, chunkCount: _chunkCount, ...metadata } = artifact.data;
    if (validateContent) await validateContent(bytes, metadataSchema.parse(metadata));
    if (artifact.data.status !== 'sealed')
      await this.store.put(
        {
          ...artifact,
          version: artifact.version + 1,
          data: { ...artifact.data, status: 'sealed' },
        },
        artifact.version,
      );
    return {
      artifactId,
      status: 'sealed',
      sha256: artifact.data.sha256,
      byteLength: artifact.data.byteLength,
    };
  }

  async read(
    owner: string,
    artifactId: string,
  ): Promise<{ metadata: ArtifactMetadata; bytes: Buffer }> {
    const artifact = await this.inspect(owner, artifactId);
    if (artifact.data.status !== 'sealed')
      throw createError('MALFORMED_REQUEST', {
        message: 'Complete and verify all upload chunks first.',
      });
    const { status: _status, chunkCount: _chunkCount, ...metadata } = artifact.data;
    return {
      metadata: metadataSchema.parse(metadata),
      bytes: await this.assemble(owner, artifact),
    };
  }

  async downloadChunk(
    owner: string,
    artifactId: string,
    index: number,
  ): Promise<Record<string, unknown>> {
    const artifact = await this.inspect(owner, artifactId);
    if (
      artifact.data.status !== 'sealed' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= Number(artifact.data.chunkCount)
    )
      throw createError('MALFORMED_REQUEST');
    const chunk = await this.store.get(owner, `${artifactId}/chunk/${index}`);
    if (!chunk) throw createError('MALFORMED_REQUEST');
    return {
      artifactId,
      index,
      chunkCount: artifact.data.chunkCount,
      filename: artifact.data.filename,
      contentBase64: chunk.data.contentBase64,
      sha256: chunk.data.sha256,
      artifactSha256: artifact.data.sha256,
      byteLength: artifact.data.byteLength,
    };
  }

  async save(
    owner: string,
    bytes: Buffer,
    metadata: Omit<ArtifactMetadata, 'byteLength' | 'sha256'>,
  ): Promise<{ artifactId: string }> {
    const started = await this.begin(owner, {
      ...metadata,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const artifactId = String(started.artifactId);
    for (let offset = 0, index = 0; offset < bytes.length; offset += ARTIFACT_CHUNK_BYTES, index++)
      await this.chunk(
        owner,
        artifactId,
        index,
        bytes.subarray(offset, offset + ARTIFACT_CHUNK_BYTES).toString('base64'),
      );
    await this.finish(owner, artifactId);
    return { artifactId };
  }
}
