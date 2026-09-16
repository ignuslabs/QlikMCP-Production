import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { FixtureAdapter } from '../../src/adapters/fixture/fixtureAdapter.js';
import type { SheetMutationScope, SheetMutationWriter } from '../../src/adapters/targetAdapter.js';
import { createError } from '../../src/domain/errors.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { FileOperationStore, InMemoryOperationStore } from '../../src/policy/operationStore.js';
import { FilePlanStore, PlanStore } from '../../src/policy/planStore.js';
import { FileIdempotencyStore, IdempotencyStore } from '../../src/policy/idempotencyStore.js';
import { PolicyEngine } from '../../src/policy/policy.js';
import type { PolicyConfig } from '../../src/config/policyConfig.js';
import { OperationService } from '../../src/server/operationService.js';
import { sheetPositions } from '../../src/server/sheetService.js';
import type { SheetExecutionSummary, SheetPlanSummary } from '../../src/domain/sheetTypes.js';
import {
  barChartIntent,
  buildTestPolicyConfig,
  CLOUD_DEV,
  MUTATOR_ACTOR,
  READ_ONLY_ACTOR,
} from '../helpers/testContext.js';

const input = {
  connection: CLOUD_DEV.connection,
  appId: CLOUD_DEV.appId,
  title: 'Revenue overview',
  charts: [
    barChartIntent(),
    barChartIntent({ dimensions: ['Region'], measures: ['Margin'], title: 'Margin by region' }),
  ],
};
function generationPolicy(): PolicyConfig {
  const base = buildTestPolicyConfig();
  return {
    ...base,
    connections: {
      ...base.connections,
      [CLOUD_DEV.connection]: {
        ...base.connections[CLOUD_DEV.connection]!,
        sheetGeneration: {
          actors: [MUTATOR_ACTOR.actor],
          appIds: [CLOUD_DEV.appId],
          chartTypes: ['bar', 'kpi'],
          maxCharts: 12,
          allowProduction: false,
        },
      },
    },
  };
}
function environment() {
  const adapter = new FixtureAdapter();
  const plans = new PlanStore();
  const operations = new InMemoryOperationStore();
  const idempotency = new IdempotencyStore();
  const policy = generationPolicy();
  const makeService = (actor = MUTATOR_ACTOR, override: PolicyConfig = policy) =>
    new OperationService({
      actor,
      adapters: { cloud: adapter },
      policy: new PolicyEngine(override),
      plans,
      operations,
      idempotency,
    });
  return { adapter, plans, operations, idempotency, policy, makeService };
}
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('bounded new-sheet generation', () => {
  it('uses one attempt lease and verifies the sheet after that lease closes', async () => {
    const env = environment();
    let active = false;
    let opened = 0;
    let writtenCharts = 0;
    const signal = new AbortController().signal;
    Object.assign(env.adapter, {
      async withSheetMutationSession<T>(
        scope: SheetMutationScope,
        run: (writer: SheetMutationWriter) => Promise<T>,
      ): Promise<T> {
        expect(scope.actor).toEqual(MUTATOR_ACTOR);
        expect(scope.signal).toBe(signal);
        opened++;
        active = true;
        try {
          return await run({
            ensureSheet: (request) => env.adapter.ensureSheet(request),
            persistChart: (request) => {
              writtenCharts++;
              expect(active).toBe(true);
              expect(request.target).toEqual(scope.target);
              return env.adapter.persistChart(request);
            },
            attachChartToSheet: (request) => env.adapter.attachChartToSheet(request),
            verifyChart: (request) => env.adapter.verifyChart(request),
          });
        } finally {
          active = false;
        }
      },
    });
    const freshReadback = env.adapter.verifySheet.bind(env.adapter);
    const verify = vi.spyOn(env.adapter, 'verifySheet').mockImplementation((request) => {
      expect(active).toBe(false);
      return freshReadback(request);
    });
    const plan = await env.makeService().planSheet(input);
    await env.makeService().previewSheet(plan.planHash);
    const result = await env
      .makeService()
      .applySheet(plan.planHash, 'one-session-attempt', 0, signal);
    expect(result.verified).toBe(true);
    expect(opened).toBe(1);
    expect(writtenCharts).toBe(plan.charts.length);
    expect(verify).toHaveBeenCalledOnce();
    expect(await env.makeService().applySheet(plan.planHash, 'one-session-attempt')).toEqual(
      result,
    );
    expect(opened).toBe(1);
    expect(await env.makeService().verifySheet(plan.planHash)).toMatchObject({ verified: true });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(opened).toBe(1);
  });

  it('cancels before mutation without reserving the attempt', async () => {
    const env = environment();
    const plan = await env.makeService().planSheet(input);
    await env.makeService().previewSheet(plan.planHash);
    const ensure = vi.spyOn(env.adapter, 'ensureSheet');
    await expect(
      env.makeService().applySheet(plan.planHash, 'cancelled-before-start', 0, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(ensure).not.toHaveBeenCalled();
    expect(
      await env.makeService().applySheet(plan.planHash, 'cancelled-before-start'),
    ).toMatchObject({ verified: true });
  });

  it('keeps uncertain native attempts reserved and forbids automatic resume after verification', async () => {
    const env = environment();
    const lease = vi.fn(async () => {
      throw createError('IDEMPOTENCY_CONFLICT', { details: { outcome: 'uncertain' } });
    });
    Object.assign(env.adapter, { withSheetMutationSession: lease });
    const plan = await env.makeService().planSheet(input);
    await env.makeService().previewSheet(plan.planHash);
    await expect(
      env.makeService().applySheet(plan.planHash, 'uncertain-lease'),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { outcome: 'uncertain' },
    });
    const operation = await env.makeService().getOperation(`${plan.operationId}-attempt-0`);
    expect(operation).toMatchObject({
      cleanupOutcome: 'reconciliation-required',
      typedOutcome: { status: 'failed', code: 'IDEMPOTENCY_CONFLICT', cleanupRequired: true },
    });
    expect(await env.makeService().verifySheet(plan.planHash)).toMatchObject({ verified: false });
    for (const attempt of [0, 1])
      await expect(
        env.makeService().applySheet(plan.planHash, 'uncertain-lease', attempt),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(lease).toHaveBeenCalledOnce();
  });

  it('lays out every supported chart count without overlaps or overflow', () => {
    for (let count = 1; count <= 12; count++) {
      const positions = sheetPositions(count);
      expect(positions).toHaveLength(count);
      expect(sheetPositions(count)).toEqual(positions);
      for (const [index, left] of positions.entries()) {
        expect(left.col + left.colspan).toBeLessThanOrEqual(24);
        expect(left.row + left.rowspan).toBeLessThanOrEqual(12);
        for (const right of positions.slice(index + 1))
          expect(
            left.col >= right.col + right.colspan ||
              right.col >= left.col + left.colspan ||
              left.row >= right.row + right.rowspan ||
              right.row >= left.row + left.rowspan,
          ).toBe(true);
      }
    }
    expect(() => sheetPositions(13)).toThrow();
  });

  it('denies absent grants, wrong actors/apps/chart types and oversized batches before catalog access', async () => {
    const env = environment();
    const catalog = vi.spyOn(env.adapter, 'getCompilationContext');
    await expect(
      env.makeService(MUTATOR_ACTOR, buildTestPolicyConfig()).planSheet(input),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(env.makeService(READ_ONLY_ACTOR).planSheet(input)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(
      env.makeService().planSheet({ ...input, appId: 'other-app' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      env.makeService().planSheet({
        ...input,
        charts: [
          {
            ...barChartIntent(),
            presentation: { preferredChartType: 'line', title: 'Not granted' },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      env
        .makeService()
        .planSheet({ ...input, charts: Array.from({ length: 13 }, () => barChartIntent()) }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(catalog).not.toHaveBeenCalled();
  });

  it('creates a new sheet, verifies its exact charts, and replays without writing', async () => {
    const env = environment();
    const service = env.makeService();
    const catalog = vi.spyOn(env.adapter, 'getCompilationContext');
    const plan = await service.planSheet(input);
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(plan.target.sheetId).not.toBe(CLOUD_DEV.writableSheetId);
    const ensure = vi.spyOn(env.adapter, 'ensureSheet');
    await expect(service.applySheet(plan.planHash, 'sheet-success')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(ensure).not.toHaveBeenCalled();
    await env.makeService().previewSheet(plan.planHash);
    const applied = await env.makeService().applySheet(plan.planHash, 'sheet-success');
    expect(applied).toMatchObject({ status: 'verified', verified: true });
    expect(applied.charts).toHaveLength(2);
    expect(await env.makeService().applySheet(plan.planHash, 'sheet-success')).toEqual(applied);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(await env.makeService().verifySheet(plan.planHash)).toMatchObject({ verified: true });
    const objects = await env.adapter.listSheetObjects(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      plan.target.sheetId,
      MUTATOR_ACTOR,
    );
    expect(objects.objects.map((object) => object.objectId).sort()).toEqual(
      plan.charts.map((chart) => chart.objectId).sort(),
    );
  });

  it('resumes a partial batch across service instances without duplicate objects', async () => {
    const env = environment();
    const plan = await env.makeService().planSheet(input);
    await env.makeService().previewSheet(plan.planHash);
    const original = env.adapter.persistChart.bind(env.adapter);
    let calls = 0;
    vi.spyOn(env.adapter, 'persistChart').mockImplementation(async (request) => {
      if (++calls === 2) throw createError('CAPACITY_EXHAUSTED');
      return original(request);
    });
    const partial = await env.makeService().applySheet(plan.planHash, 'resume-sheet');
    expect(partial).toMatchObject({ status: 'partial', verified: false, nextAttempt: 1 });
    expect(partial.charts).toHaveLength(1);
    await expect(
      env.makeService().applySheet(plan.planHash, 'different-key', 1),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      env.makeService().applySheet(plan.planHash, 'resume-sheet', 2),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const resumed = await env
      .makeService()
      .applySheet(plan.planHash, 'resume-sheet', partial.nextAttempt);
    expect(resumed).toMatchObject({ status: 'verified', verified: true, attempt: 1 });
    expect(
      (
        await env.adapter.listSheetObjects(
          CLOUD_DEV.connection,
          CLOUD_DEV.appId,
          plan.target.sheetId,
          MUTATOR_ACTOR,
        )
      ).objects,
    ).toHaveLength(2);
  });

  it('binds sheet state to actor and rechecks revoked scope before mutation', async () => {
    const env = environment();
    const plan = await env.makeService().planSheet(input);
    await env.makeService().previewSheet(plan.planHash);
    const ensure = vi.spyOn(env.adapter, 'ensureSheet');
    await expect(
      env.makeService(READ_ONLY_ACTOR).previewSheet(plan.planHash),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    await expect(
      env.makeService(MUTATOR_ACTOR, buildTestPolicyConfig()).applySheet(plan.planHash, 'revoked'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('rejects conflicting idempotency key reuse between plans', async () => {
    const env = environment();
    const first = await env.makeService().planSheet(input);
    await env.makeService().previewSheet(first.planHash);
    await env.makeService().applySheet(first.planHash, 'same-key');
    const second = await env.makeService().planSheet({ ...input, title: 'Another sheet' });
    await env.makeService().previewSheet(second.planHash);
    await expect(env.makeService().applySheet(second.planHash, 'same-key')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('does not claim success if a chart disappeared after creation', async () => {
    const env = environment();
    const plan = await env.makeService().planSheet(input);
    await env.makeService().previewSheet(plan.planHash);
    await env.makeService().applySheet(plan.planHash, 'drift');
    await env.adapter.cleanupObject({ target: plan.target, objectId: plan.charts[0]!.objectId });
    const result = await env.makeService().verifySheet(plan.planHash);
    expect(result).toMatchObject({ status: 'partial', verified: false });
    expect(result.charts[0]!.verified).toBe(false);
  });

  it('keeps preview, plan and apply receipts durable across recreated file stores', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'qlik-sheet-'));
    directories.push(directory);
    const adapter = new FixtureAdapter();
    const service = () =>
      new OperationService({
        actor: MUTATOR_ACTOR,
        adapters: { cloud: adapter },
        policy: new PolicyEngine(generationPolicy()),
        plans: new FilePlanStore(path.join(directory, 'plans.json')),
        operations: new FileOperationStore(path.join(directory, 'operations.json')),
        idempotency: new FileIdempotencyStore(path.join(directory, 'idempotency.json')),
      });
    const plan = await service().planSheet(input);
    await service().previewSheet(plan.planHash);
    const result = await service().applySheet(plan.planHash, 'file-persistence');
    expect(result.verified).toBe(true);
    expect(await service().applySheet(plan.planHash, 'file-persistence')).toEqual(result);
    expect((await service().verifySheet(plan.planHash)).verified).toBe(true);
  });

  it('separates scoped production sheet grants from existing single-chart mutation policy', () => {
    const config = generationPolicy();
    const entry = config.connections[CLOUD_DEV.connection]!;
    const policy = new PolicyEngine({
      ...config,
      connections: {
        [CLOUD_DEV.connection]: {
          ...entry,
          environment: 'production',
          sheetGeneration: { ...entry.sheetGeneration!, allowProduction: true },
        },
      },
    });
    expect(() =>
      policy.assertSheetGenerationAllowed(
        MUTATOR_ACTOR.actor,
        CLOUD_DEV.connection,
        CLOUD_DEV.appId,
        ['bar'],
      ),
    ).not.toThrow();
    expect(() =>
      policy.assertMutationTargetAllowed(
        CLOUD_DEV.connection,
        CLOUD_DEV.appId,
        CLOUD_DEV.writableSheetId,
        'bar',
      ),
    ).toThrow();
  });

  it('requires replanning when the app catalog changes before apply', async () => {
    const env = environment();
    const plan = await env.makeService().planSheet(input);
    await env.makeService().previewSheet(plan.planHash);
    const context = await env.adapter.getCompilationContext(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      MUTATOR_ACTOR,
    );
    vi.spyOn(env.adapter, 'getCompilationContext').mockResolvedValue({
      ...context,
      catalog: { ...context.catalog, catalogId: 'changed-catalog' },
    });
    const ensure = vi.spyOn(env.adapter, 'ensureSheet');
    await expect(
      env.makeService().applySheet(plan.planHash, 'catalog-drift'),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('blocks expired mutation plans while allowing fresh readback from retained artifacts', async () => {
    const env = environment();
    const plan = await env.makeService().planSheet(input);
    await env.makeService().previewSheet(plan.planHash);
    await env.makeService().applySheet(plan.planHash, 'expired-plan');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(plan.expiresAt) + 1);
    await expect(env.makeService().applySheet(plan.planHash, 'expired-plan')).rejects.toMatchObject(
      { code: 'PLAN_STALE' },
    );
    expect((await env.makeService().verifySheet(plan.planHash)).verified).toBe(true);
  });

  it('rejects corrupt manifest contents and invalid expiry before native writes', async () => {
    const env = environment();
    const plan = await env.makeService().planSheet(input);
    const record = (await env.operations.get(plan.operationId))!;
    const ensure = vi.spyOn(env.adapter, 'ensureSheet');
    await env.operations.save({
      ...record,
      sheetManifest: { ...record.sheetManifest!, title: 'Changed without replanning' },
    });
    await expect(env.makeService().applySheet(plan.planHash, 'tamper')).rejects.toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });
    await env.operations.save({
      ...record,
      sheetManifest: { ...record.sheetManifest!, expiresAt: 'not-a-date' },
    });
    await expect(env.makeService().previewSheet(plan.planHash)).rejects.toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('admits bounded previews across service instances and releases them after cancellation', async () => {
    const env = environment();
    const plan = await env.makeService().planSheet(input);
    vi.spyOn(env.adapter, 'createSessionChart').mockImplementation(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(createError('OPERATION_CANCELLED')),
            { once: true },
          );
        }),
    );
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = env.makeService().previewSheet(plan.planHash, firstAbort.signal);
    const second = env.makeService().previewSheet(plan.planHash, secondAbort.signal);
    const settled = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(env.adapter.createSessionChart).toHaveBeenCalledTimes(2));
    await expect(env.makeService().previewSheet(plan.planHash)).rejects.toMatchObject({
      code: 'CAPACITY_EXHAUSTED',
    });
    firstAbort.abort();
    secondAbort.abort();
    expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
  });

  it('blocks concurrent and uncertain apply attempts until exact verification', async () => {
    const env = environment();
    const plan = await env.makeService().planSheet(input);
    await env.makeService().previewSheet(plan.planHash);
    const original = env.adapter.ensureSheet.bind(env.adapter);
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ensure = vi.spyOn(env.adapter, 'ensureSheet').mockImplementation(async (request) => {
      await gate;
      return original(request);
    });
    const first = env.makeService().applySheet(plan.planHash, 'concurrent');
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
    await expect(env.makeService().applySheet(plan.planHash, 'concurrent')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(
      env.makeService().applySheet(plan.planHash, 'concurrent', 1),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    finish();
    expect((await first).verified).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('allows narrowly scoped production discovery and rejects unrelated app reads and old writes', async () => {
    const env = environment();
    const entry = env.policy.connections[CLOUD_DEV.connection]!;
    const production: PolicyConfig = {
      ...env.policy,
      connections: {
        [CLOUD_DEV.connection]: {
          ...entry,
          environment: 'production',
          sheetGeneration: { ...entry.sheetGeneration!, allowProduction: true },
        },
      },
    };
    const service = env.makeService(MUTATOR_ACTOR, production);
    const apps = vi.spyOn(env.adapter, 'listAccessibleApps').mockResolvedValue({
      apps: [
        {
          appId: CLOUD_DEV.appId,
          name: 'Authorized',
          connection: CLOUD_DEV.connection,
          platform: 'cloud',
          environment: 'production',
        },
        {
          appId: 'unrelated-app',
          name: 'Other',
          connection: CLOUD_DEV.connection,
          platform: 'cloud',
          environment: 'production',
        },
      ],
      truncated: false,
    });
    expect((await service.listApps(CLOUD_DEV.connection)).apps.map((app) => app.appId)).toEqual([
      CLOUD_DEV.appId,
    ]);
    expect(apps).toHaveBeenCalledTimes(1);
    expect((await service.getAppCatalog(CLOUD_DEV.connection, CLOUD_DEV.appId)).appId).toBe(
      CLOUD_DEV.appId,
    );
    await expect(
      service.getAppCatalog(CLOUD_DEV.connection, 'unrelated-app'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      service.listSheetObjects(CLOUD_DEV.connection, 'unrelated-app', 'any-sheet'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      service.planVisualization(
        CLOUD_DEV.connection,
        CLOUD_DEV.appId,
        CLOUD_DEV.writableSheetId,
        barChartIntent(),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('works over MCP 2026 with a fresh service for every request and shared durable repositories', async () => {
    const env = environment();
    let created = 0;
    const applySignals: (AbortSignal | undefined)[] = [];
    const handler = createMcpHandler(
      () => {
        created++;
        const service = env.makeService();
        const apply = service.applySheet.bind(service);
        vi.spyOn(service, 'applySheet').mockImplementation((...args) => {
          applySignals.push(args[3]);
          return apply(...args);
        });
        return buildMcpServer(service, 'requester');
      },
      { legacy: 'reject', responseMode: 'json' },
    );
    const client = new Client(
      { name: 'sheet-modern', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL('https://sheet.test/mcp'), {
      fetch: async (request, init) => handler.fetch(new Request(request, init)),
    });
    try {
      await client.connect(transport);
      const planned = await client.callTool({ name: 'qlik_plan_sheet', arguments: input });
      expect(planned.isError).not.toBe(true);
      const plan = planned.structuredContent as unknown as SheetPlanSummary;
      expect(
        (
          await client.callTool({
            name: 'qlik_preview_sheet',
            arguments: { planHash: plan.planHash },
          })
        ).isError,
      ).not.toBe(true);
      const applied = await client.callTool({
        name: 'qlik_apply_sheet',
        arguments: { planHash: plan.planHash, idempotencyKey: 'modern-key' },
      });
      expect(applied.isError).not.toBe(true);
      expect((applied.structuredContent as unknown as SheetExecutionSummary).verified).toBe(true);
      expect(applySignals).toHaveLength(1);
      expect(applySignals[0]).toBeInstanceOf(AbortSignal);
      const checked = await client.callTool({
        name: 'qlik_verify_sheet',
        arguments: { planHash: plan.planHash },
      });
      expect((checked.structuredContent as unknown as SheetExecutionSummary).verified).toBe(true);
      for (const operationId of [
        plan.operationId,
        `${plan.operationId}-preview`,
        (applied.structuredContent as unknown as SheetExecutionSummary).operationId,
      ]) {
        const audit = await client.callTool({
          name: 'qlik_get_operation',
          arguments: { operationId },
        });
        expect(audit.isError).not.toBe(true);
        expect(audit.structuredContent).not.toHaveProperty('sheetManifest');
        expect(audit.structuredContent).toHaveProperty('typedOutcome.status');
      }
      expect(created).toBeGreaterThanOrEqual(4);
      expect(transport.sessionId).toBeUndefined();
    } finally {
      await client.close();
      await handler.close();
    }
  });
});
