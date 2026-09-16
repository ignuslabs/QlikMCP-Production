import { describe, expect, it, vi } from 'vitest';
import {
  runManagementLifecycleAcceptance,
  type LifecycleFixture,
} from '../../live/managementLifecycleAcceptance.js';
import type { AcceptanceClient } from '../../live/managementAcceptance.js';
import { ENGINE_ACTION_SCHEMAS } from '../../../src/management/cloudEngineProvider.js';
import { computePlanHash } from '../../../src/domain/ids.js';

type Json = Record<string, unknown>;
type Step = { action: string; input: Json };
const runId = '12345678-1234-1234-1234-123456789abc';
const fixture: LifecycleFixture = {
  connection: 'cloud',
  appId: 'fresh-app',
  spaceId: 'sandbox',
  appName: `Harness acceptance ${runId}`,
  namePrefix: 'Harness acceptance ',
  ownsAppVerified: true,
};
const object = (value: unknown) => value as Json;
interface FakeOptions {
  wrongApp?: boolean;
  wrongRows?: boolean;
  wrongAverage?: boolean;
  foreignCopy?: boolean;
  uncertain?: boolean;
  lostResponse?: boolean;
  recoverable?: boolean;
  approval?: boolean;
  absenceNetworkFailure?: boolean;
  typedCells?: boolean;
}

function fakeServer(options: FakeOptions = {}) {
  const sheets = new Map<string, Json>();
  const charts = new Map<string, Json>();
  const masters = new Map<string, Json>();
  const plans = new Map<string, { step: Step; approved: boolean; receipt?: Json }>();
  const writes: Step[] = [];
  const cells = (sheetId: string) => sheets.get(sheetId)!.cells as Json[];
  const sheetHash = (sheetId: string) =>
    computePlanHash({
      sheet: sheets.get(sheetId),
      children: cells(sheetId).map((cell) => charts.get(String(cell.objectId))),
    });
  const masterProperties = (input: Json) => ({
    qInfo: { qId: input.itemId, qType: input.kind },
    qMetaDef: { title: input.title },
    ...(input.kind === 'dimension'
      ? { qDim: { qFieldDefs: input.fields } }
      : { qMeasure: { qDef: input.expression } }),
  });
  const write = ({ action, input }: Step): Json => {
    writes.push({ action, input });
    const sheetId = String(input.sheetId);
    const objectId = String(input.objectId);
    const itemId = String(input.itemId);
    if (action === 'master.create' || action === 'master.update') {
      if (action === 'master.update')
        expect(input.expectedHash).toBe(computePlanHash(masters.get(itemId)));
      else expect(masters.has(itemId)).toBe(false);
      masters.set(itemId, masterProperties(input));
      return {
        itemId,
        kind: input.kind,
        verified: true,
        expectedHash: computePlanHash(masters.get(itemId)),
        script: 'secret never report',
      };
    }
    if (action === 'master.delete') {
      expect(input.expectedHash).toBe(computePlanHash(masters.get(itemId)));
      masters.delete(itemId);
      return { itemId, kind: input.kind, deleted: true, verified: true };
    }
    if (action === 'sheet.create') {
      expect(sheets.has(sheetId)).toBe(false);
      sheets.set(sheetId, { title: input.title, cells: [] });
      return { sheetId, expectedHash: sheetHash(sheetId), verified: true };
    }
    if (action === 'chart.create' || action === 'filter.create') {
      expect(input.expectedSheetHash).toBe(sheetHash(sheetId));
      const type = action === 'filter.create' ? 'filterpane' : 'table';
      charts.set(objectId, {
        type,
        title:
          action === 'filter.create'
            ? input.title
            : object(object(input.intent).presentation).title,
        intent: input.intent,
      });
      cells(sheetId).push({ ...object(input.placement), objectId, type, ownership: 'sheet-child' });
      return {
        objectId,
        verified: true,
        expectedHash: computePlanHash(charts.get(objectId)),
        expectedSheetHash: sheetHash(sheetId),
      };
    }
    if (action === 'chart.update') {
      expect(input.expectedHash).toBe(computePlanHash(charts.get(objectId)));
      charts.set(objectId, {
        ...charts.get(objectId),
        intent: input.intent,
        title: object(object(input.intent).presentation).title,
      });
      return { objectId, verified: true, expectedHash: computePlanHash(charts.get(objectId)) };
    }
    if (action === 'sheet.update') {
      expect(input.expectedHash).toBe(sheetHash(sheetId));
      const nextCells = (input.cells as Json[]).map((cell) => ({
        ...cells(sheetId).find((old) => old.objectId === cell.objectId),
        ...cell,
      }));
      sheets.set(sheetId, { title: input.title, description: input.description, cells: nextCells });
      return { sheetId, expectedHash: sheetHash(sheetId), verified: true };
    }
    if (action === 'chart.reorder') {
      expect(input.expectedHash).toBe(sheetHash(sheetId));
      const reordered = (input.objectIds as string[]).map((id) =>
        cells(sheetId).find((cell) => cell.objectId === id)!,
      );
      sheets.set(sheetId, { ...sheets.get(sheetId), cells: reordered });
      return { sheetId, expectedHash: sheetHash(sheetId), verified: true };
    }
    if (action === 'sheet.duplicate') {
      expect(input.expectedHash).toBe(sheetHash(sheetId));
      const destination = String(input.newSheetId);
      expect(sheets.has(destination)).toBe(false);
      const copied = cells(sheetId).map((cell, index) => {
        const copiedId = `${destination}-${index}`;
        charts.set(copiedId, structuredClone(charts.get(String(cell.objectId))!));
        return {
          ...cell,
          objectId: copiedId,
          ownership: options.foreignCopy ? 'app-reference' : 'sheet-child',
        };
      });
      sheets.set(destination, { title: input.title, cells: copied });
      return { sheetId: destination, verified: true, expectedHash: sheetHash(destination) };
    }
    if (action === 'chart.delete') {
      expect(input.expectedHash).toBe(computePlanHash(charts.get(objectId)));
      expect(input.expectedSheetHash).toBe(sheetHash(sheetId));
      charts.delete(objectId);
      sheets.set(sheetId, {
        ...sheets.get(sheetId),
        cells: cells(sheetId).filter((cell) => cell.objectId !== objectId),
      });
      return { objectId, deleted: true, objectDeleted: true, verified: true };
    }
    if (action === 'sheet.delete') {
      expect(input.expectedHash).toBe(sheetHash(sheetId));
      for (const cell of cells(sheetId)) charts.delete(String(cell.objectId));
      sheets.delete(sheetId);
      return { sheetId, deleted: true, verified: true };
    }
    throw new Error('UNEXPECTED_FAKE_MUTATION');
  };
  const absent = (): never => {
    throw new Error(options.absenceNetworkFailure ? 'TRANSIENT_UNAVAILABLE' : 'NOT_FOUND');
  };
  const read = ({ action, input }: Step): Json => {
    const sheetId = String(input.sheetId);
    const objectId = String(input.objectId);
    const itemId = String(input.itemId);
    if (action === 'app.get')
      return {
        appId: options.wrongApp ? 'user-original-app' : fixture.appId,
        spaceId: fixture.spaceId,
        name: fixture.appName,
      };
    if (action === 'model.inspect') return { tables: [{ name: 'AcceptanceData', rowCount: 3 }] };
    if (action === 'table.preview') {
      const rows = [
        [100, 'North'],
        ['50', 'South'],
        [options.wrongRows ? 99 : 25, 'North'],
      ];
      return {
        columns: ['Amount', 'Category'],
        rows: options.typedCells
          ? rows.map(([amount, category]) => [
              { qIsNumeric: true, qNumber: Number(amount), qText: `$${amount}.00` },
              { qText: category },
            ])
          : rows,
        totalRows: 3,
      };
    }
    if (action === 'master.get') {
      if (!masters.has(itemId)) return absent();
      return {
        itemId,
        kind: input.kind,
        properties: masters.get(itemId),
        expectedHash: computePlanHash(masters.get(itemId)),
      };
    }
    if (action === 'sheet.get') {
      if (!sheets.has(sheetId)) return absent();
      return { sheetId, ...structuredClone(sheets.get(sheetId)), expectedHash: sheetHash(sheetId) };
    }
    if (action === 'chart.get') {
      if (!charts.has(objectId)) return absent();
      return {
        sheetId,
        objectId,
        ...charts.get(objectId),
        ownership: 'sheet-child',
        expectedHash: computePlanHash(charts.get(objectId)),
        expectedSheetHash: sheetHash(sheetId),
      };
    }
    if (action === 'chart.export') {
      const intent = object(charts.get(objectId)!.intent);
      const average = (object(intent.analysis).measures as string[])[0] === 'Avg(Amount)';
      return {
        rows: [
          [{ text: 'North' }, { number: average ? (options.wrongAverage ? 999 : 62.5) : 125 }],
          [{ text: 'South' }, { number: 50 }],
        ],
      };
    }
    throw new Error('UNEXPECTED_FAKE_READ');
  };
  const validate = (step: Step) => {
    expect(step.input.appId).toBe(fixture.appId);
    expect(step.input.connection).toBe(fixture.connection);
    if (step.action !== 'app.get')
      ENGINE_ACTION_SCHEMAS[step.action as keyof typeof ENGINE_ACTION_SCHEMAS].parse(step.input);
  };
  const client: AcceptanceClient = {
    close: vi.fn(async () => undefined),
    call: vi.fn(async (name, input) => {
      if (name === 'qlik_management_catalog')
        return {
          actions: ['app.get', ...Object.keys(ENGINE_ACTION_SCHEMAS)].map((action) => ({ action })),
        };
      if (name === 'qlik_management_read') {
        const step = input as unknown as Step;
        validate(step);
        return read(step);
      }
      if (name === 'qlik_management_plan') {
        const step = (input.steps as Step[])[0]!;
        expect(input.steps).toHaveLength(1);
        validate(step);
        const planId = `plan-${plans.size}`;
        plans.set(planId, { step: structuredClone(step), approved: !options.approval });
        return { planId, status: options.approval ? 'awaiting-approval' : 'approved' };
      }
      if (name === 'qlik_management_execute') {
        const plan = plans.get(String(input.planId))!;
        expect(plan.approved).toBe(true);
        expect(input.steps).toEqual([plan.step]);
        expect(plan.receipt).toBeUndefined();
        plan.receipt = write(plan.step);
        if (writes.length === 1 && options.lostResponse)
          throw new Error('Bearer secret provider response');
        if (writes.length === 1 && options.uncertain)
          return { status: 'needs-reconciliation', acknowledged: plan.receipt };
        return { status: 'completed', steps: [plan.receipt] };
      }
      if (name === 'qlik_management_reconcile') {
        const plan = plans.get(String(input.planId))!;
        expect(input.steps).toEqual([plan.step]);
        expect(input.index).toBe(0);
        return options.recoverable
          ? { status: 'completed', result: plan.receipt }
          : { status: 'needs-reconciliation' };
      }
      throw new Error('UNEXPECTED_FAKE_TOOL');
    }),
  };
  return {
    client,
    writes,
    sheets,
    charts,
    masters,
    approve: async ({ planId }: { planId: string }) => {
      plans.get(planId)!.approved = true;
    },
  };
}

describe('bounded native management lifecycle acceptance', () => {
  it('reads QIX FieldValue cells using numeric duals instead of formatted display text', async () => {
    const fake = fakeServer({ typedCells: true });
    const report = await runManagementLifecycleAcceptance(fake.client, fixture, { runId });
    expect(report.status).toBe('passed');
    expect(report.checks).toContain('exact-owned-app-and-three-synthetic-rows');
    const changed = fakeServer({ typedCells: true, wrongRows: true });
    expect(
      await runManagementLifecycleAcceptance(changed.client, fixture, { runId }),
    ).toMatchObject({ status: 'failed-or-pending', errorCode: 'FIXTURE_ROWS_MISMATCH' });
    expect(changed.writes).toHaveLength(0);
  });
  it('requires explicit verified ownership and an exact acceptance name before using the client', async () => {
    const fake = fakeServer();
    await expect(
      runManagementLifecycleAcceptance(fake.client, { ...fixture, ownsAppVerified: false }),
    ).rejects.toThrow('VERIFIED_FIXTURE_OWNERSHIP_REQUIRED');
    await expect(
      runManagementLifecycleAcceptance(fake.client, { ...fixture, appName: 'My real app' }),
    ).rejects.toThrow('EXACT_ACCEPTANCE_APP_NAME_REQUIRED');
    expect(fake.client.call).not.toHaveBeenCalled();
  });

  it.each([{ wrongApp: true }, { wrongRows: true }])(
    'fails preflight without any mutations for %j',
    async (options) => {
      const fake = fakeServer(options);
      const report = await runManagementLifecycleAcceptance(fake.client, fixture, { runId });
      expect(report.status).toBe('failed-or-pending');
      expect(fake.writes).toHaveLength(0);
    },
  );

  it('exercises schema-valid lifecycle edits, verifies actual values, and deletes only its own children', async () => {
    const fake = fakeServer();
    const snapshots: Json[] = [];
    const report = await runManagementLifecycleAcceptance(fake.client, fixture, {
      runId,
      persist: async (value) => {
        snapshots.push(value);
      },
    });
    expect(report.status).toBe('passed');
    expect(report.checks).toContain('original-fixture-app-retained');
    expect(fake.sheets.size + fake.charts.size + fake.masters.size).toBe(0);
    expect(fake.writes.map((step) => step.action)).toEqual([
      'master.create',
      'master.update',
      'master.create',
      'master.update',
      'sheet.create',
      'chart.create',
      'chart.update',
      'filter.create',
      'sheet.update',
      'chart.reorder',
      'sheet.duplicate',
      'sheet.delete',
      'chart.delete',
      'chart.delete',
      'sheet.delete',
      'master.delete',
      'master.delete',
    ]);
    for (const step of fake.writes.filter((step) => step.action.endsWith('.delete'))) {
      expect(step.input.itemId ?? step.input.objectId ?? step.input.sheetId).toMatch(
        /^acceptance-lifecycle-/,
      );
    }
    expect(Number(report.callCount)).toBeLessThan(100);
    expect(JSON.stringify(snapshots)).not.toContain('secret never report');
    expect(JSON.stringify(snapshots)).not.toContain('North');
    expect(fake.client.close).not.toHaveBeenCalled();
  });

  it.each([{ uncertain: true }, { lostResponse: true }])(
    'reconciles the exact original plan without repeating dispatch for %j',
    async (options) => {
      const fake = fakeServer({ ...options, recoverable: true });
      const report = await runManagementLifecycleAcceptance(fake.client, fixture, { runId });
      expect(report.status).toBe('passed');
      expect(object((report.steps as Json[])[0]).reconciled).toBe(true);
      expect(fake.writes).toHaveLength(17);
      expect(JSON.stringify(report)).not.toContain('Bearer');
    },
  );

  it('bounds reconciliation and preserves created resources when verification remains uncertain', async () => {
    const fake = fakeServer({ uncertain: true });
    const sleep = vi.fn(async () => undefined);
    const report = await runManagementLifecycleAcceptance(fake.client, fixture, { runId, sleep });
    expect(report).toMatchObject({
      status: 'failed-or-pending',
      errorCode: 'WORKFLOW_REQUIRES_RECONCILIATION',
      retainedChildrenMayExist: true,
    });
    expect(fake.writes).toHaveLength(1);
    expect(fake.masters.size).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(fake.client.call)
        .mock.calls.filter(([name]) => name === 'qlik_management_reconcile'),
    ).toHaveLength(3);
  });

  it.each([{ wrongAverage: true }, { foreignCopy: true }])(
    'stops before deletion when readback fails for %j',
    async (options) => {
      const fake = fakeServer(options);
      const report = await runManagementLifecycleAcceptance(fake.client, fixture, { runId });
      expect(report.status).toBe('failed-or-pending');
      expect(fake.writes.some((step) => step.action.endsWith('.delete'))).toBe(false);
    },
  );

  it('never treats a network failure as proof of deletion', async () => {
    const fake = fakeServer({ absenceNetworkFailure: true });
    const report = await runManagementLifecycleAcceptance(fake.client, fixture, { runId });
    expect(report).toMatchObject({
      status: 'failed-or-pending',
      errorCode: 'TRANSIENT_UNAVAILABLE',
    });
    expect(fake.writes.filter((step) => step.action.endsWith('.delete'))).toHaveLength(1);
  });

  it('requires an explicit approval callback when the fixture grant requires review', async () => {
    const missing = fakeServer({ approval: true });
    expect(
      await runManagementLifecycleAcceptance(missing.client, fixture, { runId }),
    ).toMatchObject({
      status: 'failed-or-pending',
      errorCode: 'SEPARATE_REVIEWER_APPROVAL_REQUIRED',
    });
    expect(missing.writes).toHaveLength(0);
    const approved = fakeServer({ approval: true });
    const approve = vi.fn(approved.approve);
    expect(
      (await runManagementLifecycleAcceptance(approved.client, fixture, { runId, approve })).status,
    ).toBe('passed');
    expect(approve).toHaveBeenCalledTimes(17);
  });
});
