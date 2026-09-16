import { describe, expect, it, vi } from 'vitest';
import {
  CloudAdapter,
  type CloudAdapterDependencies,
} from '../../../src/adapters/cloud/cloudAdapter.js';
import { QlikApiAppSession } from '../../../src/adapters/cloud/qlikApiCloudClient.js';
import type { SheetMutationWriter } from '../../../src/adapters/targetAdapter.js';
import { FixtureAdapter } from '../../../src/adapters/fixture/fixtureAdapter.js';
import { compileChartIntent } from '../../../src/compiler/compiler.js';
import { chartIntentSchema } from '../../../src/compiler/chartIntentSchema.js';
import { CLOUD_DEV, MUTATOR_ACTOR, barChartIntent } from '../../helpers/testContext.js';

const target = {
  connection: CLOUD_DEV.connection,
  appId: CLOUD_DEV.appId,
  sheetId: 'qlikai-sheet-generation-test',
};
const placement = { col: 0, row: 0, colspan: 12, rowspan: 6 };
const ensureRequest = {
  target,
  title: 'Sales overview',
  actor: MUTATOR_ACTOR,
  idempotencyKey: 'stable-plan-hash',
};
const objectId = 'qlikai-chart-generation-test-1';

type Properties = Record<string, unknown>;

function nativeEngine() {
  const objects = new Map<string, Properties>();
  const children = new Map<string, string[]>();
  let created = 0;
  let opened = 0;
  let closed = 0;
  let saveFailures = 0;
  let objectIdCollision = false;
  let dimensionError = false;
  const getObject = (id: string) => {
    if (!objects.has(id)) throw Object.assign(new Error('missing object'), { code: 404 });
    return {
      id,
      getInfo: async () => ({ qId: id }),
      getProperties: async () => structuredClone(objects.get(id)!),
      getChildInfos: async () =>
        (children.get(id) ?? []).map((childId) => ({
          qId: childId,
          qType: (objects.get(childId)!.qInfo as { qType: string }).qType,
        })),
      getLayout: async () => {
        const properties = objects.get(id)!;
        return {
          ...properties,
          qHyperCube: {
            qSize: { qcx: 2, qcy: 1 },
            qMode: 'S',
            qDimensionInfo: [dimensionError ? { qError: { qErrorCode: 1002 } } : {}],
            qMeasureInfo: [{}],
            qDataPages: [{ qMatrix: [[{ qText: 'East' }, { qNum: 12, qText: '12' }]] }],
          },
        };
      },
      createChild: async (properties: Properties, parent: Properties) => {
        const childId = (properties.qInfo as { qId: string }).qId;
        created += 1;
        objects.set(childId, structuredClone(properties));
        objects.set(id, structuredClone(parent));
        children.set(id, [...(children.get(id) ?? []), childId]);
        return getObject(childId);
      },
      destroyChild: async (childId: string, parent: Properties) => {
        objects.delete(childId);
        objects.set(id, structuredClone(parent));
        children.set(
          id,
          (children.get(id) ?? []).filter((entry) => entry !== childId),
        );
        return true;
      },
    };
  };
  const doc = {
    getFieldList: async () => [
      { qName: 'Region', qCardinal: 2, qTags: ['$text'] },
      { qName: 'Revenue', qTags: ['$numeric'] },
    ],
    getDimensionList: async () => [],
    getMeasureList: async () => [],
    getObject: async (id: string) => getObject(id),
    getSheetList: async () =>
      [...objects]
        .filter(([, properties]) => (properties.qInfo as { qType: string }).qType === 'sheet')
        .map(([id]) => ({ qInfo: { qId: id } })),
    createObject: async (properties: Properties) => {
      const id = objectIdCollision
        ? 'collision-generated-id'
        : (properties.qInfo as { qId: string }).qId;
      objects.set(id, structuredClone(properties));
      created += 1;
      return getObject(id);
    },
    destroyObject: async (id: string) => objects.delete(id),
    doSave: async () => {
      if (saveFailures-- > 0) throw new Error('save failed');
    },
  };
  return {
    objects,
    children,
    doc,
    count: () => ({ created, closed }),
    sessionCount: () => ({ opened, closed }),
    failNextSave: () => {
      saveFailures = 1;
    },
    failDimension: () => {
      dimensionError = true;
    },
    collideNextSheet: () => {
      objectIdCollision = true;
    },
    session: () => {
      opened += 1;
      return new QlikApiAppSession(
        {
          close: async () => {
            closed += 1;
          },
        } as never,
        doc as never,
      );
    },
  };
}

function cloudAdapter(
  engine: ReturnType<typeof nativeEngine>,
  allowCreation = true,
  writable = true,
  dependencyOverrides: Partial<CloudAdapterDependencies> = {},
) {
  return new CloudAdapter(
    {
      connection: target.connection,
      tenantHost: 'https://test.qlikcloud.com',
      oauthClientId: 'test-client',
      writeTarget: { ...target, sheetId: CLOUD_DEV.writableSheetId },
      sheetCreationAppIds: allowCreation ? [target.appId] : [],
      readiness: {
        approved: true,
        expiresAt: '2099-01-01T00:00:00.000Z',
        canRead: true,
        canPreview: true,
        canWriteDesignatedSheet: writable,
        cleanupVerified: writable,
      },
    },
    {
      hostConfigs: {
        getHostConfig: async () => ({
          host: 'https://test.qlikcloud.com',
          authType: 'oauth2',
          clientId: 'test-client',
        }),
      },
      qlik: { listApps: async () => ({ apps: [] }), openAppSession: async () => engine.session() },
      ...dependencyOverrides,
    },
  );
}

async function plan() {
  const fixture = new FixtureAdapter();
  const context = await fixture.getCompilationContext(
    target.connection,
    target.appId,
    MUTATOR_ACTOR,
  );
  return compileChartIntent({
    catalog: context.catalog,
    target,
    platform: 'cloud',
    intent: chartIntentSchema.parse(barChartIntent()),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const uncertainFailure = { code: 'IDEMPOTENCY_CONFLICT', details: { outcome: 'uncertain' } };

describe('operation-scoped native sheet sessions', () => {
  it('uses three real adapter sessions for catalog, twelve-chart apply, and fresh saved-sheet verification', async () => {
    const engine = nativeEngine();
    const adapter = cloudAdapter(engine);
    const chartPlan = await plan();
    const objectIds: string[] = [];
    await adapter.getCompilationContext(target.connection, target.appId, MUTATOR_ACTOR);
    await adapter.withSheetMutationSession(ensureRequest, async (writer) => {
      await writer.ensureSheet(ensureRequest);
      for (let index = 0; index < 12; index += 1) {
        const id = `${objectId}-${index}`;
        const position = {
          col: (index % 3) * 8,
          row: Math.floor(index / 3) * 3,
          colspan: 8,
          rowspan: 3,
        };
        await writer.persistChart({
          ...ensureRequest,
          objectId: id,
          plan: chartPlan,
          placement: position,
        });
        await writer.attachChartToSheet({ target, objectId: id, placement: position });
        expect(
          await writer.verifyChart({ target, objectId: id, plan: chartPlan, placement: position }),
        ).toEqual({ verified: true });
        objectIds.push(id);
      }
    });
    expect(engine.sessionCount()).toEqual({ opened: 2, closed: 2 });
    expect(await adapter.verifySheet({ ...ensureRequest, objectIds })).toEqual({
      verified: true,
      objectIds,
    });
    expect(engine.sessionCount()).toEqual({ opened: 3, closed: 3 });
    expect(engine.count().created).toBe(13);
    const sheet = engine.objects.get(target.sheetId)!;
    engine.objects.set(target.sheetId, { ...sheet, qMetaDef: { title: 'Changed externally' } });
    expect((await adapter.verifySheet({ ...ensureRequest, objectIds })).verified).toBe(false);
    expect(engine.sessionCount()).toEqual({ opened: 4, closed: 4 });
  });

  it('rejects every target and caller mismatch before native work, using an immutable entry scope', async () => {
    const engine = nativeEngine();
    const adapter = cloudAdapter(engine);
    const scope = {
      target: { ...target, appId: String(target.appId) },
      actor: { ...MUTATOR_ACTOR },
    };
    await adapter.withSheetMutationSession(scope, async (writer) => {
      scope.target.appId = 'later-app-change';
      scope.actor.actor = 'later-actor-change';
      for (const otherTarget of [
        { ...target, connection: 'other-connection' },
        { ...target, appId: 'other-app' },
        { ...target, sheetId: 'qlikai-other-sheet' },
      ]) {
        await expect(
          writer.ensureSheet({ ...ensureRequest, target: otherTarget }),
        ).rejects.toMatchObject({
          code: 'PERMISSION_DENIED',
        });
        await expect(
          writer.attachChartToSheet({ target: otherTarget, objectId }),
        ).rejects.toMatchObject({
          code: 'PERMISSION_DENIED',
        });
      }
      for (const actor of [
        { ...MUTATOR_ACTOR, actor: 'other-actor' },
        { ...MUTATOR_ACTOR, hostClientId: 'other-host-client' },
      ])
        await expect(writer.ensureSheet({ ...ensureRequest, actor })).rejects.toMatchObject({
          code: 'PERMISSION_DENIED',
        });
      expect(engine.count().created).toBe(0);
      await writer.ensureSheet(ensureRequest);
    });
    expect(engine.sessionCount()).toEqual({ opened: 1, closed: 1 });
  });

  it('keeps simultaneous same-app callers in distinct native sessions and identities', async () => {
    const engine = nativeEngine();
    const identities: string[] = [];
    const sessions: QlikApiAppSession[] = [];
    const adapter = cloudAdapter(engine, true, true, {
      qlik: {
        listApps: async () => ({ apps: [] }),
        openAppSession: async ({ identity }) => {
          identities.push(identity);
          const session = engine.session();
          sessions.push(session);
          return session;
        },
      },
    });
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const first = adapter.withSheetMutationSession(ensureRequest, async (writer) => {
      await writer.ensureSheet(ensureRequest);
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const other = {
      ...ensureRequest,
      target: { ...target, sheetId: `${target.sheetId}-other` },
      actor: { ...MUTATOR_ACTOR, actor: 'other-principal' },
    };
    await adapter.withSheetMutationSession(other, async (writer) => {
      await writer.ensureSheet(other);
      expect(engine.sessionCount()).toEqual({ opened: 2, closed: 0 });
    });
    releaseFirst.resolve();
    await first;
    expect(new Set(identities).size).toBe(2);
    expect(sessions[0]).not.toBe(sessions[1]);
    expect(engine.sessionCount()).toEqual({ opened: 2, closed: 2 });
  });

  it.each(['success', 'failure'] as const)(
    'revokes a captured writer after callback %s and closes exactly once',
    async (outcome) => {
      const engine = nativeEngine();
      const adapter = cloudAdapter(engine);
      let retained: SheetMutationWriter | undefined;
      const attempt = adapter.withSheetMutationSession(ensureRequest, async (writer) => {
        retained = writer;
        await writer.ensureSheet(ensureRequest);
        if (outcome === 'failure') throw new Error('settled callback failure');
        return 'done';
      });
      if (outcome === 'failure') await expect(attempt).rejects.not.toMatchObject(uncertainFailure);
      else expect(await attempt).toBe('done');
      await expect(retained!.ensureSheet(ensureRequest)).rejects.toMatchObject(uncertainFailure);
      expect(engine.sessionCount()).toEqual({ opened: 1, closed: 1 });
      expect(engine.count().created).toBe(1);
    },
  );

  it('checks current readiness again for each writer call', async () => {
    const engine = nativeEngine();
    let now = new Date('2026-09-15T00:00:00Z');
    const adapter = cloudAdapter(engine, true, true, { now: () => now });
    await adapter.withSheetMutationSession(ensureRequest, async (writer) => {
      now = new Date('2100-01-01T00:00:00Z');
      await expect(writer.ensureSheet(ensureRequest)).rejects.toMatchObject({
        code: 'NOT_CONFIGURED',
      });
    });
    expect(engine.count()).toEqual({ created: 0, closed: 1 });
  });

  it('rejects pre-cancelled or unscoped attempts without opening a session', async () => {
    const engine = nativeEngine();
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => undefined);
    await expect(
      cloudAdapter(engine).withSheetMutationSession(
        {
          ...ensureRequest,
          signal: controller.signal,
        },
        run,
      ),
    ).rejects.toMatchObject(uncertainFailure);
    await expect(
      cloudAdapter(engine, false).withSheetMutationSession(ensureRequest, run),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(run).not.toHaveBeenCalled();
    expect(engine.sessionCount()).toEqual({ opened: 0, closed: 0 });
  });

  it('closes a late-opening session after the attempt deadline without running its callback', async () => {
    const engine = nativeEngine();
    const opening = deferred<QlikApiAppSession>();
    const session = engine.session();
    const close = vi.spyOn(session, 'close');
    const run = vi.fn(async () => undefined);
    const adapter = cloudAdapter(engine, true, true, {
      mutationTimeoutMs: 5,
      qlik: { listApps: async () => ({ apps: [] }), openAppSession: () => opening.promise },
    });
    await expect(adapter.withSheetMutationSession(ensureRequest, run)).rejects.toMatchObject(
      uncertainFailure,
    );
    opening.resolve(session);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(run).not.toHaveBeenCalled();
    expect(engine.count().created).toBe(0);
  });

  it('revokes unawaited and concurrent writer calls before any delayed native creation can continue', async () => {
    const engine = nativeEngine();
    const sheets = deferred<Awaited<ReturnType<typeof engine.doc.getSheetList>>>();
    vi.spyOn(engine.doc, 'getSheetList').mockImplementationOnce(() => sheets.promise);
    const adapter = cloudAdapter(engine);
    let detached: Promise<unknown> | undefined;
    await expect(
      adapter.withSheetMutationSession(ensureRequest, async (writer) => {
        detached = writer.ensureSheet(ensureRequest);
        await expect(writer.ensureSheet(ensureRequest)).rejects.toMatchObject({
          code: 'MALFORMED_REQUEST',
        });
      }),
    ).rejects.toMatchObject(uncertainFailure);
    sheets.resolve([]);
    await expect(detached).rejects.toMatchObject(uncertainFailure);
    expect(engine.count()).toEqual({ created: 0, closed: 1 });
  });

  it('cancels a pending native read and prevents the delayed create/save continuation', async () => {
    const engine = nativeEngine();
    const sheets = deferred<Awaited<ReturnType<typeof engine.doc.getSheetList>>>();
    const started = deferred<void>();
    vi.spyOn(engine.doc, 'getSheetList').mockImplementationOnce(() => {
      started.resolve();
      return sheets.promise;
    });
    const adapter = cloudAdapter(engine);
    const controller = new AbortController();
    let pending: Promise<unknown> | undefined;
    const attempt = adapter.withSheetMutationSession(
      { ...ensureRequest, signal: controller.signal },
      async (writer) => {
        pending = writer.ensureSheet(ensureRequest);
        await pending;
      },
    );
    await started.promise;
    controller.abort();
    await expect(attempt).rejects.toMatchObject(uncertainFailure);
    sheets.resolve([]);
    await expect(pending).rejects.toMatchObject(uncertainFailure);
    expect(engine.count()).toEqual({ created: 0, closed: 1 });
  });

  it('does not roll back a created child when its save fails after cancellation', async () => {
    const engine = nativeEngine();
    const adapter = cloudAdapter(engine);
    const chartPlan = await plan();
    const saving = deferred<void>();
    const started = deferred<void>();
    const controller = new AbortController();
    let pending: Promise<unknown> | undefined;
    const attempt = adapter.withSheetMutationSession(
      { ...ensureRequest, signal: controller.signal },
      async (writer) => {
        await writer.ensureSheet(ensureRequest);
        vi.spyOn(engine.doc, 'doSave').mockImplementationOnce(() => {
          started.resolve();
          return saving.promise;
        });
        pending = writer.persistChart({ ...ensureRequest, objectId, plan: chartPlan, placement });
        await pending;
      },
    );
    await started.promise;
    controller.abort();
    await expect(attempt).rejects.toMatchObject(uncertainFailure);
    saving.reject(new Error('late save failure'));
    await expect(pending).rejects.toBeDefined();
    expect(engine.objects.has(objectId)).toBe(true);
    expect(engine.count()).toEqual({ created: 2, closed: 1 });
  });

  it.each(['reject', 'hang'] as const)(
    'bounds uncertain session close when it can %s',
    async (mode) => {
      const engine = nativeEngine();
      const session = engine.session();
      const close = vi
        .spyOn(session, 'close')
        .mockImplementation(() =>
          mode === 'reject'
            ? Promise.reject(new Error('private transport detail'))
            : new Promise(() => undefined),
        );
      const adapter = cloudAdapter(engine, true, true, {
        mutationCloseTimeoutMs: 5,
        qlik: { listApps: async () => ({ apps: [] }), openAppSession: async () => session },
      });
      let retained: SheetMutationWriter | undefined;
      await expect(
        adapter.withSheetMutationSession(ensureRequest, async (writer) => {
          retained = writer;
          await writer.ensureSheet(ensureRequest);
        }),
      ).rejects.toMatchObject(uncertainFailure);
      expect(close).toHaveBeenCalledTimes(1);
      await expect(retained!.ensureSheet(ensureRequest)).rejects.toMatchObject(uncertainFailure);
      expect(engine.count().created).toBe(1);
    },
  );
});

describe('native sheet generation adapters', () => {
  it('requires explicit app creation scope before opening a live session', async () => {
    const engine = nativeEngine();
    await expect(cloudAdapter(engine, false).ensureSheet(ensureRequest)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(engine.count()).toEqual({ created: 0, closed: 0 });
  });

  it('creates once, safely resumes, and verifies exact native chart definitions and placements through fresh sessions', async () => {
    const engine = nativeEngine();
    const adapter = cloudAdapter(engine);
    const chartPlan = await plan();
    expect(await adapter.ensureSheet(ensureRequest)).toEqual({
      sheetId: target.sheetId,
      created: true,
    });
    expect(await adapter.ensureSheet(ensureRequest)).toEqual({
      sheetId: target.sheetId,
      created: false,
    });
    const persist = {
      target,
      plan: chartPlan,
      actor: MUTATOR_ACTOR,
      objectId,
      placement,
      idempotencyKey: 'chart-1',
    };
    expect(await adapter.persistChart(persist)).toEqual({ objectId });
    expect(await adapter.persistChart(persist)).toEqual({ objectId });
    expect(await adapter.attachChartToSheet({ target, objectId, placement })).toEqual({
      sheetAttachmentId: objectId,
    });
    expect(await adapter.verifyChart({ target, objectId, placement, plan: chartPlan })).toEqual({
      verified: true,
    });
    expect(await adapter.verifySheet({ ...ensureRequest, objectIds: [objectId] })).toEqual({
      verified: true,
      objectIds: [objectId],
    });
    expect(engine.count()).toEqual({ created: 2, closed: 7 });
  });

  it('writes responsive client properties and verifies percent bounds against the native grid', async () => {
    const engine = nativeEngine();
    const adapter = cloudAdapter(engine);
    const chartPlan = await plan();
    await adapter.ensureSheet(ensureRequest);
    expect(engine.objects.get(target.sheetId)).toMatchObject({
      columns: 24,
      rows: 12,
      gridResolution: 'small',
      height: 100,
      layoutOptions: { sheetMode: 'RESPONSIVE', mobileLayout: 'LIST', extendable: false },
      qMetaDef: { title: ensureRequest.title, description: '', tags: [] },
      qExtendsId: '',
      qStateName: '$',
      thumbnail: { qStaticContentUrlDef: { qUrl: '' } },
    });
    await adapter.persistChart({
      target,
      plan: chartPlan,
      actor: MUTATOR_ACTOR,
      objectId,
      placement,
      idempotencyKey: 'chart-1',
    });
    const sheet = engine.objects.get(target.sheetId)!;
    expect(sheet.cells).toEqual([
      {
        name: objectId,
        type: chartPlan.nativeChartType,
        ...placement,
        bounds: { x: 0, y: 0, width: 50, height: 50 },
      },
    ]);
    const cell = (sheet.cells as Properties[])[0]!;
    for (const drift of [
      { columns: 12 },
      { rows: 24 },
      { layoutOptions: { sheetMode: 'CUSTOM' } },
      { cells: [{ ...cell, bounds: { x: 0, y: 0, width: 100, height: 100 } }] },
      { cells: [{ ...cell, bounds: undefined }] },
    ]) {
      engine.objects.set(target.sheetId, { ...sheet, ...drift });
      expect(
        (await adapter.verifySheet({ ...ensureRequest, objectIds: [objectId] })).verified,
      ).toBe(false);
      expect(
        (await adapter.verifyChart({ target, objectId, placement, plan: chartPlan })).verified,
      ).toBe(false);
    }
  });

  it('rejects chart-level Engine validation failures even when the cube has data and no top-level error', async () => {
    const engine = nativeEngine();
    const adapter = cloudAdapter(engine);
    const chartPlan = await plan();
    await adapter.ensureSheet(ensureRequest);
    await adapter.persistChart({
      target,
      plan: chartPlan,
      actor: MUTATOR_ACTOR,
      objectId,
      placement,
      idempotencyKey: 'chart-1',
    });
    engine.failDimension();
    expect(
      (await adapter.verifyChart({ target, objectId, placement, plan: chartPlan })).verified,
    ).toBe(false);
  });

  it('rejects owner/title conflicts without adopting or editing another sheet', async () => {
    const engine = nativeEngine();
    const adapter = cloudAdapter(engine);
    await adapter.ensureSheet(ensureRequest);
    await expect(
      adapter.ensureSheet({ ...ensureRequest, title: 'Different title' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      adapter.ensureSheet({ ...ensureRequest, actor: { ...MUTATOR_ACTOR, actor: 'other-actor' } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(engine.count().created).toBe(1);
  });

  it('recognizes the same principal across clients while rejecting a different principal', async () => {
    const engine = nativeEngine();
    const adapters = [cloudAdapter(engine), new FixtureAdapter()];
    for (const adapter of adapters) {
      await adapter.ensureSheet(ensureRequest);
      const otherClient = { ...MUTATOR_ACTOR, hostClientId: 'second-authenticated-client' };
      expect(await adapter.ensureSheet({ ...ensureRequest, actor: otherClient })).toEqual({
        sheetId: target.sheetId,
        created: false,
      });
      expect(
        (await adapter.verifySheet({ ...ensureRequest, actor: otherClient, objectIds: [] }))
          .verified,
      ).toBe(true);
      expect(
        (
          await adapter.verifySheet({
            ...ensureRequest,
            actor: { ...otherClient, actor: 'different-principal' },
            objectIds: [],
          })
        ).verified,
      ).toBe(false);
    }
  });

  it('removes only a newly allocated collision object when Qlik changes the requested sheet ID', async () => {
    const engine = nativeEngine();
    engine.collideNextSheet();
    await expect(cloudAdapter(engine).ensureSheet(ensureRequest)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(engine.objects.size).toBe(0);
  });

  it('rejects overlapping, fractional, and changed retry placements before creating another chart', async () => {
    const engine = nativeEngine();
    const adapter = cloudAdapter(engine);
    await adapter.ensureSheet(ensureRequest);
    const persist = {
      target,
      plan: await plan(),
      actor: MUTATOR_ACTOR,
      objectId,
      placement,
      idempotencyKey: 'chart-1',
    };
    await adapter.persistChart(persist);
    await expect(
      adapter.persistChart({ ...persist, placement: { ...placement, col: 1 } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      adapter.persistChart({ ...persist, objectId: `${objectId}-2` }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    await expect(
      adapter.persistChart({
        ...persist,
        objectId: `${objectId}-2`,
        placement: { ...placement, row: 6.5 },
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(engine.count().created).toBe(2);
  });

  it('does not delete a previously saved chart when an idempotent retry save fails', async () => {
    const engine = nativeEngine();
    const adapter = cloudAdapter(engine);
    await adapter.ensureSheet(ensureRequest);
    const persist = {
      target,
      plan: await plan(),
      actor: MUTATOR_ACTOR,
      objectId,
      placement,
      idempotencyKey: 'chart-1',
    };
    await adapter.persistChart(persist);
    engine.failNextSave();
    await expect(adapter.persistChart(persist)).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    expect(engine.objects.has(objectId)).toBe(true);
  });

  it('allows independent generated-sheet readback after write readiness is withdrawn', async () => {
    const engine = nativeEngine();
    const writer = cloudAdapter(engine);
    const chartPlan = await plan();
    await writer.ensureSheet(ensureRequest);
    await writer.persistChart({
      target,
      plan: chartPlan,
      actor: MUTATOR_ACTOR,
      objectId,
      placement,
      idempotencyKey: 'chart-1',
    });
    const reader = cloudAdapter(engine, true, false);
    expect(await reader.verifyChart({ target, objectId, placement, plan: chartPlan })).toEqual({
      verified: true,
    });
    expect((await reader.verifySheet({ ...ensureRequest, objectIds: [objectId] })).verified).toBe(
      true,
    );
    await expect(reader.ensureSheet(ensureRequest)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('fails readback after formula drift or an unexpected sheet member appears', async () => {
    const engine = nativeEngine();
    const adapter = cloudAdapter(engine);
    const chartPlan = await plan();
    await adapter.ensureSheet(ensureRequest);
    await adapter.persistChart({
      target,
      plan: chartPlan,
      actor: MUTATOR_ACTOR,
      objectId,
      placement,
      idempotencyKey: 'chart-1',
    });
    engine.objects.set(objectId, { ...engine.objects.get(objectId), qHyperCubeDef: {} });
    expect(await adapter.verifyChart({ target, objectId, placement, plan: chartPlan })).toEqual({
      verified: false,
    });
    const sheet = engine.objects.get(target.sheetId)!;
    engine.objects.set(target.sheetId, {
      ...sheet,
      cells: [
        ...(sheet.cells as unknown[]),
        { name: 'unexpected', type: 'kpi', col: 12, row: 0, colspan: 12, rowspan: 6 },
      ],
    });
    expect((await adapter.verifySheet({ ...ensureRequest, objectIds: [objectId] })).verified).toBe(
      false,
    );
  });

  it('discovers cell-referenced visualizations even when Engine child infos omit them', async () => {
    const engine = nativeEngine();
    engine.objects.set(target.sheetId, {
      qInfo: { qId: target.sheetId, qType: 'sheet' },
      cells: [{ name: 'native-visual', type: 'kpi', ...placement }],
    });
    engine.objects.set('native-visual', {
      qInfo: { qId: 'native-visual', qType: 'kpi' },
      title: 'Revenue',
    });
    const result = await engine.session().listSheetObjects(target.sheetId, 0, 10);
    expect(result).toEqual({
      total: 1,
      objects: [{ id: 'native-visual', type: 'kpi', title: 'Revenue' }],
    });
  });

  it('uses evaluated layout for expression-based chart titles', async () => {
    const sheet = {
      getProperties: async () => ({ cells: [{ name: 'expression-chart', type: 'kpi' }] }),
      getChildInfos: async () => [],
    };
    const chart = {
      getProperties: async () => ({
        title: { qStringExpression: { qExpr: "='Evaluated revenue'" } },
      }),
      getLayout: async () => ({ title: 'Evaluated revenue' }),
    };
    const session = new QlikApiAppSession(
      { close: async () => undefined } as never,
      { getObject: async (id: string) => (id === 'sheet' ? sheet : chart) } as never,
    );
    expect(await session.listSheetObjects('sheet', 0, 10)).toEqual({
      total: 1,
      objects: [{ id: 'expression-chart', type: 'kpi', title: 'Evaluated revenue' }],
    });
  });

  it('reuses Engine handles in one session while reading fresh properties and bounding metadata concurrency', async () => {
    let opened = 0;
    let active = 0;
    let maximum = 0;
    let title = 'Initial';
    const cells = Array.from({ length: 17 }, (_, index) => ({
      name: `chart-${index}`,
      type: 'kpi',
    }));
    const sheet = { getProperties: async () => ({ cells }), getChildInfos: async () => [] };
    const doc = {
      getObject: async (id: string) => {
        opened += 1;
        if (id === 'sheet') return sheet;
        return {
          getProperties: async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await Promise.resolve();
            active -= 1;
            return { title };
          },
        };
      },
    };
    const session = new QlikApiAppSession({ close: async () => undefined } as never, doc as never);
    expect((await session.listSheetObjects('sheet', 0, 100)).objects).toHaveLength(17);
    expect(maximum).toBe(8);
    expect(opened).toBe(18);
    title = 'Updated';
    expect(await session.getObjectProperties('chart-0')).toEqual({ title: 'Updated' });
    expect(opened).toBe(18);
  });

  it('keeps fixture generation, exact verification, and idempotency consistent with Cloud', async () => {
    const adapter = new FixtureAdapter();
    const chartPlan = await plan();
    await adapter.ensureSheet(ensureRequest);
    const persist = {
      target,
      plan: chartPlan,
      actor: MUTATOR_ACTOR,
      objectId,
      placement,
      idempotencyKey: 'chart-1',
    };
    await adapter.persistChart(persist);
    await adapter.persistChart(persist);
    await adapter.attachChartToSheet({ target, objectId, placement });
    expect(await adapter.verifyChart({ target, objectId, placement, plan: chartPlan })).toEqual({
      verified: true,
    });
    expect(await adapter.verifySheet({ ...ensureRequest, objectIds: [objectId] })).toEqual({
      verified: true,
      objectIds: [objectId],
    });
    expect(
      (await adapter.getCompilationContext(target.connection, target.appId, MUTATOR_ACTOR)).sheets,
    ).toContainEqual({ sheetId: target.sheetId, name: ensureRequest.title, writeAllowed: true });
    await expect(
      adapter.persistChart({ ...persist, objectId: `${objectId}-2` }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    await expect(
      adapter.ensureSheet({ ...ensureRequest, idempotencyKey: 'different' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});
