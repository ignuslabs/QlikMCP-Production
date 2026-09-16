import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../../../src/policy/approvalStore.js';

const binding = {
  planHash: 'sha256:abc',
  actor: 'actor-1',
  connectionAlias: 'cloud-dev',
  appId: 'app-1',
  sheetId: 'sheet-1',
};

function issue(
  store: ApprovalStore,
  params: typeof binding & { riskClass: 'standard'; ttlMs: number },
) {
  const request = store.request({ ...params, requestingActor: params.actor, ttlMs: 60_000 });
  return store.approve(request.requestId, 'approver', params.ttlMs);
}

describe('ApprovalStore', () => {
  it('keeps a request pending until approval and exposes no token on the request', () => {
    const store = new ApprovalStore();
    const request = store.request({
      ...binding,
      requestingActor: binding.actor,
      riskClass: 'standard',
      ttlMs: 60_000,
    });
    expect(request).toMatchObject({ status: 'pending' });
    expect(request.approvalToken).toBeUndefined();
    const approval = store.approve(request.requestId, 'authorized-approver', 60_000);
    expect(approval.actor).toBe(binding.actor);
    expect(approval.reviewedBy).toBe('authorized-approver');
    expect(store.getRequest(request.requestId)).toMatchObject({
      status: 'approved',
      decidedBy: 'authorized-approver',
    });
  });

  it('prohibits a requester from deciding their own request', () => {
    const store = new ApprovalStore();
    const request = store.request({
      ...binding,
      requestingActor: binding.actor,
      riskClass: 'standard',
      ttlMs: 60_000,
    });
    expect(() => store.approve(request.requestId, binding.actor, 60_000)).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
    expect(() => store.reject(request.requestId, binding.actor)).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
  });

  it('makes rejection terminal and never issues a token', () => {
    const store = new ApprovalStore();
    const request = store.request({
      ...binding,
      requestingActor: binding.actor,
      riskClass: 'standard',
      ttlMs: 60_000,
    });
    store.reject(request.requestId, 'authorized-approver', 'not acceptable');
    expect(store.getRequest(request.requestId)?.approvalToken).toBeUndefined();
    expect(() => store.approve(request.requestId, 'authorized-approver', 60_000)).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_ALREADY_DECIDED' }),
    );
  });

  it('does not permit a decision after request expiry', () => {
    const store = new ApprovalStore();
    const request = store.request({
      ...binding,
      requestingActor: binding.actor,
      riskClass: 'standard',
      ttlMs: -1,
    });
    expect(() => store.approve(request.requestId, 'authorized-approver', 60_000)).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_REQUEST_EXPIRED' }),
    );
  });
  it('issues a single-use approval bound to actor/target/plan hash/risk/expiry', () => {
    const store = new ApprovalStore();
    const approval = issue(store, { ...binding, riskClass: 'standard', ttlMs: 60_000 });
    expect(approval.consumed).toBe(false);
    expect(approval.singleUse).toBe(true);
    expect(store.get(approval.approvalToken)).toEqual(approval);
  });

  it('validates and consumes a matching approval exactly once', () => {
    const store = new ApprovalStore();
    const approval = issue(store, { ...binding, riskClass: 'standard', ttlMs: 60_000 });
    expect(() => store.assertValidForApply(approval.approvalToken, binding)).not.toThrow();
    store.consume(approval.approvalToken, 'idempotency-key-1');
    expect(store.get(approval.approvalToken)?.consumed).toBe(true);
  });

  it('rejects replay of an already-consumed approval', () => {
    const store = new ApprovalStore();
    const approval = issue(store, { ...binding, riskClass: 'standard', ttlMs: 60_000 });
    store.consume(approval.approvalToken, 'key-1');
    expect.assertions(1);
    try {
      store.assertValidForApply(approval.approvalToken, binding);
    } catch (error) {
      expect((error as { code: string }).code).toBe('APPROVAL_REPLAYED');
    }
  });

  it('rejects an expired approval', () => {
    const store = new ApprovalStore();
    const approval = issue(store, { ...binding, riskClass: 'standard', ttlMs: -1 });
    expect.assertions(1);
    try {
      store.assertValidForApply(approval.approvalToken, binding);
    } catch (error) {
      expect((error as { code: string }).code).toBe('APPROVAL_EXPIRED');
    }
  });

  it('rejects an actor mismatch', () => {
    const store = new ApprovalStore();
    const approval = issue(store, { ...binding, riskClass: 'standard', ttlMs: 60_000 });
    expect.assertions(1);
    try {
      store.assertValidForApply(approval.approvalToken, { ...binding, actor: 'someone-else' });
    } catch (error) {
      expect((error as { code: string }).code).toBe('APPROVAL_ACTOR_MISMATCH');
    }
  });

  it('rejects a plan hash mismatch', () => {
    const store = new ApprovalStore();
    const approval = issue(store, { ...binding, riskClass: 'standard', ttlMs: 60_000 });
    expect.assertions(1);
    try {
      store.assertValidForApply(approval.approvalToken, {
        ...binding,
        planHash: 'sha256:different',
      });
    } catch (error) {
      expect((error as { code: string }).code).toBe('APPROVAL_PLAN_HASH_MISMATCH');
    }
  });

  it('rejects a target (connection/app/sheet) mismatch', () => {
    const store = new ApprovalStore();
    const approval = issue(store, { ...binding, riskClass: 'standard', ttlMs: 60_000 });
    expect.assertions(1);
    try {
      store.assertValidForApply(approval.approvalToken, {
        ...binding,
        sheetId: 'a-different-sheet',
      });
    } catch (error) {
      expect((error as { code: string }).code).toBe('APPROVAL_TARGET_MISMATCH');
    }
  });

  it('reports a missing approval token distinctly', () => {
    const store = new ApprovalStore();
    expect.assertions(1);
    try {
      store.assertValidForApply('never-issued', binding);
    } catch (error) {
      expect((error as { code: string }).code).toBe('APPROVAL_NOT_FOUND');
    }
  });
});
