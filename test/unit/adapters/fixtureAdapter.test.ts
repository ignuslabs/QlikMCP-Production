import { describe, expect, it } from 'vitest';
import { FixtureAdapter } from '../../../src/adapters/fixture/fixtureAdapter.js';
import { compileChartIntent } from '../../../src/compiler/compiler.js';
import { chartIntentSchema } from '../../../src/compiler/chartIntentSchema.js';
import { MUTATOR_ACTOR, CLOUD_DEV, barChartIntent } from '../../helpers/testContext.js';

const actorContext = MUTATOR_ACTOR;

function buildPlan(adapter: FixtureAdapter, overrides?: Parameters<typeof barChartIntent>[0]) {
  return adapter
    .getCompilationContext(CLOUD_DEV.connection, CLOUD_DEV.appId, actorContext, 'default')
    .then((context) =>
      compileChartIntent({
        catalog: context.catalog,
        target: {
          connection: CLOUD_DEV.connection,
          appId: CLOUD_DEV.appId,
          sheetId: CLOUD_DEV.writableSheetId,
        },
        platform: 'cloud',
        intent: chartIntentSchema.parse(barChartIntent(overrides)),
      }),
    );
}

describe('FixtureAdapter', () => {
  it('reports full capability for a known connection', async () => {
    const adapter = new FixtureAdapter();
    const capabilities = await adapter.getEnvironmentCapabilities(CLOUD_DEV.connection);
    expect(capabilities).toMatchObject({
      configured: true,
      canRead: true,
      canPreview: true,
      canWriteDesignatedSheet: true,
    });
  });

  it('lists the single accessible app for a connection', async () => {
    const adapter = new FixtureAdapter();
    const result = await adapter.listAccessibleApps(CLOUD_DEV.connection, actorContext);
    expect(result.apps).toEqual([
      {
        appId: CLOUD_DEV.appId,
        name: 'Synthetic Sales Cloud Development',
        connection: CLOUD_DEV.connection,
        platform: 'cloud',
        environment: 'development',
      },
    ]);
  });

  it('throws NOT_FOUND for an unknown connection alias', async () => {
    const adapter = new FixtureAdapter();
    await expect(adapter.listAccessibleApps('unknown-dev', actorContext)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('returns the bounded catalog with visible fields split by role', async () => {
    const adapter = new FixtureAdapter();
    const catalog = await adapter.getSemanticCatalog(
      CLOUD_DEV.connection,
      CLOUD_DEV.appId,
      actorContext,
    );
    expect(catalog.dimensions.map((field) => field.id)).toContain('field-region');
    expect(catalog.measures.map((field) => field.id)).toContain('field-revenue');
    expect(catalog.sheets).toHaveLength(2);
    // Sensitive/hidden metadata must never appear in the public catalog projection.
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toMatch(/CustomerEmail/);
    expect(serialized).not.toMatch(/InternalTenantKey/);
  });

  it('throws EMPTY_CATALOG for the empty catalog variant', async () => {
    const adapter = new FixtureAdapter();
    await expect(
      adapter.getSemanticCatalog(CLOUD_DEV.connection, CLOUD_DEV.appId, actorContext, 'empty'),
    ).rejects.toMatchObject({
      code: 'EMPTY_CATALOG',
    });
  });

  it('creates and disposes a disposable session chart', async () => {
    const adapter = new FixtureAdapter();
    const plan = await buildPlan(adapter);
    const result = await adapter.createSessionChart({
      target: {
        connection: CLOUD_DEV.connection,
        appId: CLOUD_DEV.appId,
        sheetId: CLOUD_DEV.writableSheetId,
      },
      plan,
      actor: actorContext,
      signal: new AbortController().signal,
    });
    expect(result.layout.bounded.rawDataIncluded).toBe(false);
    expect(result.layout.qHyperCube.qDataPages[0]?.qMatrix.length).toBeGreaterThan(0);
    await expect(
      adapter.disposeSessionChart(CLOUD_DEV.connection, result.sessionObjectId),
    ).resolves.toBeUndefined();
  });

  it('persists, attaches, verifies, and cleans up a chart', async () => {
    const adapter = new FixtureAdapter();
    const plan = await buildPlan(adapter);
    const target = {
      connection: CLOUD_DEV.connection,
      appId: CLOUD_DEV.appId,
      sheetId: CLOUD_DEV.writableSheetId,
    };
    const persisted = await adapter.persistChart({
      target,
      plan,
      actor: actorContext,
      idempotencyKey: 'key-1',
    });
    const attached = await adapter.attachChartToSheet({ target, objectId: persisted.objectId });
    const verified = await adapter.verifyChart({ target, objectId: persisted.objectId });
    expect(verified.verified).toBe(true);

    const objects = await adapter.listSheetObjects(
      target.connection,
      target.appId,
      target.sheetId,
      actorContext,
    );
    expect(objects.objects.map((entry) => entry.objectId)).toContain(persisted.objectId);

    const cleanup = await adapter.cleanupObject({
      target,
      objectId: persisted.objectId,
      sheetAttachmentId: attached.sheetAttachmentId,
    });
    expect(cleanup.outcome).toBe('cleanup-complete');

    const objectsAfterCleanup = await adapter.listSheetObjects(
      target.connection,
      target.appId,
      target.sheetId,
      actorContext,
    );
    expect(objectsAfterCleanup.objects.map((entry) => entry.objectId)).not.toContain(
      persisted.objectId,
    );
  });

  it('produces a qlik-embed render descriptor with no credential material', () => {
    const adapter = new FixtureAdapter();
    const descriptor = adapter.renderDescriptor(
      {
        connection: CLOUD_DEV.connection,
        appId: CLOUD_DEV.appId,
        sheetId: CLOUD_DEV.writableSheetId,
      },
      'object-1',
      'operation-1',
      'persisted',
    );
    expect(descriptor).toEqual({
      rendering: 'qlik-embed',
      connectionAlias: CLOUD_DEV.connection,
      appId: CLOUD_DEV.appId,
      objectId: 'object-1',
      operationId: 'operation-1',
      mode: 'persisted',
    });
  });

  it('fires a scheduled fault exactly once for the targeted method', async () => {
    const adapter = new FixtureAdapter({
      faults: [
        { method: 'createSessionChart', errorCode: 'CAPACITY_EXHAUSTED', retryAfterSeconds: 0.01 },
      ],
    });
    const plan = await buildPlan(adapter);
    const target = {
      connection: CLOUD_DEV.connection,
      appId: CLOUD_DEV.appId,
      sheetId: CLOUD_DEV.writableSheetId,
    };
    await expect(
      adapter.createSessionChart({
        target,
        plan,
        actor: actorContext,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'CAPACITY_EXHAUSTED',
      retryable: true,
    });
    // Second attempt succeeds; the scheduled fault was consumed exactly once.
    await expect(
      adapter.createSessionChart({
        target,
        plan,
        actor: actorContext,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeDefined();
  });
});
