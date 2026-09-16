import { describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../../../src/policy/idempotencyStore.js';

const binding = {
  actor: 'actor-1',
  connectionAlias: 'cloud-dev',
  appId: 'app-1',
  sheetId: 'sheet-1',
  planHash: 'sha256:abc',
};

describe('IdempotencyStore', () => {
  it('reports a miss for an unseen key', () => {
    const store = new IdempotencyStore();
    expect(store.lookup('key-1', binding)).toEqual({ kind: 'miss' });
  });

  it('replays a completed operation for a matching binding', () => {
    const store = new IdempotencyStore();
    store.beginInProgress('key-1', binding, 'operation-1');
    store.complete('key-1', { objectId: 'object-1' });
    const lookup = store.lookup('key-1', binding);
    expect(lookup.kind).toBe('replay');
    if (lookup.kind === 'replay') {
      expect(lookup.record.result).toEqual({ objectId: 'object-1' });
      expect(lookup.record.operationId).toBe('operation-1');
    }
  });

  it('reports a conflict when the same key is reused for a different plan', () => {
    const store = new IdempotencyStore();
    store.beginInProgress('key-1', binding, 'operation-1');
    store.complete('key-1', { objectId: 'object-1' });
    const lookup = store.lookup('key-1', { ...binding, planHash: 'sha256:different' });
    expect(lookup.kind).toBe('conflict');
  });

  it('reports a conflict for a key that is still in progress', () => {
    const store = new IdempotencyStore();
    store.beginInProgress('key-1', binding, 'operation-1');
    expect(store.lookup('key-1', binding).kind).toBe('conflict');
  });

  it('reports a conflict (not a replay) for a failed prior attempt with the same key', () => {
    const store = new IdempotencyStore();
    store.beginInProgress('key-1', binding, 'operation-1');
    store.fail('key-1');
    expect(store.lookup('key-1', binding).kind).toBe('conflict');
  });
});
