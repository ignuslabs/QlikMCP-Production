import { describe, expect, it } from 'vitest';
import { FixtureAdapter } from '../../../src/adapters/fixture/fixtureAdapter.js';
import { compileChartIntent } from '../../../src/compiler/compiler.js';
import { chartIntentSchema } from '../../../src/compiler/chartIntentSchema.js';
import {
  MUTATOR_ACTOR,
  CLOUD_DEV,
  WINDOWS_DEV,
  barChartIntent,
} from '../../helpers/testContext.js';

/**
 * Adapter parity: Cloud and Windows share one logical catalog/operation
 * contract (see docs/02-platform-support-matrix.md and
 * test/fixtures/catalog.json) even though a live deployment would route
 * each connection alias through a genuinely distinct adapter/transport
 * (see CloudAdapter/WindowsAdapter). This suite proves the *contract* is
 * platform-neutral by running the identical assertions against both
 * `cloud-dev` and `windows-dev`.
 */
describe.each([
  { label: 'cloud-dev', target: CLOUD_DEV, platform: 'cloud' as const },
  { label: 'windows-dev', target: WINDOWS_DEV, platform: 'windows' as const },
])('adapter contract parity: $label', ({ target, platform }) => {
  const adapter = new FixtureAdapter();

  it('reports a full capability probe', async () => {
    const capabilities = await adapter.getEnvironmentCapabilities(target.connection);
    expect(capabilities.platform).toBe(platform);
    expect(capabilities).toMatchObject({
      canRead: true,
      canPreview: true,
      canWriteDesignatedSheet: true,
    });
  });

  it('exposes the same catalog ID and field/master-item catalog IDs', async () => {
    const catalog = await adapter.getSemanticCatalog(
      target.connection,
      target.appId,
      MUTATOR_ACTOR,
    );
    expect(catalog.catalogId).toBe('sales-demo-v1');
    expect(catalog.dimensions.map((field) => field.id).sort()).toEqual(
      [
        'field-customer-id',
        'field-order-date',
        'field-region',
        'field-status-customer',
        'field-status-order',
      ].sort(),
    );
    expect(catalog.masterItems.map((item) => item.id).sort()).toEqual(
      ['master-margin', 'master-order-date', 'master-region', 'master-revenue'].sort(),
    );
  });

  it('exposes an identical writable/read-only sheet shape', async () => {
    const catalog = await adapter.getSemanticCatalog(
      target.connection,
      target.appId,
      MUTATOR_ACTOR,
    );
    const writable = catalog.sheets.filter((sheet) => sheet.writeAllowed);
    const readOnly = catalog.sheets.filter((sheet) => !sheet.writeAllowed);
    expect(writable).toHaveLength(1);
    expect(readOnly).toHaveLength(1);
    expect(writable[0]!.sheetId).toBe(target.writableSheetId);
    expect(readOnly[0]!.sheetId).toBe(target.readOnlySheetId);
  });

  it('compiles the same normalized bar-chart plan to the same resolved catalog references', async () => {
    const context = await adapter.getCompilationContext(
      target.connection,
      target.appId,
      MUTATOR_ACTOR,
    );
    const plan = compileChartIntent({
      catalog: context.catalog,
      target: {
        connection: target.connection,
        appId: target.appId,
        sheetId: target.writableSheetId,
      },
      platform,
      intent: chartIntentSchema.parse(barChartIntent()),
    });
    expect(plan.resolved.dimensions.map((dimension) => dimension.catalogId)).toEqual([
      'master-region',
    ]);
    expect(plan.resolved.measures.map((measure) => measure.catalogId)).toEqual(['master-revenue']);
    expect(plan.nativeChartType).toBe('barchart');
  });

  it('supports the full end-to-end create/attach/verify/cleanup lifecycle', async () => {
    const context = await adapter.getCompilationContext(
      target.connection,
      target.appId,
      MUTATOR_ACTOR,
    );
    const fullTarget = {
      connection: target.connection,
      appId: target.appId,
      sheetId: target.writableSheetId,
    };
    const plan = compileChartIntent({
      catalog: context.catalog,
      target: fullTarget,
      platform,
      intent: chartIntentSchema.parse(barChartIntent()),
    });
    const persisted = await adapter.persistChart({
      target: fullTarget,
      plan,
      actor: MUTATOR_ACTOR,
      idempotencyKey: 'parity-key',
    });
    const attached = await adapter.attachChartToSheet({
      target: fullTarget,
      objectId: persisted.objectId,
    });
    const verified = await adapter.verifyChart({
      target: fullTarget,
      objectId: persisted.objectId,
    });
    expect(verified.verified).toBe(true);
    const cleanup = await adapter.cleanupObject({
      target: fullTarget,
      objectId: persisted.objectId,
      sheetAttachmentId: attached.sheetAttachmentId,
    });
    expect(cleanup.outcome).toBe('cleanup-complete');
  });
});
