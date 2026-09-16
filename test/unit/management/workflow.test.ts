import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ManagementWorkflow,
  type ActionRegistry,
  type WorkflowStep,
} from '../../../src/management/workflow.js';
import { ManagementPolicyEngine, managementPolicySchema } from '../../../src/management/policy.js';
import { MemoryManagementStore, type ManagementRecord } from '../../../src/management/state.js';
import { createError, type SafeErrorDetails } from '../../../src/domain/errors.js';

const actor = { actor: 'owner', hostClientId: 'client' };
const now = Date.parse('2026-09-15T14:00:00Z');
function setup(requireApproval = false) {
  let time = now;
  const clock = () => time;
  const store = new MemoryManagementStore();
  const execute = vi.fn(async (input: Record<string, unknown>) => ({
    appId: input.appId ?? 'new-app',
    spaceId: 'sandbox',
    status: 'created',
    script: 'never persist content',
    rows: [['private']],
  }));
  const actions: ActionRegistry = {
    'app.create': {
      schema: z.object({ connection: z.string(), name: z.string() }).strict(),
      readOnly: false,
      inspect: async () => ({ targetSpaceId: 'sandbox' }),
      execute,
    },
    'app.get': {
      schema: z.object({ connection: z.string(), appId: z.string() }).strict(),
      readOnly: true,
      inspect: async (input) => ({
        appId: String(input.appId),
        spaceId: input.appId === 'outside' ? 'outside' : 'sandbox',
      }),
      execute,
    },
    'app.update': {
      schema: z.object({ connection: z.string(), appId: z.string() }).strict(),
      readOnly: false,
      inspect: async (input) => ({
        appId: String(input.appId),
        spaceId: input.appId === 'outside' ? 'outside' : 'sandbox',
      }),
      execute,
    },
  };
  const policy = new ManagementPolicyEngine(
    managementPolicySchema.parse({
      version: 1,
      enabled: true,
      environment: 'development',
      grants: [
        {
          ...actor,
          actor: actor.actor,
          clientId: actor.hostClientId,
          hostClientId: undefined,
          connection: 'cloud',
          actions: Object.keys(actions),
          spaceIds: ['sandbox'],
          expiresAt: '2026-09-16T00:00:00Z',
          requireApproval,
        },
      ].map(({ hostClientId: _ignored, ...grant }) => grant),
      reviewers: [{ actor: 'reviewer', clientId: 'review-client' }],
    }),
    clock,
  );
  const workflow = new ManagementWorkflow(actor, policy, store, actions, clock);
  return {
    workflow,
    store,
    execute,
    actions,
    policy,
    clock,
    advance: () => {
      time += 16 * 60 * 1000;
    },
  };
}
const createSteps: WorkflowStep[] = [
  { action: 'app.create', input: { connection: 'cloud', name: 'Example' } },
];

function customWorkflow(actions: ActionRegistry) {
  const base = setup();
  const policy = new ManagementPolicyEngine(
    {
      ...base.policy.policy,
      grants: base.policy.policy.grants.map((grant) => ({
        ...grant,
        actions: Object.keys(actions),
      })),
    },
    base.clock,
  );
  const workflow = new ManagementWorkflow(actor, policy, base.store, actions, base.clock);
  return { ...base, policy, workflow };
}

describe('production management workflow', () => {
  it('durably rejects a proven pre-dispatch conflict and releases only its owned lock', async () => {
    const base = setup();
    base.execute.mockRejectedValue(
      createError('IDEMPOTENCY_CONFLICT', {
        details: { outcome: 'rejected', dispatch: 'not-started' },
      }),
    );
    const plan = await base.workflow.plan(createSteps);
    expect(await base.workflow.execute(String(plan.planId), createSteps)).toMatchObject({
      status: 'failed',
      outcome: 'rejected',
      errorCode: 'IDEMPOTENCY_CONFLICT',
    });
    const saved = await base.store.get(actor.actor, `${plan.planId}/step/0`);
    expect(saved?.data).toMatchObject({
      status: 'failed',
      outcome: 'rejected',
      dispatch: 'not-started',
    });
    expect(saved?.data).not.toHaveProperty('providerStatus');
    expect(
      (await base.store.get('__management_locks__', String(saved?.data.lockId)))?.data.status,
    ).toBe('released');
    expect(await base.workflow.execute(String(plan.planId), createSteps)).toMatchObject({
      status: 'failed',
      outcome: 'rejected',
    });
    expect(await base.workflow.reconcile(String(plan.planId), createSteps, 0)).toMatchObject({
      status: 'failed',
      outcome: 'rejected',
    });
    expect(base.execute).toHaveBeenCalledOnce();
  });

  it('keeps a historical unmarked conflict uncertain even when no receipt was saved', async () => {
    const base = setup();
    base.execute.mockRejectedValue(createError('IDEMPOTENCY_CONFLICT'));
    const verify = vi.fn(async () => ({ verified: false }));
    const workflow = new ManagementWorkflow(
      actor,
      base.policy,
      base.store,
      { ...base.actions, 'app.update': { ...base.actions['app.update']!, verify } },
      base.clock,
    );
    const steps = [{ action: 'app.update', input: { connection: 'cloud', appId: 'app' } }];
    const plan = await workflow.plan(steps);
    expect((await workflow.execute(String(plan.planId), steps)).status).toBe(
      'needs-reconciliation',
    );
    expect(await workflow.reconcile(String(plan.planId), steps, 0)).toMatchObject({
      status: 'needs-reconciliation',
      verification: { verified: false },
    });
    const saved = await base.store.get(actor.actor, `${plan.planId}/step/0`);
    expect(saved?.data).toMatchObject({ status: 'uncertain', errorCode: 'IDEMPOTENCY_CONFLICT' });
    expect(saved?.data).not.toHaveProperty('result');
    expect(saved?.data).not.toHaveProperty('outcome');
    expect(
      (await base.store.get('__management_locks__', String(saved?.data.lockId)))?.data.status,
    ).toBe('held');
    expect((await workflow.execute(String(plan.planId), steps)).status).toBe(
      'needs-reconciliation',
    );
    expect(base.execute).toHaveBeenCalledOnce();
  });

  it.each([
    ['before-commit', { outcome: 'rejected', providerStatus: 400 }],
    ['after-commit', { outcome: 'rejected', providerStatus: 400 }],
    ['before-commit', { outcome: 'rejected', dispatch: 'not-started' }],
    ['after-commit', { outcome: 'rejected', dispatch: 'not-started' }],
  ] as const)(
    'does not replay a direct rejection when its durable response fails %s',
    async (failure, details) => {
      const base = setup();
      base.execute.mockRejectedValue(
        createError('MALFORMED_REQUEST', {
          details,
        }),
      );
      const plan = await base.workflow.plan(createSteps);
      const put = base.store.put.bind(base.store);
      let failedResponse = false;
      vi.spyOn(base.store, 'put').mockImplementation(async (record, version) => {
        if (record.kind === 'execution' && record.data.outcome === 'rejected' && !failedResponse) {
          failedResponse = true;
          if (failure === 'after-commit') await put(record, version);
          throw new Error('Rejection persistence response unavailable');
        }
        return put(record, version);
      });
      expect(await base.workflow.execute(String(plan.planId), createSteps)).toMatchObject({
        status: 'needs-reconciliation',
      });
      const execution = await base.store.get(actor.actor, `${plan.planId}/step/0`);
      expect(execution?.data.status).toBe(failure === 'after-commit' ? 'failed' : 'in-progress');
      expect(
        (await base.store.get('__management_locks__', String(execution?.data.lockId)))?.data.status,
      ).toBe('held');
      const replay = await base.workflow.execute(String(plan.planId), createSteps);
      const reconciled = await base.workflow.reconcile(String(plan.planId), createSteps, 0);
      const expectedStatus = failure === 'after-commit' ? 'failed' : 'needs-reconciliation';
      expect(replay.status).toBe(expectedStatus);
      expect(reconciled.status).toBe(expectedStatus);
      expect(
        (await base.store.get('__management_locks__', String(execution?.data.lockId)))?.data.status,
      ).toBe(failure === 'after-commit' ? 'released' : 'held');
      expect(base.execute).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['execute', { outcome: 'rejected', providerStatus: 422 }],
    ['reconcile', { outcome: 'rejected', providerStatus: 422 }],
    ['execute', { outcome: 'rejected', dispatch: 'not-started' }],
    ['reconcile', { outcome: 'rejected', dispatch: 'not-started' }],
  ] as const)(
    'repairs only lock release for a durable direct rejection on %s',
    async (replay, details) => {
      const base = setup();
      base.execute.mockRejectedValue(createError('MALFORMED_REQUEST', { details }));
      const plan = await base.workflow.plan(createSteps);
      const put = base.store.put.bind(base.store);
      let failRelease = true;
      vi.spyOn(base.store, 'put').mockImplementation(async (record, version) => {
        if (record.kind === 'lock' && record.data.status === 'released' && failRelease) {
          failRelease = false;
          throw new Error('release unavailable');
        }
        return put(record, version);
      });
      expect((await base.workflow.execute(String(plan.planId), createSteps)).status).toBe(
        'needs-reconciliation',
      );
      const state = await base.store.get(actor.actor, `${plan.planId}/step/0`);
      expect(state?.data).toMatchObject({
        status: 'failed',
        ...details,
      });
      expect(
        (await base.store.get('__management_locks__', String(state?.data.lockId)))?.data.status,
      ).toBe('held');
      const result =
        replay === 'execute'
          ? await base.workflow.execute(String(plan.planId), createSteps)
          : await base.workflow.reconcile(String(plan.planId), createSteps, 0);
      expect(result).toMatchObject({ status: 'failed', outcome: 'rejected' });
      expect(
        (await base.store.get('__management_locks__', String(state?.data.lockId)))?.data.status,
      ).toBe('released');
      expect(base.execute).toHaveBeenCalledOnce();
      base.execute.mockResolvedValue({
        appId: 'new-app',
        spaceId: 'sandbox',
        status: 'created',
        script: '',
        rows: [],
      });
      const fresh = await base.workflow.plan(createSteps);
      expect((await base.workflow.execute(String(fresh.planId), createSteps)).status).toBe(
        'completed',
      );
    },
  );
  it.each<SafeErrorDetails>([{}, { outcome: 'rejected', providerStatus: 500 }])(
    'keeps unproven provider errors locked',
    async (details) => {
      const base = setup();
      base.execute.mockRejectedValue(createError('MALFORMED_REQUEST', { details }));
      const plan = await base.workflow.plan(createSteps);
      expect((await base.workflow.execute(String(plan.planId), createSteps)).status).toBe(
        'needs-reconciliation',
      );
      const state = await base.store.get(actor.actor, `${plan.planId}/step/0`);
      expect(state?.data.status).toBe('uncertain');
      expect(
        (await base.store.get('__management_locks__', String(state?.data.lockId)))?.data.status,
      ).toBe('held');
    },
  );
  it.each<SafeErrorDetails>([
    { outcome: 'rejected', providerStatus: 400 },
    { outcome: 'rejected', dispatch: 'not-started' },
  ])('retains acknowledged effects despite a later rejection marker', async (details) => {
    const execute = vi.fn(async (_input, onReceipt) => {
      await onReceipt({ appId: 'app', exportId: 'temp-id' });
      throw createError('MALFORMED_REQUEST', { details });
    });
    const base = customWorkflow({
      'app.export': {
        schema: z.object({ connection: z.string(), appId: z.string() }),
        readOnly: false,
        inspect: async () => ({ appId: 'app', spaceId: 'sandbox' }),
        execute,
      },
    });
    const steps = [{ action: 'app.export', input: { connection: 'cloud', appId: 'app' } }];
    const plan = await base.workflow.plan(steps);
    expect((await base.workflow.execute(String(plan.planId), steps)).status).toBe(
      'needs-reconciliation',
    );
    const state = await base.store.get(actor.actor, `${plan.planId}/step/0`);
    expect(state?.data).toMatchObject({ status: 'uncertain', result: { exportId: 'temp-id' } });
    expect(
      (await base.store.get('__management_locks__', String(state?.data.lockId)))?.data.status,
    ).toBe('held');
  });
  it('persists an export receipt before downloading and recovers without another export', async () => {
    const execute = vi.fn(async (_input, onReceipt) => {
      await onReceipt({ appId: 'app', exportId: 'temporary-id', downloadUrl: 'private-url' });
      throw createError('TRANSIENT_UNAVAILABLE');
    });
    const verify = vi.fn(async (_input, receipt) => {
      expect(receipt).toEqual({ appId: 'app', exportId: 'temporary-id' });
      return {
        verified: true,
        result: {
          artifactId: 'artifact-ready',
          sha256: 'a'.repeat(64),
          byteLength: 42,
          rows: ['private-data'],
        },
      };
    });
    const { workflow, store } = customWorkflow({
      'app.export': {
        schema: z.object({ connection: z.string(), appId: z.string() }).strict(),
        readOnly: false,
        inspect: async () => ({ appId: 'app', spaceId: 'sandbox' }),
        execute,
        verify,
      },
    });
    const steps = [{ action: 'app.export', input: { connection: 'cloud', appId: 'app' } }];
    const plan = await workflow.plan(steps);
    expect((await workflow.execute(String(plan.planId), steps)).status).toBe(
      'needs-reconciliation',
    );
    const saved = await store.get(actor.actor, `${plan.planId}/step/0`);
    expect(saved?.data.status).toBe('uncertain');
    expect(saved?.data.result).toEqual({ appId: 'app', exportId: 'temporary-id' });
    const recovered = await workflow.reconcile(String(plan.planId), steps, 0);
    expect(recovered).toMatchObject({
      status: 'completed',
      result: { artifactId: 'artifact-ready', byteLength: 42, verified: true },
    });
    expect(JSON.stringify(recovered)).not.toContain('private-data');
    expect((await workflow.execute(String(plan.planId), steps)).status).toBe('completed');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('advances receipt progress and final acknowledgement versions without overwriting a claim', async () => {
    const execute = vi.fn(async (_input, onReceipt) => {
      await onReceipt({ appId: 'app', exportId: 'temp-first' });
      await onReceipt({ status: 'downloading' });
      return { appId: 'app', artifactId: 'artifact-ready' };
    });
    const { workflow, store } = customWorkflow({
      'app.export': {
        schema: z.object({ connection: z.string(), appId: z.string() }).strict(),
        readOnly: false,
        inspect: async () => ({ appId: 'app', spaceId: 'sandbox' }),
        execute,
        verify: async () => ({ verified: true }),
      },
    });
    const steps = [{ action: 'app.export', input: { connection: 'cloud', appId: 'app' } }];
    const plan = await workflow.plan(steps);
    expect((await workflow.execute(String(plan.planId), steps)).status).toBe('completed');
    const saved = await store.get(actor.actor, `${plan.planId}/step/0`);
    expect(saved?.version).toBe(5);
    expect(saved?.data.result).toEqual({ appId: 'app', artifactId: 'artifact-ready' });
  });

  it('creates no provider objects while planning, replays completion and stores no content', async () => {
    const { workflow, store, execute } = setup();
    const plan = await workflow.plan(createSteps);
    expect(execute).not.toHaveBeenCalled();
    expect((await workflow.execute(String(plan.planId), createSteps)).status).toBe('completed');
    await workflow.execute(String(plan.planId), createSteps);
    expect(execute).toHaveBeenCalledTimes(1);
    const saved = await store.get('owner', `${plan.planId}/step/0`);
    expect(JSON.stringify(saved)).not.toContain('private');
    expect(JSON.stringify(saved)).not.toContain('never persist content');
  });
  it('binds approved inputs and authenticated client identity', async () => {
    const { workflow, store, policy, actions, clock, execute } = setup();
    const plan = await workflow.plan(createSteps);
    await expect(
      workflow.execute(String(plan.planId), [
        { action: 'app.create', input: { connection: 'cloud', name: 'Changed' } },
      ]),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const foreign = new ManagementWorkflow(
      { actor: 'owner', hostClientId: 'other-client' },
      policy,
      store,
      actions,
      clock,
    );
    await expect(foreign.status(String(plan.planId))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it('requires an independent reviewer for grants that require approval', async () => {
    const { workflow, store, policy, actions, clock } = setup(true);
    const plan = await workflow.plan(createSteps);
    await expect(workflow.execute(String(plan.planId), createSteps)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(workflow.approve('owner', String(plan.planId), createSteps)).rejects.toMatchObject(
      { code: 'PERMISSION_DENIED' },
    );
    const reviewer = new ManagementWorkflow(
      { actor: 'reviewer', hostClientId: 'review-client' },
      policy,
      store,
      actions,
      clock,
    );
    await reviewer.approve('owner', String(plan.planId), createSteps);
    expect((await workflow.execute(String(plan.planId), createSteps)).status).toBe('completed');
  });
  it('claims each step atomically across concurrent executions', async () => {
    const { workflow, execute } = setup();
    const plan = await workflow.plan(createSteps);
    const results = await Promise.allSettled([
      workflow.execute(String(plan.planId), createSteps),
      workflow.execute(String(plan.planId), createSteps),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
  });
  it('retains uncertain writes and never dispatches a second attempt', async () => {
    const { workflow, execute } = setup();
    execute.mockRejectedValue(new Error('credential=secret provider body'));
    const plan = await workflow.plan(createSteps);
    const result = await workflow.execute(String(plan.planId), createSteps);
    expect(result.status).toBe('needs-reconciliation');
    expect(JSON.stringify(result)).not.toContain('credential');
    expect((await workflow.execute(String(plan.planId), createSteps)).status).toBe(
      'needs-reconciliation',
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('resolves prior-step identifiers, rechecks target scope and blocks forward references', async () => {
    const { workflow, execute } = setup();
    const steps = [
      ...createSteps,
      {
        action: 'app.update',
        input: { connection: 'cloud', appId: { $ref: { step: 0, field: 'appId' } } },
      },
    ];
    const plan = await workflow.plan(steps);
    expect((await workflow.execute(String(plan.planId), steps)).status).toBe('completed');
    expect(execute.mock.calls[1]?.[0].appId).toBe('new-app');
    await expect(
      workflow.plan([{ action: 'app.get', input: { connection: 'cloud', appId: 'outside' } }]),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      workflow.plan([
        {
          action: 'app.get',
          input: { connection: 'cloud', appId: { $ref: { step: 0, field: 'appId' } } },
        },
      ]),
    ).rejects.toBeDefined();
  });
  it('rejects unknown properties and expired plans before provider mutation', async () => {
    const { workflow, advance, execute } = setup();
    await expect(
      workflow.plan([
        {
          action: 'app.create',
          input: { connection: 'cloud', name: 'Example', endpoint: 'arbitrary' },
        },
      ]),
    ).rejects.toBeDefined();
    const plan = await workflow.plan(createSteps);
    advance();
    expect((await workflow.execute(String(plan.planId), createSteps)).status).toBe('expired');
    expect(execute).not.toHaveBeenCalled();
  });
  it('denies mutations through the read endpoint and unauthorized destination space', async () => {
    const { workflow, policy } = setup();
    await expect(
      workflow.read('app.create', { connection: 'cloud', name: 'Example' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const grant = policy.grant(actor, 'cloud', 'app.create');
    expect(() =>
      policy.authorizeTarget(grant, { spaceId: 'sandbox', targetSpaceId: 'production' }),
    ).toThrow();
    expect(() =>
      policy.authorizeTarget(grant, { spaceId: 'sandbox', targetPersonalSpace: true }),
    ).toThrow();
  });
  it('retains acknowledged resource IDs and resumes only after independent readback', async () => {
    const base = setup();
    const verify = vi.fn().mockResolvedValue({ verified: false });
    const workflow = new ManagementWorkflow(
      actor,
      base.policy,
      base.store,
      { ...base.actions, 'app.create': { ...base.actions['app.create']!, verify } },
      base.clock,
    );
    const plan = await workflow.plan(createSteps);
    expect((await workflow.execute(String(plan.planId), createSteps)).status).toBe(
      'needs-reconciliation',
    );
    const state = await base.store.get('owner', `${plan.planId}/step/0`);
    expect(state?.data).toMatchObject({ status: 'acknowledged', result: { appId: 'new-app' } });
    verify.mockResolvedValue({ verified: true });
    expect((await workflow.reconcile(String(plan.planId), createSteps, 0)).status).toBe(
      'completed',
    );
    expect((await workflow.execute(String(plan.planId), createSteps)).status).toBe('completed');
    expect(base.execute).toHaveBeenCalledTimes(1);
  });
  it('serializes different plans targeting the same resource while a write is uncertain', async () => {
    const base = setup();
    base.execute.mockRejectedValue(new Error('Disconnected'));
    const first = await base.workflow.plan(createSteps);
    await base.workflow.execute(String(first.planId), createSteps);
    const second = await base.workflow.plan(createSteps);
    await expect(base.workflow.execute(String(second.planId), createSteps)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(base.execute).toHaveBeenCalledTimes(1);
  });
  it('keeps audit retention separate from the execution admission deadline', async () => {
    const base = setup();
    const plan = await base.workflow.plan(createSteps);
    const record = await base.store.get('owner', String(plan.planId));
    expect(Date.parse(record!.expiresAt) - Date.parse(String(plan.expiresAt))).toBeGreaterThan(
      80 * 24 * 60 * 60 * 1000,
    );
    base.advance();
    expect((await base.workflow.execute(String(plan.planId), createSteps)).status).toBe('expired');
    expect(base.execute).not.toHaveBeenCalled();
  });

  it('reconciles a committed deletion using its immutable authorized target when the source is absent', async () => {
    let exists = true;
    const inspect = vi.fn(async () => {
      if (!exists) throw createError('NOT_FOUND', { details: { outcome: 'absent' } });
      return { appId: 'existing-app', spaceId: 'sandbox' };
    });
    const execute = vi.fn(async () => {
      exists = false;
      return { appId: 'existing-app', deleted: true };
    });
    const verify = vi.fn(async () => ({ verified: false }));
    const base = customWorkflow({
      'app.delete': {
        schema: z.object({ connection: z.string(), appId: z.string() }).strict(),
        readOnly: false,
        inspect,
        execute,
        verify,
      },
    });
    const steps = [{ action: 'app.delete', input: { connection: 'cloud', appId: 'existing-app' } }];
    const plan = await base.workflow.plan(steps);
    expect((await base.workflow.execute(String(plan.planId), steps)).status).toBe(
      'needs-reconciliation',
    );
    const state = await base.store.get(actor.actor, `${plan.planId}/step/0`);
    expect(state?.data.authorizedTarget).toEqual({ appId: 'existing-app', spaceId: 'sandbox' });
    verify.mockImplementation(async () => ({ verified: !exists }));
    expect((await base.workflow.reconcile(String(plan.planId), steps, 0)).status).toBe('completed');
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(verify).toHaveBeenLastCalledWith(steps[0]!.input, {
      appId: 'existing-app',
      deleted: true,
    });
    expect(
      (await base.store.get('__management_locks__', String(state?.data.lockId)))?.data.status,
    ).toBe('released');
    expect((await base.workflow.execute(String(plan.planId), steps)).status).toBe('completed');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('requires a current grant for the saved deletion scope and never treats a network failure as absence', async () => {
    const inspect = vi.fn(async () => ({ appId: 'existing-app', spaceId: 'sandbox' }));
    const verify = vi.fn(async () => ({ verified: false }));
    const actions: ActionRegistry = {
      'app.delete': {
        schema: z.object({ connection: z.string(), appId: z.string() }).strict(),
        readOnly: false,
        inspect,
        execute: async () => ({ appId: 'existing-app', deleted: true }),
        verify,
      },
    };
    const base = customWorkflow(actions);
    const steps = [{ action: 'app.delete', input: { connection: 'cloud', appId: 'existing-app' } }];
    const plan = await base.workflow.plan(steps);
    await base.workflow.execute(String(plan.planId), steps);
    inspect.mockRejectedValue(createError('TRANSIENT_UNAVAILABLE'));
    await expect(base.workflow.reconcile(String(plan.planId), steps, 0)).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    expect(verify).toHaveBeenCalledOnce();
    inspect.mockRejectedValue(createError('NOT_FOUND', { details: { outcome: 'absent' } }));
    const revoked = new ManagementPolicyEngine(
      {
        ...base.policy.policy,
        grants: base.policy.policy.grants.map((grant) => ({
          ...grant,
          spaceIds: ['different-space'],
        })),
      },
      base.clock,
    );
    const otherScope = new ManagementWorkflow(actor, revoked, base.store, actions, base.clock);
    await expect(otherScope.reconcile(String(plan.planId), steps, 0)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(verify).toHaveBeenCalledOnce();
  });

  it('cannot recover an unacknowledged duplicate by mistaking its source app for the destination', async () => {
    const execute = vi.fn(async (): Promise<Record<string, unknown>> => {
      throw new Error('Connection lost after provider created a server-assigned copy');
    });
    // Even a verifier that would accept an identical source must never be invoked without a destination receipt.
    const verify = vi.fn(async () => ({
      verified: true,
      observed: { appId: 'source-app', name: 'Same name', spaceId: 'sandbox' },
    }));
    const base = customWorkflow({
      'app.duplicate': {
        schema: z
          .object({
            connection: z.string(),
            appId: z.string(),
            name: z.string(),
            spaceId: z.string(),
          })
          .strict(),
        readOnly: false,
        inspect: async () => ({ appId: 'source-app', spaceId: 'sandbox' }),
        execute,
        verify,
      },
    });
    const steps = [
      {
        action: 'app.duplicate',
        input: { connection: 'cloud', appId: 'source-app', name: 'Same name', spaceId: 'sandbox' },
      },
    ];
    const plan = await base.workflow.plan(steps);
    expect((await base.workflow.execute(String(plan.planId), steps)).status).toBe(
      'needs-reconciliation',
    );
    const state = await base.store.get(actor.actor, `${plan.planId}/step/0`);
    expect(state?.data).toMatchObject({ status: 'uncertain' });
    expect(state?.data).not.toHaveProperty('result');
    const recovered = await base.workflow.reconcile(String(plan.planId), steps, 0);
    expect(recovered).toMatchObject({ status: 'needs-reconciliation' });
    expect(String(recovered.reason)).toContain('destination ID');
    expect(verify).not.toHaveBeenCalled();
    expect(
      (await base.store.get('__management_locks__', String(state?.data.lockId)))?.data.status,
    ).toBe('held');
    await base.workflow.execute(String(plan.planId), steps);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(['execute', 'reconcile'] as const)(
    'retries only owned lock release on completed %s replay after release failure',
    async (replay) => {
      const base = setup();
      const verify = vi.fn(async () => ({ verified: false }));
      const workflow = new ManagementWorkflow(
        actor,
        base.policy,
        base.store,
        { ...base.actions, 'app.create': { ...base.actions['app.create']!, verify } },
        base.clock,
      );
      const plan = await workflow.plan(createSteps);
      await workflow.execute(String(plan.planId), createSteps);
      const put = base.store.put.bind(base.store);
      let rejectRelease = true;
      vi.spyOn(base.store, 'put').mockImplementation(async (record, expectedVersion) => {
        if (record.kind === 'lock' && record.data.status === 'released' && rejectRelease) {
          rejectRelease = false;
          throw new Error('Temporary lock-release storage failure');
        }
        return put(record, expectedVersion);
      });
      verify.mockResolvedValue({ verified: true });
      await expect(workflow.reconcile(String(plan.planId), createSteps, 0)).rejects.toThrow(
        'lock-release storage failure',
      );
      const state = await base.store.get(actor.actor, `${plan.planId}/step/0`);
      expect(state?.data.status).toBe('completed');
      expect(
        (await base.store.get('__management_locks__', String(state?.data.lockId)))?.data.status,
      ).toBe('held');
      const result =
        replay === 'execute'
          ? await workflow.execute(String(plan.planId), createSteps)
          : await workflow.reconcile(String(plan.planId), createSteps, 0);
      expect(result.status).toBe('completed');
      expect(
        (await base.store.get('__management_locks__', String(state?.data.lockId)))?.data.status,
      ).toBe('released');
      expect(base.execute).toHaveBeenCalledOnce();
      expect(verify).toHaveBeenCalledTimes(2);
    },
  );

  it('does not release a lock that has subsequently been acquired by another step', async () => {
    const base = setup();
    const plan = await base.workflow.plan(createSteps);
    await base.workflow.execute(String(plan.planId), createSteps);
    const execution = await base.store.get(actor.actor, `${plan.planId}/step/0`);
    const lock = await base.store.get('__management_locks__', String(execution?.data.lockId));
    const foreign: ManagementRecord = {
      ...lock!,
      version: lock!.version + 1,
      data: { status: 'held', actor: 'another-owner', stepId: 'another-plan/step/0' },
    };
    await base.store.put(foreign, lock!.version);
    expect((await base.workflow.execute(String(plan.planId), createSteps)).status).toBe(
      'completed',
    );
    expect((await base.workflow.reconcile(String(plan.planId), createSteps, 0)).status).toBe(
      'completed',
    );
    expect(await base.store.get(foreign.owner, foreign.id)).toEqual(foreign);
    expect(base.execute).toHaveBeenCalledOnce();
  });

  it('atomically stores the target lock and execution claim before provider dispatch', async () => {
    const base = setup();
    const transact = vi.spyOn(base.store, 'transact');
    const puts = vi.spyOn(base.store, 'put');
    const plan = await base.workflow.plan(createSteps);
    base.execute.mockImplementation(async () => {
      const execution = await base.store.get(actor.actor, `${plan.planId}/step/0`);
      expect(execution?.data.status).toBe('in-progress');
      const lock = await base.store.get('__management_locks__', String(execution?.data.lockId));
      expect(lock?.data).toMatchObject({
        status: 'held',
        stepId: execution!.id,
        actor: actor.actor,
      });
      return {
        appId: 'new-app',
        spaceId: 'sandbox',
        status: 'created',
        script: 'never persist content',
        rows: [['private']],
      };
    });
    expect((await base.workflow.execute(String(plan.planId), createSteps)).status).toBe(
      'completed',
    );
    const pairs = transact.mock.calls
      .map(([writes]) => writes)
      .filter((writes) => writes.length === 2);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.map((write) => [write.record.kind, write.expectedVersion])).toEqual([
      ['lock', null],
      ['execution', null],
    ]);
    expect(
      puts.mock.calls.some(([record]) => record.kind === 'lock' && record.data.status === 'held'),
    ).toBe(false);
    expect(
      puts.mock.calls.some(
        ([record]) => record.kind === 'execution' && record.data.status === 'in-progress',
      ),
    ).toBe(false);
  });

  it('never leaves a lock-only claim or dispatches when the atomic claim is rejected', async () => {
    const base = setup();
    const original = base.store.transact.bind(base.store);
    let rejectedLock: ManagementRecord | undefined;
    let rejectedExecution: ManagementRecord | undefined;
    vi.spyOn(base.store, 'transact').mockImplementation(async (writes) => {
      if (writes.some((write) => write.record.kind === 'lock')) {
        rejectedLock = writes.find((write) => write.record.kind === 'lock')!.record;
        rejectedExecution = writes.find((write) => write.record.kind === 'execution')!.record;
        throw createError('IDEMPOTENCY_CONFLICT');
      }
      return original(writes);
    });
    const plan = await base.workflow.plan(createSteps);
    await expect(base.workflow.execute(String(plan.planId), createSteps)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(rejectedLock).toBeDefined();
    expect(rejectedExecution).toBeDefined();
    expect(await base.store.get(rejectedLock!.owner, rejectedLock!.id)).toBeUndefined();
    expect(await base.store.get(rejectedExecution!.owner, rejectedExecution!.id)).toBeUndefined();
    expect(base.execute).not.toHaveBeenCalled();
  });

  it.each(['before-commit', 'after-commit'] as const)(
    'preserves the provider receipt when its acknowledgement response fails %s',
    async (failure) => {
      const base = setup();
      const verify = vi.fn(async () => ({ verified: true }));
      const workflow = new ManagementWorkflow(
        actor,
        base.policy,
        base.store,
        { ...base.actions, 'app.create': { ...base.actions['app.create']!, verify } },
        base.clock,
      );
      const plan = await workflow.plan(createSteps);
      const put = base.store.put.bind(base.store);
      let rejectAcknowledgement = true;
      vi.spyOn(base.store, 'put').mockImplementation(async (record, expectedVersion) => {
        if (
          record.kind === 'execution' &&
          record.data.status === 'acknowledged' &&
          rejectAcknowledgement
        ) {
          rejectAcknowledgement = false;
          if (failure === 'after-commit') await put(record, expectedVersion);
          throw createError('TRANSIENT_UNAVAILABLE');
        }
        return put(record, expectedVersion);
      });
      expect((await workflow.execute(String(plan.planId), createSteps)).status).toBe(
        'needs-reconciliation',
      );
      const saved = await base.store.get(actor.actor, `${plan.planId}/step/0`);
      expect(saved?.data).toMatchObject({
        status: 'uncertain',
        result: { appId: 'new-app', spaceId: 'sandbox' },
      });
      expect(JSON.stringify(saved)).not.toContain('private');
      expect(verify).not.toHaveBeenCalled();
      expect((await workflow.reconcile(String(plan.planId), createSteps, 0)).status).toBe(
        'completed',
      );
      expect((await workflow.execute(String(plan.planId), createSteps)).status).toBe('completed');
      expect(base.execute).toHaveBeenCalledOnce();
    },
  );

  it('never downgrades a completed write after its storage response is lost', async () => {
    const base = setup();
    const verify = vi.fn(async () => ({ verified: true }));
    const workflow = new ManagementWorkflow(
      actor,
      base.policy,
      base.store,
      { ...base.actions, 'app.create': { ...base.actions['app.create']!, verify } },
      base.clock,
    );
    const plan = await workflow.plan(createSteps);
    const put = base.store.put.bind(base.store);
    let rejectCompletion = true;
    vi.spyOn(base.store, 'put').mockImplementation(async (record, expectedVersion) => {
      await put(record, expectedVersion);
      if (record.kind === 'execution' && record.data.status === 'completed' && rejectCompletion) {
        rejectCompletion = false;
        throw createError('TRANSIENT_UNAVAILABLE');
      }
    });
    await workflow.execute(String(plan.planId), createSteps);
    const saved = await base.store.get(actor.actor, `${plan.planId}/step/0`);
    expect(saved?.data.status).toBe('completed');
    expect((await workflow.execute(String(plan.planId), createSteps)).status).toBe('completed');
    expect(
      (await base.store.get('__management_locks__', String(saved?.data.lockId)))?.data.status,
    ).toBe('released');
    expect(base.execute).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
  });

  it('does not overwrite a newer attempt while retaining an acknowledgement after a storage error', async () => {
    const base = setup();
    const plan = await base.workflow.plan(createSteps);
    const put = base.store.put.bind(base.store);
    let replaced: ManagementRecord | undefined;
    vi.spyOn(base.store, 'put').mockImplementation(async (record, expectedVersion) => {
      if (record.kind === 'execution' && record.data.status === 'completed' && !replaced) {
        replaced = { ...record, data: { ...record.data, attemptId: 'different-attempt' } };
        await put(replaced, expectedVersion);
        throw createError('TRANSIENT_UNAVAILABLE');
      }
      return put(record, expectedVersion);
    });
    await base.workflow.execute(String(plan.planId), createSteps);
    expect(await base.store.get(actor.actor, `${plan.planId}/step/0`)).toEqual(replaced);
    expect(base.execute).toHaveBeenCalledOnce();
  });

  it('retries a failed read step and preserves the completed mutation checkpoint', async () => {
    const base = setup();
    const read = vi
      .fn()
      .mockRejectedValueOnce(createError('TRANSIENT_UNAVAILABLE'))
      .mockResolvedValue({ appId: 'new-app', status: 'ready' });
    const workflow = new ManagementWorkflow(
      actor,
      base.policy,
      base.store,
      { ...base.actions, 'app.get': { ...base.actions['app.get']!, execute: read } },
      base.clock,
    );
    const steps = [
      ...createSteps,
      {
        action: 'app.get',
        input: { connection: 'cloud', appId: { $ref: { step: 0, field: 'appId' } } },
      },
    ];
    const plan = await workflow.plan(steps);
    expect(await workflow.execute(String(plan.planId), steps)).toMatchObject({
      status: 'failed',
      retryable: true,
      stoppedAt: 1,
      errorCode: 'TRANSIENT_UNAVAILABLE',
    });
    expect((await base.store.get(actor.actor, `${plan.planId}/step/1`))?.data.status).toBe(
      'failed',
    );
    expect(await workflow.reconcile(String(plan.planId), steps, 1)).toMatchObject({
      status: 'failed',
      retryable: true,
      errorCode: 'TRANSIENT_UNAVAILABLE',
    });
    expect(read).toHaveBeenCalledOnce();
    expect((await workflow.execute(String(plan.planId), steps)).status).toBe('completed');
    expect(base.execute).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(
      { connection: 'cloud', appId: 'new-app' },
      expect.any(Function),
    );
  });

  it('rechecks current permissions before retrying a failed read', async () => {
    const base = setup();
    const read = vi.fn().mockRejectedValue(createError('TRANSIENT_UNAVAILABLE'));
    const actions = { ...base.actions, 'app.get': { ...base.actions['app.get']!, execute: read } };
    const workflow = new ManagementWorkflow(actor, base.policy, base.store, actions, base.clock);
    const steps = [{ action: 'app.get', input: { connection: 'cloud', appId: 'existing-app' } }];
    const plan = await workflow.plan(steps);
    await workflow.execute(String(plan.planId), steps);
    const revoked = new ManagementPolicyEngine(
      {
        ...base.policy.policy,
        grants: base.policy.policy.grants.map((grant) => ({ ...grant, spaceIds: [] })),
      },
      base.clock,
    );
    const retry = new ManagementWorkflow(actor, revoked, base.store, actions, base.clock);
    await expect(retry.execute(String(plan.planId), steps)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(read).toHaveBeenCalledOnce();
    expect((await base.store.get(actor.actor, `${plan.planId}/step/0`))?.data.status).toBe(
      'failed',
    );
  });

  it('does not reconcile or release an in-progress attempt solely because its execution deadline elapsed', async () => {
    const base = setup();
    const verify = vi.fn(async () => ({ verified: true }));
    const workflow = new ManagementWorkflow(
      actor,
      base.policy,
      base.store,
      { ...base.actions, 'app.update': { ...base.actions['app.update']!, verify } },
      base.clock,
    );
    const steps = [{ action: 'app.update', input: { connection: 'cloud', appId: 'existing-app' } }];
    const plan = await workflow.plan(steps);
    const put = base.store.put.bind(base.store);
    vi.spyOn(base.store, 'put').mockImplementation(async (record, expectedVersion) => {
      if (record.kind === 'execution') throw createError('TRANSIENT_UNAVAILABLE');
      return put(record, expectedVersion);
    });
    await workflow.execute(String(plan.planId), steps);
    const saved = await base.store.get(actor.actor, `${plan.planId}/step/0`);
    expect(saved?.data.status).toBe('in-progress');
    for (let interval = 0; interval < 4; interval++) base.advance();
    expect((await workflow.reconcile(String(plan.planId), steps, 0)).status).toBe(
      'needs-reconciliation',
    );
    expect(verify).not.toHaveBeenCalled();
    expect(
      (await base.store.get('__management_locks__', String(saved?.data.lockId)))?.data.status,
    ).toBe('held');
    await workflow.execute(String(plan.planId), steps);
    expect(base.execute).toHaveBeenCalledOnce();
  });
});
