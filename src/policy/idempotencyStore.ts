import { createHash } from 'node:crypto';
import { createError } from '../domain/errors.js';
import { redactForAudit } from '../domain/redaction.js';
import type { ConnectionAlias, IdempotencyRecord, IdempotencyStatus } from '../domain/types.js';
import {
  configuredStatePath,
  isRecord,
  readJsonStateSnapshot,
  requireString,
  withStateFileLockSync,
  writeJsonStateAtomic,
} from './filePersistence.js';
import type { Awaitable } from './storeTypes.js';

export interface IdempotencyBindingParams {
  readonly actor: string;
  readonly connectionAlias: ConnectionAlias;
  readonly appId: string;
  readonly sheetId: string;
  readonly planHash: string;
}

export type IdempotencyLookup =
  | { readonly kind: 'miss' }
  | { readonly kind: 'replay'; readonly record: IdempotencyRecord }
  | { readonly kind: 'conflict'; readonly record: IdempotencyRecord };

export interface IdempotencyRepository {
  lookup(key: string, params: IdempotencyBindingParams): Awaitable<IdempotencyLookup>;
  beginInProgress(
    key: string,
    params: IdempotencyBindingParams,
    operationId: string,
  ): Awaitable<void>;
  complete(key: string, result: unknown): Awaitable<void>;
  fail(key: string): Awaitable<void>;
}

interface IdempotencyStateFile {
  readonly version: 1;
  readonly records: readonly IdempotencyRecord[];
}

const IDEMPOTENCY_STATES = new Set(['in-progress', 'completed', 'failed']);
const KEY_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const LEGACY_REDACTED_KEY = '[redacted]';

export function digestKey(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

export function validateRecord(value: unknown): IdempotencyRecord {
  if (!isRecord(value)) throw new Error('Durable idempotency entry must be an object.');
  for (const key of [
    'idempotencyKey',
    'actor',
    'connectionAlias',
    'appId',
    'sheetId',
    'planHash',
    'status',
    'operationId',
  ]) {
    requireString(value, key);
  }
  if (!IDEMPOTENCY_STATES.has(value.status as string)) {
    throw new Error('Durable idempotency entry has an invalid status.');
  }
  const storedKey = value.idempotencyKey as string;
  if (storedKey === LEGACY_REDACTED_KEY) {
    throw new Error(
      'Durable idempotency state contains an unrecoverable redacted key; refusing unsafe replay.',
    );
  }
  return {
    ...(value as unknown as IdempotencyRecord),
    idempotencyKey: KEY_DIGEST_PATTERN.test(storedKey) ? storedKey : digestKey(storedKey),
  };
}

function validateState(value: unknown): IdempotencyStateFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) {
    throw new Error('Durable idempotency state has an unsupported shape or version.');
  }
  const records = value.records.map(validateRecord);
  if (new Set(records.map((record) => record.idempotencyKey)).size !== records.length) {
    throw new Error('Durable idempotency state contains duplicate keys.');
  }
  return { version: 1, records };
}

/** In-memory idempotency state with an optional durable file implementation below. */
export class IdempotencyStore {
  protected records = new Map<string, IdempotencyRecord>();

  protected prepare(): void {}

  protected commit(): void {}

  lookup(key: string, params: IdempotencyBindingParams): IdempotencyLookup {
    this.prepare();
    const existing = this.records.get(digestKey(key));
    if (!existing) return { kind: 'miss' };
    const bindingMatches =
      existing.actor === params.actor &&
      existing.connectionAlias === params.connectionAlias &&
      existing.appId === params.appId &&
      existing.sheetId === params.sheetId &&
      existing.planHash === params.planHash;
    if (bindingMatches && existing.status === 'completed') {
      return { kind: 'replay', record: existing };
    }
    return { kind: 'conflict', record: existing };
  }

  beginInProgress(key: string, params: IdempotencyBindingParams, operationId: string): void {
    this.prepare();
    const keyDigest = digestKey(key);
    if (this.records.has(keyDigest)) {
      throw createError('IDEMPOTENCY_CONFLICT', { details: { idempotencyKey: keyDigest } });
    }
    this.records.set(keyDigest, {
      idempotencyKey: keyDigest,
      actor: params.actor,
      connectionAlias: params.connectionAlias,
      appId: params.appId,
      sheetId: params.sheetId,
      planHash: params.planHash,
      status: 'in-progress' satisfies IdempotencyStatus,
      operationId,
    });
    this.commit();
  }

  complete(key: string, result: unknown): void {
    this.prepare();
    const keyDigest = digestKey(key);
    const record = this.records.get(keyDigest);
    if (!record || record.status !== 'in-progress') {
      throw createError('IDEMPOTENCY_CONFLICT', { details: { idempotencyKey: keyDigest } });
    }
    record.status = 'completed';
    record.result = redactForAudit(result);
    this.commit();
  }

  fail(key: string): void {
    this.prepare();
    const keyDigest = digestKey(key);
    const record = this.records.get(keyDigest);
    if (!record) {
      throw createError('IDEMPOTENCY_CONFLICT', { details: { idempotencyKey: keyDigest } });
    }
    record.status = 'failed';
    this.commit();
  }
}

export class FileIdempotencyStore extends IdempotencyStore {
  private snapshot: string | undefined;

  constructor(private readonly filePath: string) {
    super();
    this.reload();
  }

  protected override prepare(): void {
    this.reload();
  }

  protected override commit(): void {
    const state: IdempotencyStateFile = { version: 1, records: [...this.records.values()] };
    withStateFileLockSync(this.filePath, () => {
      const current = readJsonStateSnapshot(this.filePath).raw;
      if (current !== this.snapshot) {
        throw new Error('Durable idempotency state changed concurrently; retry the operation.');
      }
      writeJsonStateAtomic(this.filePath, redactForAudit(state));
      this.snapshot = readJsonStateSnapshot(this.filePath).raw;
    });
  }

  private reload(): void {
    const snapshot = readJsonStateSnapshot(this.filePath);
    this.snapshot = snapshot.raw;
    if (snapshot.value === undefined) {
      this.records = new Map();
      return;
    }
    const state = validateState(snapshot.value);
    this.records = new Map(state.records.map((record) => [record.idempotencyKey, record]));
  }
}

export function createDefaultIdempotencyStore(): IdempotencyStore {
  const filePath = configuredStatePath('QLIK_HARNESS_IDEMPOTENCY_STORE_PATH', 'idempotency.json');
  return filePath ? new FileIdempotencyStore(filePath) : new IdempotencyStore();
}
