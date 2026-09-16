/** Opt-in fixture helper. Importing this module never opens a connection or mutates Qlik. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AcceptanceClient } from './managementAcceptance.js';

type Json = Record<string, unknown>;
type Step = { action: string; input: Json };
export interface LifecycleFixture {
  readonly connection: string;
  readonly appId: string;
  readonly spaceId: string;
  readonly appName: string;
  readonly namePrefix: string;
  /** The caller must have created and independently verified this disposable fixture app. */
  readonly ownsAppVerified: boolean;
}
export interface LifecycleOptions {
  readonly runId?: string;
  readonly persist?: (report: Json) => Promise<void>;
  /** Optional, explicitly authorized separate-reviewer integration. Never approves implicitly. */
  readonly approve?: (request: { planId: string; steps: Step[] }) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<unknown>;
}

const actions = [
  'app.get',
  'model.inspect',
  'table.preview',
  'sheet.get',
  'sheet.create',
  'sheet.update',
  'sheet.duplicate',
  'sheet.delete',
  'chart.get',
  'chart.create',
  'chart.update',
  'chart.reorder',
  'chart.export',
  'chart.delete',
  'filter.create',
  'master.get',
  'master.create',
  'master.update',
  'master.delete',
] as const;
const receiptKeys = new Set([
  'sheetId',
  'objectId',
  'itemId',
  'kind',
  'expectedHash',
  'expectedSheetHash',
  'verified',
  'deleted',
  'objectDeleted',
  'retainedAppObject',
  'retainedAppObjectCount',
]);
function fail(code: string): never {
  throw new Error(code);
}
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_TOOL_RESPONSE');
  return value as Json;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value))
    fail('INVALID_FIXTURE_IDENTIFIER');
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))
    fail('INVALID_RESOURCE_HASH');
  return value;
}
function tableValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  // GetTableData returns FieldValue cells, unlike hypercube export cells. Numeric
  // duals must use qNumber; qText may contain locale or currency formatting.
  const field = object(value);
  if (field.qIsNumeric === true) {
    if (typeof field.qNumber !== 'number' || !Number.isFinite(field.qNumber))
      fail('FIXTURE_ROWS_MISMATCH');
    return field.qNumber;
  }
  if (typeof field.qText !== 'string') fail('FIXTURE_ROWS_MISMATCH');
  return field.qText;
}
function receipt(value: Json): Json {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) =>
        receiptKeys.has(key) &&
        ((typeof item === 'string' && item.length <= 200) ||
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item))),
    ),
  );
}
function errorCode(error: unknown): string {
  const candidate =
    error instanceof Error
      ? error.message
      : error && typeof error === 'object'
        ? (error as Json).code
        : undefined;
  return typeof candidate === 'string' && /^[A-Z_]{1,100}$/.test(candidate)
    ? candidate
    : 'LIFECYCLE_OPERATION_FAILED';
}

/**
 * Exercises only child resources created by this invocation. It never changes an app,
 * script, dataset, or existing sheet, and never performs cleanup after an uncertain result.
 * The caller owns the client lifetime and decides whether evidence is live or injected.
 */
export async function runManagementLifecycleAcceptance(
  client: AcceptanceClient,
  fixture: LifecycleFixture,
  options: LifecycleOptions = {},
): Promise<Json> {
  if (fixture.ownsAppVerified !== true) fail('VERIFIED_FIXTURE_OWNERSHIP_REQUIRED');
  for (const value of [fixture.connection, fixture.appId, fixture.spaceId]) identifier(value);
  if (
    typeof fixture.namePrefix !== 'string' ||
    fixture.namePrefix.length < 12 ||
    fixture.namePrefix.length > 100 ||
    !/acceptance/i.test(fixture.namePrefix) ||
    typeof fixture.appName !== 'string' ||
    fixture.appName.length > 200 ||
    !fixture.appName.startsWith(fixture.namePrefix) ||
    fixture.appName === fixture.namePrefix
  )
    fail('EXACT_ACCEPTANCE_APP_NAME_REQUIRED');
  const runId = options.runId ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(runId)) fail('INVALID_LIFECYCLE_RUN_ID');
  const prefix = `acceptance-lifecycle-${runId}`;
  const ids = {
    sheetId: `${prefix}-sheet`,
    copySheetId: `${prefix}-copy`,
    objectId: `${prefix}-chart`,
    filterId: `${prefix}-filter`,
    dimensionId: `${prefix}-dimension`,
    measureId: `${prefix}-measure`,
  };
  const steps: Json[] = [];
  const checks: string[] = [];
  const report: Json = {
    runId,
    status: 'in-progress',
    evidence: 'caller-supplied-mcp-client',
    appId: fixture.appId,
    spaceId: fixture.spaceId,
    plannedChildIds: ids,
    steps,
    checks,
    startedAt: new Date().toISOString(),
  };
  const persist = async () => {
    if (Buffer.byteLength(JSON.stringify(report)) > 128_000) fail('REPORT_SIZE_BOUND_EXCEEDED');
    await options.persist?.(structuredClone(report));
  };
  const started = Date.now();
  let calls = 0;
  const call = async (name: string, input: Json): Promise<Json> => {
    if (++calls > 180 || Date.now() - started > 20 * 60 * 1000)
      fail('LIFECYCLE_CALL_BUDGET_EXCEEDED');
    const result = object(await client.call(name, input));
    if (Buffer.byteLength(JSON.stringify(result)) > 1_000_000) fail('TOOL_RESPONSE_TOO_LARGE');
    return result;
  };
  const read = (action: string, input: Json = {}) =>
    call('qlik_management_read', {
      action,
      input: { connection: fixture.connection, appId: fixture.appId, ...input },
    });
  const assertFixture = async () => {
    const app = await read('app.get');
    if (
      app.appId !== fixture.appId ||
      app.spaceId !== fixture.spaceId ||
      app.name !== fixture.appName
    )
      fail('FIXTURE_APP_READBACK_MISMATCH');
  };
  const execute = async (action: string, input: Json, identity: Json): Promise<Json> => {
    const workflowSteps: Step[] = [
      { action, input: { connection: fixture.connection, appId: fixture.appId, ...input } },
    ];
    const planned = await call('qlik_management_plan', { steps: workflowSteps });
    const planId = identifier(planned.planId);
    const entry: Json = { action, planId, status: planned.status, target: identity };
    steps.push(entry);
    await persist();
    if (planned.status === 'awaiting-approval') {
      if (!options.approve) fail('SEPARATE_REVIEWER_APPROVAL_REQUIRED');
      await options.approve({ planId, steps: workflowSteps });
    } else if (planned.status !== 'approved') fail('PLAN_NOT_APPROVED');
    // Exactly one execution request. Recovery only reads the existing attempt.
    let result: Json;
    try {
      result = await call('qlik_management_execute', { planId, steps: workflowSteps });
    } catch (error) {
      entry.executionErrorCode = errorCode(error);
      result = { status: 'response-lost' };
    }
    entry.status = result.status;
    let observed: Json | undefined;
    if (result.status === 'completed') {
      if (!Array.isArray(result.steps) || result.steps.length !== 1)
        fail('WORKFLOW_RECEIPT_MISSING');
      observed = object(result.steps[0]);
    } else {
      if (result.acknowledged) entry.receipt = receipt(object(result.acknowledged));
      await persist();
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await (options.sleep ?? delay)(1_000);
        const recovered = await call('qlik_management_reconcile', {
          planId,
          steps: workflowSteps,
          index: 0,
        });
        if (recovered.status === 'completed') {
          observed = object(recovered.result);
          entry.reconciled = true;
          break;
        }
      }
    }
    if (!observed) fail('WORKFLOW_REQUIRES_RECONCILIATION');
    entry.receipt = receipt(observed);
    if (
      observed.verified !== true ||
      Object.entries(identity).some(([key, value]) => observed![key] !== value)
    )
      fail('WORKFLOW_RECEIPT_MISMATCH');
    entry.status = 'completed';
    await persist();
    return observed;
  };
  const sheet = async (sheetId = ids.sheetId) => {
    const observed = await read('sheet.get', { sheetId });
    if (observed.sheetId !== sheetId || !Array.isArray(observed.cells))
      fail('SHEET_READBACK_MISMATCH');
    hash(observed.expectedHash);
    return observed;
  };
  const chart = async (objectId: string, sheetId = ids.sheetId) => {
    const observed = await read('chart.get', { sheetId, objectId });
    if (
      observed.sheetId !== sheetId ||
      observed.objectId !== objectId ||
      observed.ownership !== 'sheet-child'
    )
      fail('CHART_OWNERSHIP_MISMATCH');
    hash(observed.expectedHash);
    hash(observed.expectedSheetHash);
    return observed;
  };
  const absent = async (action: string, input: Json) => {
    try {
      await read(action, input);
    } catch (error) {
      if (errorCode(error) === 'NOT_FOUND') return;
      throw error;
    }
    fail('DELETED_RESOURCE_STILL_EXISTS');
  };
  const assertTotals = async (objectId: string, north: number, sheetId = ids.sheetId) => {
    const exported = await read('chart.export', { sheetId, objectId, offset: 0, limit: 10 });
    if (!Array.isArray(exported.rows) || exported.rows.length !== 2) fail('CHART_VALUES_MISMATCH');
    const totals = new Map(
      exported.rows.map((row) => {
        if (!Array.isArray(row) || row.length !== 2) fail('CHART_VALUES_MISMATCH');
        return [object(row[0]).text, object(row[1]).number];
      }),
    );
    if (totals.size !== 2 || totals.get('North') !== north || totals.get('South') !== 50)
      fail('CHART_VALUES_MISMATCH');
  };
  const intent = (measure: string, title: string) => ({
    analysis: { dimensions: ['Category'], measures: [measure] },
    presentation: { preferredChartType: 'table', title, sort: 'dimension-ascending' },
    mode: 'apply',
  });

  await persist();
  try {
    const catalog = await call('qlik_management_catalog', {});
    const available = new Set(
      (Array.isArray(catalog.actions) ? catalog.actions : []).map((item) => object(item).action),
    );
    if (actions.some((action) => !available.has(action))) fail('LIFECYCLE_ACTION_MISSING');
    await assertFixture();
    const model = await read('model.inspect', { limit: 10 });
    if (
      !Array.isArray(model.tables) ||
      !model.tables.some((item) => {
        const table = object(item);
        return table.name === 'AcceptanceData' && table.rowCount === 3;
      })
    )
      fail('FIXTURE_MODEL_MISMATCH');
    const preview = await read('table.preview', {
      tableName: 'AcceptanceData',
      offset: 0,
      limit: 4,
    });
    if (
      preview.totalRows !== 3 ||
      !Array.isArray(preview.columns) ||
      preview.columns.length !== 2 ||
      !preview.columns.includes('Category') ||
      !preview.columns.includes('Amount') ||
      !Array.isArray(preview.rows) ||
      preview.rows.length !== 3
    )
      fail('FIXTURE_ROWS_MISMATCH');
    const categoryIndex = preview.columns.indexOf('Category');
    const amountIndex = preview.columns.indexOf('Amount');
    const actualRows = preview.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== 2) fail('FIXTURE_ROWS_MISMATCH');
      const amount = tableValue(row[amountIndex]);
      if (!['string', 'number'].includes(typeof amount)) fail('FIXTURE_ROWS_MISMATCH');
      return JSON.stringify([tableValue(row[categoryIndex]), Number(amount)]);
    });
    const expectedRows = [
      ['North', 100],
      ['South', 50],
      ['North', 25],
    ].map((row) => JSON.stringify(row));
    if (JSON.stringify(actualRows.sort()) !== JSON.stringify(expectedRows.sort()))
      fail('FIXTURE_ROWS_MISMATCH');
    checks.push('exact-owned-app-and-three-synthetic-rows');

    for (const kind of ['dimension', 'measure'] as const) {
      const itemId = kind === 'dimension' ? ids.dimensionId : ids.measureId;
      await execute(
        'master.create',
        {
          kind,
          itemId,
          title: `Lifecycle ${kind}`,
          ...(kind === 'dimension' ? { fields: ['Category'] } : { expression: 'Sum([Amount])' }),
        },
        { itemId, kind },
      );
      const initial = await read('master.get', { itemId, kind });
      if (initial.itemId !== itemId || initial.kind !== kind) fail('MASTER_READBACK_MISMATCH');
      await execute(
        'master.update',
        {
          kind,
          itemId,
          expectedHash: hash(initial.expectedHash),
          title: `Lifecycle ${kind} updated`,
          ...(kind === 'dimension' ? { fields: ['Amount'] } : { expression: 'Avg([Amount])' }),
        },
        { itemId, kind },
      );
      const updated = await read('master.get', { itemId, kind });
      const properties = object(updated.properties);
      if (
        updated.itemId !== itemId ||
        updated.kind !== kind ||
        object(properties.qMetaDef).title !== `Lifecycle ${kind} updated` ||
        (kind === 'dimension'
          ? JSON.stringify(object(properties.qDim).qFieldDefs) !== JSON.stringify(['Amount'])
          : object(properties.qMeasure).qDef !== 'Avg([Amount])')
      )
        fail('MASTER_READBACK_MISMATCH');
      checks.push(`master-${kind}-created-and-edited`);
    }

    await execute(
      'sheet.create',
      { sheetId: ids.sheetId, title: 'Lifecycle dashboard' },
      { sheetId: ids.sheetId },
    );
    const initialSheet = await sheet();
    if ((initialSheet.cells as unknown[]).length !== 0) fail('NEW_SHEET_NOT_EMPTY');
    await execute(
      'chart.create',
      {
        sheetId: ids.sheetId,
        objectId: ids.objectId,
        expectedSheetHash: hash(initialSheet.expectedHash),
        placement: { col: 0, row: 0, colspan: 12, rowspan: 6 },
        intent: intent('Sum(Amount)', 'Lifecycle totals'),
      },
      { objectId: ids.objectId },
    );
    await assertTotals(ids.objectId, 125);
    const originalChart = await chart(ids.objectId);
    await execute(
      'chart.update',
      {
        sheetId: ids.sheetId,
        objectId: ids.objectId,
        expectedHash: hash(originalChart.expectedHash),
        intent: intent('Avg(Amount)', 'Lifecycle averages'),
      },
      { objectId: ids.objectId },
    );
    const updatedChart = await chart(ids.objectId);
    if (updatedChart.title !== 'Lifecycle averages') fail('CHART_TITLE_MISMATCH');
    await assertTotals(ids.objectId, 62.5);
    checks.push('chart-binding-edit-and-exact-sum-average-values');

    await execute(
      'filter.create',
      {
        sheetId: ids.sheetId,
        objectId: ids.filterId,
        expectedSheetHash: hash((await sheet()).expectedHash),
        title: 'Lifecycle category filter',
        fields: ['Category'],
        placement: { col: 12, row: 0, colspan: 12, rowspan: 6 },
      },
      { objectId: ids.filterId },
    );
    if ((await chart(ids.filterId)).type !== 'filterpane') fail('FILTER_READBACK_MISMATCH');
    await execute(
      'sheet.update',
      {
        sheetId: ids.sheetId,
        expectedHash: hash((await sheet()).expectedHash),
        title: 'Lifecycle dashboard updated',
        description: 'Synthetic lifecycle acceptance only.',
        cells: [
          { objectId: ids.objectId, col: 12, row: 0, colspan: 12, rowspan: 6 },
          { objectId: ids.filterId, col: 0, row: 0, colspan: 12, rowspan: 6 },
        ],
      },
      { sheetId: ids.sheetId },
    );
    const moved = await sheet();
    if (
      moved.title !== 'Lifecycle dashboard updated' ||
      (moved.cells as unknown[]).length !== 2 ||
      !(moved.cells as unknown[]).some(
        (cell) => object(cell).objectId === ids.objectId && object(cell).col === 12,
      ) ||
      !(moved.cells as unknown[]).some(
        (cell) => object(cell).objectId === ids.filterId && object(cell).col === 0,
      )
    )
      fail('SHEET_LAYOUT_MISMATCH');
    await execute(
      'chart.reorder',
      {
        sheetId: ids.sheetId,
        expectedHash: hash(moved.expectedHash),
        objectIds: [ids.filterId, ids.objectId],
      },
      { sheetId: ids.sheetId },
    );
    const ordered = await sheet();
    if (
      JSON.stringify((ordered.cells as unknown[]).map((cell) => object(cell).objectId)) !==
      JSON.stringify([ids.filterId, ids.objectId])
    )
      fail('CHART_ORDER_MISMATCH');
    checks.push('native-filter-sheet-title-placement-and-order');

    await execute(
      'sheet.duplicate',
      {
        sheetId: ids.sheetId,
        newSheetId: ids.copySheetId,
        title: 'Lifecycle duplicate',
        expectedHash: hash(ordered.expectedHash),
      },
      { sheetId: ids.copySheetId },
    );
    const copied = await sheet(ids.copySheetId);
    const copiedCells = (copied.cells as unknown[]).map(object);
    if (
      copied.title !== 'Lifecycle duplicate' ||
      copiedCells.length !== 2 ||
      copiedCells.some(
        (cell) =>
          cell.ownership !== 'sheet-child' ||
          !identifier(cell.objectId).startsWith(`${ids.copySheetId}-`),
      ) ||
      new Set(copiedCells.map((cell) => cell.objectId)).size !== 2
    )
      fail('DUPLICATE_OWNERSHIP_MISMATCH');
    const copiedChart = copiedCells.find((cell) => cell.type === updatedChart.type);
    if (!copiedChart || !copiedCells.some((cell) => cell.type === 'filterpane'))
      fail('DUPLICATE_CONTENT_MISMATCH');
    report.duplicateChildIds = copiedCells.map((cell) => cell.objectId);
    await assertTotals(identifier(copiedChart.objectId), 62.5, ids.copySheetId);
    checks.push('sheet-duplicate-owned-tree-and-exact-values');

    // Delete only this invocation's verified child resources. No cleanup follows a failed step.
    await assertFixture();
    await execute(
      'sheet.delete',
      { sheetId: ids.copySheetId, expectedHash: hash((await sheet(ids.copySheetId)).expectedHash) },
      { sheetId: ids.copySheetId, deleted: true },
    );
    await absent('sheet.get', { sheetId: ids.copySheetId });
    for (const objectId of [ids.filterId, ids.objectId]) {
      const current = await chart(objectId);
      await execute(
        'chart.delete',
        {
          sheetId: ids.sheetId,
          objectId,
          expectedHash: hash(current.expectedHash),
          expectedSheetHash: hash(current.expectedSheetHash),
        },
        { objectId, deleted: true, objectDeleted: true },
      );
      await absent('chart.get', { sheetId: ids.sheetId, objectId });
    }
    const empty = await sheet();
    if ((empty.cells as unknown[]).length !== 0) fail('SHEET_NOT_EMPTY_AFTER_CHILD_DELETION');
    await execute(
      'sheet.delete',
      { sheetId: ids.sheetId, expectedHash: hash(empty.expectedHash) },
      { sheetId: ids.sheetId, deleted: true },
    );
    await absent('sheet.get', { sheetId: ids.sheetId });
    for (const kind of ['dimension', 'measure'] as const) {
      const itemId = kind === 'dimension' ? ids.dimensionId : ids.measureId;
      const current = await read('master.get', { kind, itemId });
      await execute(
        'master.delete',
        { kind, itemId, expectedHash: hash(current.expectedHash) },
        { kind, itemId, deleted: true },
      );
      await absent('master.get', { kind, itemId });
    }
    checks.push('exact-created-children-deleted-and-independently-absent');
    await assertFixture();
    checks.push('original-fixture-app-retained');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed-or-pending';
    report.errorCode = errorCode(error);
    report.retainedChildrenMayExist = true;
  } finally {
    report.callCount = calls;
    report.finishedAt = new Date().toISOString();
    await persist();
  }
  return report;
}
