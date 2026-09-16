import { randomUUID } from 'node:crypto';
import type { HostConfig } from '@qlik/api/auth';
import {
  openAppSession,
  type Doc,
  type GenericObject,
  type GenericObjectEntry,
} from '@qlik/api/qix';
import { z } from 'zod';
import { compileChartIntent } from '../compiler/compiler.js';
import { chartIntentSchema } from '../compiler/chartIntentSchema.js';
import { VISUALIZATION_REGISTRY } from '../compiler/chartTypeRegistry.js';
import { resolveCatalogFieldLabel } from '../catalog/resolver.js';
import type { CatalogDefinition } from '../catalog/catalogTypes.js';
import { computePlanHash } from '../domain/ids.js';
import { createError, HarnessError, isHarnessError } from '../domain/errors.js';
import {
  assertSheetPlacement,
  containsProperties,
  MAX_SHEET_OBJECTS,
  NATIVE_SHEET_LAYOUT,
  placementsOverlap,
  sheetCellBounds,
} from '../adapters/sheetLayout.js';
import type { SheetPlacement } from '../adapters/targetAdapter.js';

const id = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const title = z.string().trim().min(1).max(200);
const description = z.string().max(2_000);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const base = { connection: z.string().trim().min(1).max(100), appId: id };
const sheet = { ...base, sheetId: id };
const chart = { ...sheet, objectId: id };
const kind = z.enum(['dimension', 'measure']);
const master = { ...base, kind, itemId: id };
const definition = {
  title,
  description: description.optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  fields: z.array(z.string().trim().min(1).max(200)).min(1).max(6).optional(),
  expression: z.string().trim().min(1).max(10_000).optional(),
};
const paging = {
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
};
const placement = z
  .object({
    col: z.number().int().min(0).max(23),
    row: z.number().int().min(0).max(999),
    colspan: z.number().int().min(1).max(24),
    rowspan: z.number().int().min(1).max(1_000),
  })
  .strict();

/** Narrow, explicit management requests. There is deliberately no raw QIX dispatch or property-tree input. */
export const ENGINE_ACTION_SCHEMAS = {
  'script.get': z.object(base).strict(),
  'script.set': z
    .object({ ...base, expectedHash: hash, script: z.string().max(1_000_000) })
    .strict(),
  'model.inspect': z
    .object({ ...base, limit: z.number().int().min(1).max(100).default(50) })
    .strict(),
  'table.preview': z.object({ ...base, tableName: title, ...paging }).strict(),
  'expression.validate': z
    .object({ ...base, expression: z.string().trim().min(1).max(10_000) })
    .strict(),
  'sheet.get': z.object(sheet).strict(),
  'sheet.create': z.object({ ...sheet, title, description: description.optional() }).strict(),
  'sheet.update': z
    .object({
      ...sheet,
      expectedHash: hash,
      title: title.optional(),
      description: description.optional(),
      cells: z
        .array(placement.extend({ objectId: id }).strict())
        .max(MAX_SHEET_OBJECTS)
        .optional(),
    })
    .strict()
    .refine(
      (v) => v.title !== undefined || v.description !== undefined || v.cells !== undefined,
      'At least one edit is required.',
    ),
  'sheet.delete': z.object({ ...sheet, expectedHash: hash }).strict(),
  'sheet.publish': z.object({ ...sheet, expectedHash: hash }).strict(),
  'sheet.unpublish': z.object({ ...sheet, expectedHash: hash }).strict(),
  'sheet.duplicate': z.object({ ...sheet, newSheetId: id, title, expectedHash: hash }).strict(),
  'chart.get': z.object(chart).strict(),
  'chart.create': z
    .object({ ...chart, expectedSheetHash: hash, intent: chartIntentSchema, placement })
    .strict(),
  'chart.update': z
    .object({
      ...chart,
      expectedHash: hash,
      title: title.optional(),
      subtitle: description.optional(),
      footnote: description.optional(),
      showTitles: z.boolean().optional(),
      intent: chartIntentSchema.optional(),
    })
    .strict()
    .refine(
      (v) =>
        ['title', 'subtitle', 'footnote', 'showTitles', 'intent'].some((key) =>
          Object.hasOwn(v, key),
        ),
      'At least one edit is required.',
    ),
  'chart.delete': z.object({ ...chart, expectedHash: hash, expectedSheetHash: hash }).strict(),
  'chart.reorder': z
    .object({ ...sheet, expectedHash: hash, objectIds: z.array(id).max(MAX_SHEET_OBJECTS) })
    .strict(),
  'chart.export': z.object({ ...chart, ...paging }).strict(),
  'filter.create': z
    .object({
      ...chart,
      expectedSheetHash: hash,
      title,
      fields: z.array(title).min(1).max(6),
      placement,
    })
    .strict(),
  'master.list': z.object({ ...base, kind: kind.optional(), ...paging }).strict(),
  'master.get': z.object(master).strict(),
  'master.create': z.object({ ...master, ...definition }).strict(),
  'master.update': z.object({ ...master, ...definition, expectedHash: hash }).strict(),
  'master.delete': z.object({ ...master, expectedHash: hash }).strict(),
} as const;

export type EngineManagementAction = keyof typeof ENGINE_ACTION_SCHEMAS;
export const ENGINE_MUTATION_ACTIONS: ReadonlySet<string> = new Set([
  'script.set',
  'sheet.create',
  'sheet.update',
  'sheet.delete',
  'sheet.publish',
  'sheet.unpublish',
  'sheet.duplicate',
  'chart.create',
  'chart.update',
  'chart.delete',
  'chart.reorder',
  'filter.create',
  'master.create',
  'master.update',
  'master.delete',
]);
export type EngineManagementDoc = Pick<
  Doc,
  | 'getScript'
  | 'setScript'
  | 'getTablesAndKeys'
  | 'getTableData'
  | 'checkExpression'
  | 'getObject'
  | 'createObject'
  | 'destroyObject'
  | 'getAllInfos'
  | 'getDimensionList'
  | 'getMeasureList'
  | 'getDimension'
  | 'getMeasure'
  | 'createDimension'
  | 'createMeasure'
  | 'destroyDimension'
  | 'destroyMeasure'
  | 'doSave'
>;
export interface EngineManagementSession {
  getDoc(): Promise<EngineManagementDoc>;
  close(): Promise<unknown>;
}
export type EngineManagementSessionFactory = (options: {
  hostConfig: HostConfig;
  appId: string;
  identity: string;
}) => EngineManagementSession;
export interface CloudEngineManagementOptions {
  readonly getCatalog?: (connection: string, appId: string) => Promise<CatalogDefinition>;
  readonly timeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

type Input = Record<string, unknown> & { connection: string; appId: string };
type Properties = Record<string, unknown>;
type ObjectPropertiesInput = Parameters<GenericObject['setProperties']>[0];
type SheetCell = SheetPlacement & { name: string; type: string; bounds?: unknown };
const SUPPORTED_CHART_TYPES = new Set([
  ...Object.values(VISUALIZATION_REGISTRY).map(
    (v) => v.profiles['qlik-cloud-current'].qlikInAppVisualizationId,
  ),
  'table',
  'filterpane',
]);

function record(value: unknown): Properties {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw createError('MALFORMED_REQUEST', {
      message: 'Qlik returned an invalid management response.',
    });
  return value as Properties;
}
function propertiesHash(value: unknown): string {
  return computePlanHash(value);
}
function precondition(properties: unknown, expected: unknown): void {
  if (propertiesHash(properties) !== expected)
    throw createError('IDEMPOTENCY_CONFLICT', {
      message: 'The Qlik resource changed. Read it again before applying this edit.',
    });
}
function semantic(properties: Properties, objectId: string, objectType: string): void {
  const info = record(properties.qInfo);
  if (info.qId !== objectId || info.qType !== objectType)
    throw createError('MALFORMED_REQUEST', {
      message: 'The Qlik resource does not have the requested identifier and semantic type.',
    });
}
function boundedJson(value: unknown, maximum = 1_000_000): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum)
    throw createError('CAPACITY_EXHAUSTED', {
      message: 'The Qlik resource exceeds the bounded management response size.',
    });
}
function uncertain(): ReturnType<typeof createError> {
  return createError('IDEMPOTENCY_CONFLICT', {
    message:
      'The Qlik management write or session close could not be confirmed. Read the resource and reconcile before retrying.',
    details: { outcome: 'uncertain' },
  });
}
function cellsOf(properties: Properties): SheetCell[] {
  const cells = properties.cells ?? [];
  if (!Array.isArray(cells) || cells.length > MAX_SHEET_OBJECTS)
    throw createError('MALFORMED_REQUEST', {
      message: 'The sheet has an unsupported cell collection.',
    });
  const result = cells.map((value) => {
    const cell = record(value);
    if (typeof cell.name !== 'string' || typeof cell.type !== 'string')
      throw createError('MALFORMED_REQUEST');
    assertSheetPlacement(cell as unknown as SheetPlacement);
    return cell as unknown as SheetCell;
  });
  if (new Set(result.map((cell) => cell.name)).size !== result.length)
    throw createError('MALFORMED_REQUEST', {
      message: 'The sheet contains duplicate chart identifiers.',
    });
  return result;
}
function validateCells(cells: SheetCell[], properties: Properties): void {
  const columns = Number(properties.columns ?? 24);
  const rows = Number(properties.rows ?? 12);
  if (
    !Number.isSafeInteger(columns) ||
    columns < 1 ||
    columns > 24 ||
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > 1_000
  )
    throw createError('MALFORMED_REQUEST');
  for (const [index, cell] of cells.entries()) {
    assertSheetPlacement(cell);
    if (
      cell.col + cell.colspan > columns ||
      cell.row + cell.rowspan > rows ||
      cells.slice(index + 1).some((other) => placementsOverlap(cell, other))
    )
      throw createError('MALFORMED_REQUEST', {
        message: 'Chart placements overlap or exceed the sheet grid.',
      });
  }
}
function sameMembers(actual: readonly string[], requested: readonly string[]): boolean {
  return (
    new Set(requested).size === requested.length &&
    actual.length === requested.length &&
    actual.every((value) => requested.includes(value))
  );
}

function derivedObjectId(parentId: string, suffix: string): string {
  const candidate = `${parentId}-${suffix}`;
  return candidate.length <= 200
    ? candidate
    : `${parentId.slice(0, 150)}-${computePlanHash(candidate).slice(7, 39)}`;
}

/** One isolated SDK session per operation. Hash checks are optimistic; QIX has no atomic compare-and-set. */
export class CloudEngineManagementProvider {
  constructor(
    private readonly getHostConfig: (connection: string) => Promise<HostConfig>,
    private readonly openSession: EngineManagementSessionFactory = openAppSession,
    private readonly options: CloudEngineManagementOptions = {},
  ) {}

  async execute(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!Object.hasOwn(ENGINE_ACTION_SCHEMAS, action)) throw createError('MALFORMED_REQUEST');
    const parsed = ENGINE_ACTION_SCHEMAS[action as EngineManagementAction].safeParse(input);
    if (!parsed.success)
      throw createError('MALFORMED_REQUEST', {
        message: 'The Engine management request does not match its strict action schema.',
      });
    const request = parsed.data as Input;
    return this.withSession(
      request,
      (doc, write) => this.dispatch(doc, action as EngineManagementAction, request, write),
      ENGINE_MUTATION_ACTIONS.has(action),
    );
  }

  /** Independently verifies a receipt using reads only. A false result never authorizes replay. */
  async verify(
    action: string,
    input: Record<string, unknown>,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    if (!Object.hasOwn(ENGINE_ACTION_SCHEMAS, action) || !ENGINE_MUTATION_ACTIONS.has(action))
      return false;
    const parsed = ENGINE_ACTION_SCHEMAS[action as EngineManagementAction].safeParse(input);
    if (!parsed.success) return false;
    const request = parsed.data as Input;
    try {
      const checked = await this.withSession(request, async (doc) => ({
        verified: await new EngineManagementAttempt(
          doc,
          request,
          async () => {
            throw createError('PERMISSION_DENIED');
          },
          this.options.getCatalog,
        ).verify(action as EngineManagementAction, result),
      }));
      return checked.verified === true;
    } catch {
      return false;
    }
  }

  private async withSession(
    request: Input,
    operation: (
      doc: EngineManagementDoc,
      write: <T>(operation: () => Promise<T>) => Promise<T>,
    ) => Promise<Properties>,
    mutation = false,
  ): Promise<Properties> {
    let session: EngineManagementSession;
    try {
      session = this.openSession({
        hostConfig: await this.getHostConfig(request.connection),
        appId: request.appId,
        identity: `management-${randomUUID()}`,
      });
    } catch {
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'The Qlik Engine management session could not be opened.',
      });
    }
    let active = true;
    let dispatched = false;
    let closing: Promise<unknown> | undefined;
    const close = () => (closing ??= Promise.resolve().then(() => session.close()));
    const write = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (!active) throw uncertain();
      dispatched = true;
      return operation();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: { ok: true; value: Properties } | { ok: false; error: unknown };
    try {
      const attempt = session.getDoc().then((doc) => operation(doc, write));
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            active = false;
            void close().catch(() => undefined);
            reject(dispatched ? uncertain() : createError('TRANSIENT_UNAVAILABLE'));
          },
          Math.max(1, Math.min(this.options.timeoutMs ?? 120_000, 120_000)),
        );
      });
      outcome = { ok: true, value: await Promise.race([attempt, timeout]) };
    } catch (error) {
      outcome = {
        ok: false,
        error: dispatched
          ? uncertain()
          : isHarnessError(error)
            ? error
            : createError('TRANSIENT_UNAVAILABLE', {
                message:
                  'The Qlik Engine management request failed. No provider error content is included.',
              }),
      };
    } finally {
      active = false;
      clearTimeout(timer);
    }
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        close(),
        new Promise<never>((_resolve, reject) => {
          closeTimer = setTimeout(
            () => reject(uncertain()),
            Math.max(1, Math.min(this.options.closeTimeoutMs ?? 2_000, 2_000)),
          );
        }),
      ]);
    } catch {
      throw uncertain();
    } finally {
      clearTimeout(closeTimer);
    }
    if (!outcome.ok) {
      // The write gate is closed and the session has closed successfully. This proof is
      // stronger than an error code or a later readback, neither of which proves no write.
      if (mutation && !dispatched && isHarnessError(outcome.error))
        throw new HarnessError({
          ...outcome.error.toEnvelope(),
          details: {
            ...outcome.error.details,
            outcome: 'rejected',
            dispatch: 'not-started',
          },
        });
      throw outcome.error;
    }
    return outcome.value;
  }

  private async dispatch(
    doc: EngineManagementDoc,
    action: EngineManagementAction,
    input: Input,
    write: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<Properties> {
    return new EngineManagementAttempt(doc, input, write, this.options.getCatalog).run(action);
  }
}

class EngineManagementAttempt {
  constructor(
    private readonly doc: EngineManagementDoc,
    private readonly input: Input,
    private readonly write: <T>(operation: () => Promise<T>) => Promise<T>,
    private readonly getCatalog: CloudEngineManagementOptions['getCatalog'],
  ) {}

  async run(action: EngineManagementAction): Promise<Properties> {
    if (action.startsWith('script.')) return this.script(action);
    if (action === 'model.inspect' || action === 'table.preview') return this.model(action);
    if (action === 'expression.validate') return this.expression(String(this.input.expression));
    if (action.startsWith('master.')) return this.master(action);
    if (action.startsWith('sheet.')) return this.sheet(action);
    return this.chart(action);
  }

  async verify(action: EngineManagementAction, result: Properties): Promise<boolean> {
    const input = this.input;
    for (const key of ['appId', 'objectId', 'itemId'] as const) {
      if (result[key] !== undefined && result[key] !== input[key]) return false;
    }
    if (action === 'script.set') return (await this.doc.getScript()) === input.script;
    if (action === 'sheet.delete' || action === 'master.delete') {
      const targetId = action === 'sheet.delete' ? input.sheetId : input.itemId;
      return !(await this.doc.getAllInfos()).some((info) => info.qId === targetId);
    }
    if (action === 'master.create' || action === 'master.update') {
      const current = await this.master('master.get');
      if (action === 'master.update' && typeof result.expectedHash !== 'string') return false;
      if (result.expectedHash !== undefined && current.expectedHash !== result.expectedHash)
        return false;
      return containsProperties(current.properties, await this.masterProperties());
    }
    if (action === 'sheet.duplicate') return this.verifyDuplicate(result);
    const state = await this.sheetState();
    if (result.sheetId !== undefined && result.sheetId !== input.sheetId) return false;
    if (action === 'sheet.publish' || action === 'sheet.unpublish') {
      const published = action === 'sheet.publish';
      if (result.published !== undefined && result.published !== published) return false;
      return (
        state.expectedHash === (result.expectedHash ?? input.expectedHash) &&
        (await this.sheetVisibility(state.object)).published === published
      );
    }
    if (action === 'sheet.create') {
      return (
        containsProperties(state.properties, {
          ...NATIVE_SHEET_LAYOUT,
          qInfo: { qId: input.sheetId, qType: 'sheet' },
          qMetaDef: { title: input.title, description: input.description ?? '', tags: [] },
          cells: [],
        }) &&
        (result.expectedHash === undefined || state.expectedHash === result.expectedHash)
      );
    }
    if (action === 'sheet.update') {
      if (typeof result.expectedHash !== 'string' || state.expectedHash !== result.expectedHash)
        return false;
      const metadata = record(state.properties.qMetaDef ?? {});
      if (
        (input.title !== undefined && metadata.title !== input.title) ||
        (input.description !== undefined && metadata.description !== input.description)
      )
        return false;
      if (Array.isArray(input.cells))
        return (
          input.cells.length === state.cells.length &&
          input.cells.every((value) => {
            const requested = record(value);
            const cell = state.cells.find((cell) => cell.name === requested.objectId);
            return (
              Boolean(cell) &&
              ['col', 'row', 'colspan', 'rowspan'].every(
                (key) => record(cell)[key] === requested[key],
              )
            );
          })
        );
      return true;
    }
    if (action === 'chart.reorder') {
      const requested = input.objectIds as string[];
      return (
        state.cells.length === requested.length &&
        state.cells.every((cell, index) => cell.name === requested[index]) &&
        containsProperties(
          state.ownedChildIds,
          requested.filter((id) => state.ownedChildIds.includes(id)),
        ) &&
        (result.expectedHash === undefined || state.expectedHash === result.expectedHash)
      );
    }
    if (action === 'chart.delete') {
      if (state.cells.some((cell) => cell.name === input.objectId)) return false;
      const exists = (await this.doc.getAllInfos()).some((info) => info.qId === input.objectId);
      return result.objectDeleted === true
        ? !exists
        : result.objectDeleted === false
          ? exists
          : true;
    }
    const chart = await this.chartState(state);
    if (
      (result.expectedHash !== undefined &&
        propertiesHash(chart.properties) !== result.expectedHash) ||
      (result.expectedSheetHash !== undefined && state.expectedHash !== result.expectedSheetHash)
    )
      return false;
    if (action === 'chart.create') {
      const intended = await this.compiled();
      if (
        !containsProperties(
          state.cells.find((cell) => cell.name === input.objectId),
          input.placement,
        )
      )
        return false;
      await this.verifyChart(chart.object, intended);
      return true;
    }
    if (action === 'filter.create') {
      if (
        chart.type !== 'filterpane' ||
        chart.properties.title !== input.title ||
        !containsProperties(
          state.cells.find((cell) => cell.name === input.objectId),
          input.placement,
        )
      )
        return false;
      const catalog = await this.catalog();
      const fields = (input.fields as string[]).map(
        (field) => resolveCatalogFieldLabel(catalog, field).label,
      );
      const children = await chart.object.getChildInfos();
      if (children.length !== fields.length) return false;
      for (const [index, field] of fields.entries()) {
        const childId = derivedObjectId(String(input.objectId), `field-${index + 1}`);
        if (children[index]?.qId !== childId || children[index]?.qType !== 'listbox') return false;
        const properties = await (await this.doc.getObject(childId)).getProperties();
        if (
          !containsProperties(properties, {
            qInfo: { qId: childId, qType: 'listbox' },
            qListObjectDef: { qDef: { qFieldDefs: [field] } },
          })
        )
          return false;
      }
      await this.verifyChart(chart.object, chart.properties);
      return true;
    }
    if (action === 'chart.update') {
      if (typeof result.expectedHash !== 'string') return false;
      let intended: Properties = input.intent === undefined ? {} : await this.compiled();
      intended = {
        ...intended,
        ...Object.fromEntries(
          ['title', 'subtitle', 'footnote', 'showTitles']
            .filter((key) => input[key] !== undefined)
            .map((key) => [key, input[key]]),
        ),
      };
      if (!containsProperties(chart.properties, intended)) return false;
      await this.verifyChart(chart.object, chart.properties);
      return true;
    }
    return false;
  }

  private async verifyDuplicate(result: Properties): Promise<boolean> {
    if (result.sheetId !== undefined && result.sheetId !== this.input.newSheetId) return false;
    if (typeof result.expectedHash !== 'string') return false;
    const source = await this.sheetState();
    if (source.expectedHash !== this.input.expectedHash) return false;
    const destination = await this.sheetState(String(this.input.newSheetId));
    if (destination.expectedHash !== result.expectedHash) return false;
    const compare = (
      before: GenericObjectEntry,
      after: GenericObjectEntry,
      depth: number,
    ): boolean => {
      if (depth > 3 || before.qEmbeddedSnapshotRef || after.qEmbeddedSnapshotRef) return false;
      const original = record(before.qProperty);
      const actual = record(after.qProperty);
      const originalInfo = record(original.qInfo);
      const nextId =
        depth === 0
          ? String(this.input.newSheetId)
          : derivedObjectId(
              String(this.input.newSheetId),
              computePlanHash(originalInfo.qId).slice(7, 23),
            );
      const { qlikAIHarness: _marker, ...properties } = original;
      const expected = {
        ...properties,
        qInfo: { ...originalInfo, qId: nextId },
        ...(depth === 0
          ? {
              qMetaDef: { ...record(original.qMetaDef ?? {}), title: this.input.title },
              cells: (original.cells as Properties[]).map((cell) => ({
                ...cell,
                name: derivedObjectId(
                  String(this.input.newSheetId),
                  computePlanHash(cell.name).slice(7, 23),
                ),
              })),
            }
          : {}),
      };
      if (
        !containsProperties(actual, expected) ||
        (before.qChildren ?? []).length !== (after.qChildren ?? []).length
      )
        return false;
      return (before.qChildren ?? []).every((child, index) =>
        compare(child, after.qChildren![index]!, depth + 1),
      );
    };
    return compare(source.tree, destination.tree, 0);
  }

  private async catalog(): Promise<CatalogDefinition> {
    if (!this.getCatalog)
      throw createError('NOT_CONFIGURED', {
        message: 'A policy-visible catalog reader is required for chart and field management.',
      });
    return this.getCatalog(this.input.connection, this.input.appId);
  }

  private async save(): Promise<void> {
    await this.write(() => this.doc.doSave());
  }

  private async script(action: string): Promise<Properties> {
    const before = await this.doc.getScript();
    boundedJson(before, 1_000_010);
    if (action === 'script.get') return { script: before, expectedHash: propertiesHash(before) };
    precondition(before, this.input.expectedHash);
    const next = String(this.input.script);
    await this.write(() => this.doc.setScript(next));
    await this.save();
    const actual = await this.doc.getScript();
    if (actual !== next) throw uncertain();
    return {
      saved: true,
      verified: true,
      expectedHash: propertiesHash(actual),
      scriptBytes: Buffer.byteLength(actual, 'utf8'),
    };
  }

  private async expression(expression: string): Promise<Properties> {
    const checked = record(await this.doc.checkExpression(expression, [], true));
    if (
      typeof checked.qErrorMsg !== 'string' ||
      (checked.qBadFieldNames !== undefined && !Array.isArray(checked.qBadFieldNames)) ||
      (checked.qDangerousFieldNames !== undefined && !Array.isArray(checked.qDangerousFieldNames))
    )
      throw createError('MALFORMED_REQUEST', {
        message: 'Qlik returned an invalid expression-validation result.',
      });
    const badFields = Array.isArray(checked.qBadFieldNames) ? checked.qBadFieldNames.length : 0;
    const dangerousFields = Array.isArray(checked.qDangerousFieldNames)
      ? checked.qDangerousFieldNames.length
      : 0;
    return {
      valid: checked.qErrorMsg.length === 0 && badFields === 0 && dangerousFields === 0,
      hasSyntaxError: checked.qErrorMsg.length > 0,
      unknownFieldCount: badFields,
      dangerousFieldCount: dangerousFields,
    };
  }

  private async model(action: string): Promise<Properties> {
    const raw = record(
      await this.doc.getTablesAndKeys(
        { qcx: 1000, qcy: 1000 },
        { qcx: 0, qcy: 0 },
        30,
        true,
        false,
        true,
      ),
    );
    if (!Array.isArray(raw.qtr) || raw.qtr.length > 500)
      throw createError('CAPACITY_EXHAUSTED', {
        message:
          'The data model exceeds the bounded table inspection limit or has an invalid shape.',
      });
    const tables = raw.qtr.map((value) => {
      const table = record(value);
      if (
        typeof table.qName !== 'string' ||
        !Array.isArray(table.qFields) ||
        table.qFields.length > 1_000
      )
        throw createError('MALFORMED_REQUEST');
      return table;
    });
    const limit = Number(this.input.limit);
    if (action === 'model.inspect') {
      const summaries = tables.slice(0, limit).map((table) => ({
        name: table.qName,
        rowCount: table.qNoOfRows,
        synthetic: table.qIsSynthetic === true,
        looselyCoupled: table.qLoose === true,
        fields: (table.qFields as unknown[]).map((value) => {
          const field = record(value);
          return {
            name: field.qName,
            hasNull: field.qHasNull,
            hasDuplicates: field.qHasDuplicates,
            synthetic: field.qIsSynthetic,
            nonNullCount: field.qnNonNulls,
            rowCount: field.qnRows,
            distinctCount: field.qnTotalDistinctValues,
            keyType: field.qKeyType,
            informationDensity: field.qInformationDensity,
            subsetRatio: field.qSubsetRatio,
          };
        }),
      }));
      boundedJson(summaries);
      return {
        tables: summaries,
        totalTables: tables.length,
        truncated: tables.length > limit,
        qualityScope:
          'Engine field profiling; duplicate flags describe repeated field values, not duplicate whole rows.',
      };
    }
    const table = tables.find((value) => value.qName === this.input.tableName);
    if (!table) throw createError('NOT_FOUND');
    const fields = table.qFields as unknown[];
    if (fields.length > 100)
      throw createError('CAPACITY_EXHAUSTED', {
        message: 'Table preview is limited to tables with at most 100 fields.',
      });
    const offset = Number(this.input.offset);
    // GetTablesAndKeys field order can differ after joins. Offset -1 returns
    // the header in GetTableData's own column order; never infer that order.
    const headerLimit = offset === 0 ? limit + 1 : 1;
    const headerPage = await this.doc.getTableData(
      -1,
      headerLimit,
      true,
      String(this.input.tableName),
    );
    if (
      !Array.isArray(headerPage) ||
      headerPage.length < 1 ||
      headerPage.length > headerLimit ||
      !Array.isArray(headerPage[0]?.qValue)
    )
      throw createError('MALFORMED_REQUEST', {
        message: 'Qlik did not return a bounded table-preview header.',
      });
    const columns = headerPage[0].qValue.map((value) => record(value).qText);
    const modelColumns = fields.map((value) => record(value).qName);
    if (
      columns.length !== modelColumns.length ||
      new Set(columns).size !== columns.length ||
      new Set(modelColumns).size !== modelColumns.length ||
      columns.some((value) => typeof value !== 'string' || !value || !modelColumns.includes(value))
    )
      throw createError('MALFORMED_REQUEST', {
        message: 'The table-preview header does not match the inspected model fields.',
      });
    const rows =
      offset === 0
        ? headerPage.slice(1)
        : await this.doc.getTableData(offset, limit, true, String(this.input.tableName));
    if (!Array.isArray(rows) || rows.length > limit)
      throw createError('MALFORMED_REQUEST', {
        message: 'The table preview did not match the requested row bounds.',
      });
    const values = rows.map((row) => {
      const cells = record(row).qValue;
      if (!Array.isArray(cells) || cells.length !== columns.length)
        throw createError('MALFORMED_REQUEST', {
          message: 'The table-preview row width does not match its header.',
        });
      return cells;
    });
    const result = {
      tableName: this.input.tableName,
      columns,
      rows: values,
      offset: this.input.offset,
      returnedRows: rows.length,
      totalRows: table.qNoOfRows,
    };
    boundedJson(result);
    return result;
  }

  private async absent(objectId: string): Promise<void> {
    const infos = await this.doc.getAllInfos();
    if (infos.some((info) => info.qId === objectId))
      throw createError('IDEMPOTENCY_CONFLICT', {
        message: 'The requested stable Qlik identifier already exists.',
      });
  }

  private async master(action: string): Promise<Properties> {
    const input = this.input;
    const kind = String(input.kind);
    if (action === 'master.list') {
      const dimensions = input.kind === 'measure' ? [] : await this.doc.getDimensionList();
      const measures = input.kind === 'dimension' ? [] : await this.doc.getMeasureList();
      const items = [
        ...dimensions.map((value) => ({
          itemId: value.qInfo?.qId,
          title: value.qData?.title,
          kind: 'dimension',
        })),
        ...measures.map((value) => ({
          itemId: value.qInfo?.qId,
          title: value.qData?.title,
          kind: 'measure',
        })),
      ];
      const selected = items.slice(
        Number(input.offset),
        Number(input.offset) + Number(input.limit),
      );
      boundedJson(selected);
      return { items: selected, total: items.length };
    }
    const itemId = String(input.itemId);
    if (action === 'master.create') {
      await this.absent(itemId);
      const properties = await this.masterProperties();
      const object =
        kind === 'dimension'
          ? await this.write(() => this.doc.createDimension(properties))
          : await this.write(() => this.doc.createMeasure(properties));
      const actual = record(await object.getProperties());
      semantic(actual, itemId, kind);
      if (!containsProperties(actual, properties)) throw uncertain();
      await this.save();
      const verified = record(await object.getProperties());
      if (!containsProperties(verified, properties)) throw uncertain();
      return { itemId, kind, saved: true, verified: true, expectedHash: propertiesHash(verified) };
    }
    const existingInfo = (await this.doc.getAllInfos()).find((info) => info.qId === itemId);
    if (!existingInfo) throw createError('NOT_FOUND');
    if (existingInfo.qType !== kind)
      throw createError('MALFORMED_REQUEST', {
        message: 'The master item has a different semantic type.',
      });
    const object =
      kind === 'dimension'
        ? await this.doc.getDimension(itemId)
        : await this.doc.getMeasure(itemId);
    const properties = record(await object.getProperties());
    semantic(properties, itemId, kind);
    boundedJson(properties);
    if (action === 'master.get')
      return { itemId, kind, properties, expectedHash: propertiesHash(properties) };
    precondition(properties, input.expectedHash);
    if (action === 'master.delete') {
      const linked = await object.getLinkedObjects();
      if (linked.length > 0)
        throw createError('IDEMPOTENCY_CONFLICT', {
          message:
            'The master item is referenced by charts. Replace those references before deletion.',
          details: { linkedObjectCount: linked.length },
        });
      const deleted =
        kind === 'dimension'
          ? await this.write(() => this.doc.destroyDimension(itemId))
          : await this.write(() => this.doc.destroyMeasure(itemId));
      if (!deleted) throw uncertain();
      await this.save();
      const remaining =
        kind === 'dimension' ? await this.doc.getDimensionList() : await this.doc.getMeasureList();
      if (remaining.some((value) => value.qInfo?.qId === itemId)) throw uncertain();
      return { itemId, kind, deleted: true, saved: true, verified: true };
    }
    const edits = await this.masterProperties();
    const next = {
      ...properties,
      ...edits,
      ...(kind === 'dimension'
        ? { qDim: { ...record(properties.qDim ?? {}), ...record(edits.qDim) } }
        : { qMeasure: { ...record(properties.qMeasure ?? {}), ...record(edits.qMeasure) } }),
      qMetaDef: { ...record(properties.qMetaDef ?? {}), ...record(edits.qMetaDef) },
    };
    // Re-read immediately before writing: expression/catalog checks may have taken time.
    precondition(await object.getProperties(), input.expectedHash);
    await this.write(() => object.setProperties(next));
    await this.save();
    const actual = record(await object.getProperties());
    if (!containsProperties(actual, next)) throw uncertain();
    return { itemId, kind, saved: true, verified: true, expectedHash: propertiesHash(actual) };
  }

  private async masterProperties(): Promise<Properties> {
    const input = this.input;
    let binding: Properties;
    if (input.kind === 'dimension') {
      if (!Array.isArray(input.fields) || input.expression !== undefined)
        throw createError('MALFORMED_REQUEST', {
          message: 'A master dimension requires fields and cannot contain a measure expression.',
        });
      const catalog = await this.catalog();
      const fields = input.fields.map(
        (value) => resolveCatalogFieldLabel(catalog, String(value)).label,
      );
      if (new Set(fields).size !== fields.length) throw createError('MALFORMED_REQUEST');
      binding = {
        qDim: {
          qGrouping: fields.length > 1 ? 'H' : 'N',
          qFieldDefs: fields,
          qFieldLabels: fields,
        },
      };
    } else {
      if (typeof input.expression !== 'string' || input.fields !== undefined)
        throw createError('MALFORMED_REQUEST', {
          message: 'A master measure requires an expression and cannot contain dimension fields.',
        });
      if (!(await this.expression(input.expression)).valid)
        throw createError('DISALLOWED_EXPRESSION');
      binding = { qMeasure: { qDef: input.expression, qLabel: input.title, qGrouping: 'N' } };
    }
    return {
      qInfo: { qId: input.itemId, qType: input.kind },
      qMetaDef: {
        title: input.title,
        description: input.description ?? '',
        tags: input.tags ?? [],
      },
      ...binding,
    };
  }

  private async sheetState(sheetId = String(this.input.sheetId)): Promise<{
    object: GenericObject;
    properties: Properties;
    tree: GenericObjectEntry;
    cells: SheetCell[];
    ownedChildIds: string[];
    snapshot: Properties;
    expectedHash: string;
  }> {
    const allInfos = await this.doc.getAllInfos();
    const sheetInfo = allInfos.find((info) => info.qId === sheetId);
    if (!sheetInfo) throw createError('NOT_FOUND');
    if (sheetInfo.qType !== 'sheet')
      throw createError('MALFORMED_REQUEST', { message: 'The requested object is not a sheet.' });
    const object = await this.doc.getObject(sheetId);
    const nativeTree = await object.getFullPropertyTree();
    boundedJson(nativeTree);
    const properties = record(nativeTree.qProperty);
    semantic(properties, sheetId, 'sheet');
    const cells = cellsOf(properties);
    const children = await object.getChildInfos();
    if (
      children.some(
        (child) => !cells.some((cell) => cell.name === child.qId && cell.type === child.qType),
      ) ||
      new Set(children.map((child) => child.qId)).size !== children.length
    ) {
      throw createError('MALFORMED_REQUEST', {
        message: 'The sheet cell collection and child objects disagree.',
      });
    }
    const ownedChildIds = children.map((child) => String(child.qId));
    const displayedTrees: GenericObjectEntry[] = [];
    for (const cell of cells) {
      const info = allInfos.find((info) => info.qId === cell.name);
      if (!info)
        throw createError('NOT_FOUND', {
          message: 'A sheet cell references an object that no longer exists.',
        });
      if (info.qType !== cell.type)
        throw createError('MALFORMED_REQUEST', {
          message: 'A sheet cell references a different semantic object type.',
        });
      const childTree = ownedChildIds.includes(cell.name)
        ? nativeTree.qChildren?.find((child) => child.qProperty?.qInfo?.qId === cell.name)
        : await (await this.doc.getObject(cell.name)).getFullPropertyTree();
      if (!childTree)
        throw createError('MALFORMED_REQUEST', {
          message: 'A sheet child is missing from the Engine property tree.',
        });
      semantic(record(childTree.qProperty), cell.name, cell.type);
      displayedTrees.push(childTree);
    }
    // Qlik-authored sheets can reference app-level objects from cells. Include those
    // definitions in hashes and duplicate snapshots without claiming ownership.
    const tree = { ...nativeTree, qChildren: displayedTrees };
    const snapshot = { tree, ownedChildIds };
    boundedJson(snapshot);
    return {
      object,
      properties,
      tree,
      cells,
      ownedChildIds,
      snapshot,
      expectedHash: propertiesHash(snapshot),
    };
  }

  private sheetSummary(
    state: Awaited<ReturnType<EngineManagementAttempt['sheetState']>>,
  ): Properties {
    return {
      sheetId: this.input.sheetId,
      title: record(state.properties.qMetaDef ?? {}).title,
      description: record(state.properties.qMetaDef ?? {}).description,
      columns: state.properties.columns ?? 24,
      rows: state.properties.rows ?? 12,
      cells: state.cells.map((cell) => ({
        objectId: cell.name,
        type: cell.type,
        col: cell.col,
        row: cell.row,
        colspan: cell.colspan,
        rowspan: cell.rowspan,
        ownership: state.ownedChildIds.includes(cell.name) ? 'sheet-child' : 'app-reference',
      })),
      expectedHash: state.expectedHash,
    };
  }

  private async sheetVisibility(object: GenericObject): Promise<{
    published: boolean | null;
    approved: boolean | null;
  }> {
    const layout = record(await object.getLayout());
    semantic(layout, String(object.id), 'sheet');
    const metadata = record(layout.qMeta ?? {});
    return {
      published: typeof metadata.published === 'boolean' ? metadata.published : null,
      approved: typeof metadata.approved === 'boolean' ? metadata.approved : null,
    };
  }

  private async sheet(action: string): Promise<Properties> {
    const input = this.input;
    const sheetId = String(input.sheetId);
    if (action === 'sheet.create') {
      await this.absent(sheetId);
      const properties = {
        ...NATIVE_SHEET_LAYOUT,
        qInfo: { qId: sheetId, qType: 'sheet' },
        qMetaDef: { title: input.title, description: input.description ?? '', tags: [] },
        qChildListDef: { qData: { title: '/title' } },
        cells: [],
        rank: 1,
      };
      const created = await this.write(() => this.doc.createObject(properties));
      semantic(record(await created.getProperties()), sheetId, 'sheet');
      await this.save();
      const actual = await this.sheetState();
      if (!containsProperties(actual.properties, properties)) throw uncertain();
      return { ...this.sheetSummary(actual), saved: true, verified: true };
    }
    const state = await this.sheetState();
    if (action === 'sheet.get')
      return { ...this.sheetSummary(state), ...(await this.sheetVisibility(state.object)) };
    precondition(state.snapshot, input.expectedHash);
    if (action === 'sheet.publish' || action === 'sheet.unpublish') {
      const published = action === 'sheet.publish';
      const before = await this.sheetVisibility(state.object);
      if (before.published === null)
        throw createError('NOT_CONFIGURED', {
          message: 'Qlik did not provide authoritative sheet publication metadata.',
        });
      if (!published && before.approved === true)
        throw createError('PERMISSION_DENIED', {
          message: 'Approved base content cannot be made private through this action.',
        });
      if (before.published !== published) {
        precondition((await this.sheetState()).snapshot, input.expectedHash);
        await this.write(() => (published ? state.object.publish() : state.object.unPublish()));
        await this.save();
      }
      const actual = await this.sheetState();
      const visibility = await this.sheetVisibility(actual.object);
      if (visibility.published !== published) throw uncertain();
      return {
        sheetId,
        ...visibility,
        expectedHash: actual.expectedHash,
        saved: true,
        verified: true,
      };
    }
    if (action === 'sheet.delete') {
      if (!(await this.write(() => this.doc.destroyObject(sheetId)))) throw uncertain();
      await this.save();
      const remaining = await this.doc.getAllInfos();
      if (
        remaining.some(
          (info) => info.qId === sheetId || state.ownedChildIds.includes(String(info.qId)),
        )
      )
        throw uncertain();
      const retainedAppObjectIds = state.cells
        .filter((cell) => !state.ownedChildIds.includes(cell.name))
        .map((cell) => cell.name);
      if (retainedAppObjectIds.some((id) => !remaining.some((info) => info.qId === id)))
        throw uncertain();
      return {
        sheetId,
        deleted: true,
        saved: true,
        verified: true,
        retainedAppObjectCount: retainedAppObjectIds.length,
      };
    }
    if (action === 'sheet.duplicate') return this.duplicateSheet(state);
    const next: Properties = {
      ...state.properties,
      qMetaDef: {
        ...record(state.properties.qMetaDef ?? {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    };
    if (Array.isArray(input.cells)) {
      if (
        !sameMembers(
          state.cells.map((cell) => cell.name),
          input.cells.map((value) => String(record(value).objectId)),
        )
      )
        throw createError('MALFORMED_REQUEST', {
          message: 'Layout edits must specify every existing chart exactly once.',
        });
      const cells = input.cells.map((value) => {
        const edit = record(value);
        const existing = state.cells.find((cell) => cell.name === edit.objectId)!;
        const position = {
          col: Number(edit.col),
          row: Number(edit.row),
          colspan: Number(edit.colspan),
          rowspan: Number(edit.rowspan),
        };
        return {
          ...existing,
          ...position,
          bounds: sheetCellBounds(position, Number(next.columns ?? 24), Number(next.rows ?? 12)),
        };
      });
      validateCells(cells, next);
      Object.assign(next, { cells });
    }
    await this.write(() => state.object.setProperties(next as ObjectPropertiesInput));
    await this.save();
    const actual = await this.sheetState();
    if (!containsProperties(actual.properties, next)) throw uncertain();
    return { ...this.sheetSummary(actual), saved: true, verified: true };
  }

  private async duplicateSheet(
    state: Awaited<ReturnType<EngineManagementAttempt['sheetState']>>,
  ): Promise<Properties> {
    const destination = String(this.input.newSheetId);
    const ids = new Map<string, string>([[String(this.input.sheetId), destination]]);
    let count = 0;
    const collect = (entry: GenericObjectEntry, depth: number) => {
      if (++count > 200 || depth > 3 || entry.qEmbeddedSnapshotRef)
        throw createError('MALFORMED_REQUEST', {
          message: 'The sheet property tree contains unsupported embedded content or nesting.',
        });
      const properties = record(entry.qProperty);
      const info = record(properties.qInfo);
      if (
        typeof info.qId !== 'string' ||
        typeof info.qType !== 'string' ||
        (depth > 0 && !SUPPORTED_CHART_TYPES.has(info.qType) && info.qType !== 'listbox') ||
        properties.qExtendsId
      )
        throw createError('MALFORMED_REQUEST', {
          message: 'Only supported, unlinked sheet and chart property trees can be duplicated.',
        });
      if (depth > 0)
        ids.set(info.qId, derivedObjectId(destination, computePlanHash(info.qId).slice(7, 23)));
      (entry.qChildren ?? []).forEach((child) => collect(child, depth + 1));
    };
    collect(state.tree, 0);
    for (const newId of ids.values()) await this.absent(newId);
    const clone = (entry: GenericObjectEntry): GenericObjectEntry => {
      const properties = record(entry.qProperty);
      const info = record(properties.qInfo);
      const { qlikAIHarness: _oldManagementMarker, ...rest } = properties;
      return {
        qProperty: {
          ...rest,
          qInfo: { ...info, qId: ids.get(String(info.qId)) },
          ...(Array.isArray(properties.cells)
            ? {
                cells: properties.cells.map((value) => {
                  const cell = record(value);
                  return { ...cell, name: ids.get(String(cell.name)) ?? cell.name };
                }),
              }
            : {}),
          ...(info.qType === 'sheet'
            ? { qMetaDef: { ...record(properties.qMetaDef ?? {}), title: this.input.title } }
            : {}),
        },
        qChildren: (entry.qChildren ?? []).map(clone),
      };
    };
    const tree = clone(state.tree);
    precondition((await this.sheetState()).snapshot, this.input.expectedHash);
    const created = await this.write(() => this.doc.createObject(tree.qProperty!));
    semantic(record(await created.getProperties()), destination, 'sheet');
    await this.write(() => created.setFullPropertyTree(tree));
    await this.save();
    const actual = await this.sheetState(destination);
    if (!containsProperties(actual.tree, tree)) throw uncertain();
    return {
      sheetId: destination,
      sourceSheetId: this.input.sheetId,
      saved: true,
      verified: true,
      expectedHash: actual.expectedHash,
      objectIds: Object.fromEntries(ids),
    };
  }

  private async chartState(
    state: Awaited<ReturnType<EngineManagementAttempt['sheetState']>>,
  ): Promise<{ object: GenericObject; properties: Properties; type: string }> {
    const objectId = String(this.input.objectId);
    const cell = state.cells.find((value) => value.name === objectId);
    if (!cell) throw createError('NOT_FOUND');
    if (!SUPPORTED_CHART_TYPES.has(cell.type)) throw createError('UNSUPPORTED_CHART');
    const object = await this.doc.getObject(objectId);
    const properties = record(await object.getProperties());
    semantic(properties, objectId, cell.type);
    if (properties.visualization !== undefined && properties.visualization !== cell.type)
      throw createError('MALFORMED_REQUEST', {
        message: 'The chart visualization and semantic type disagree.',
      });
    if (properties.qExtendsId)
      throw createError('MALFORMED_REQUEST', {
        message: 'Linked master visualizations must be managed through their source definition.',
      });
    boundedJson(properties);
    return { object, properties, type: cell.type };
  }

  private async compiled(): Promise<Properties> {
    const plan = compileChartIntent({
      catalog: await this.catalog(),
      target: {
        connection: this.input.connection,
        appId: this.input.appId,
        sheetId: String(this.input.sheetId),
      },
      platform: 'cloud',
      visualizationSchemaProfile: 'qlik-cloud-current',
      intent: chartIntentSchema.parse(this.input.intent),
    });
    return {
      ...plan.propertyProposal,
      qInfo: { qId: this.input.objectId, qType: plan.nativeChartType },
    };
  }

  private async verifyChart(object: GenericObject, properties: Properties): Promise<Properties> {
    const actual = record(await object.getProperties());
    if (!containsProperties(actual, properties)) throw uncertain();
    const layout = record(await object.getLayout());
    semantic(layout, String(record(properties.qInfo).qId), String(record(properties.qInfo).qType));
    const hasError = (value: unknown): boolean => Boolean(value) && record(value).qErrorCode !== 0;
    if (hasError(layout.qError) || hasError(layout.error)) throw uncertain();
    if (record(properties.qInfo).qType === 'filterpane') {
      const children = await object.getChildInfos();
      if (
        children.length === 0 ||
        children.length > 6 ||
        children.some((child) => child.qType !== 'listbox')
      )
        throw uncertain();
      for (const child of children) {
        const childObject = await this.doc.getObject(String(child.qId));
        const childLayout = record(await childObject.getLayout());
        semantic(childLayout, String(child.qId), 'listbox');
        if (hasError(childLayout.qError)) throw uncertain();
        const list = record(childLayout.qListObject);
        if (hasError(list.qError) || hasError(record(list.qDimensionInfo).qError))
          throw uncertain();
      }
    } else {
      const cube = record(layout.qHyperCube);
      const definition = record(properties.qHyperCubeDef);
      const dimensions = Array.isArray(cube.qDimensionInfo) ? cube.qDimensionInfo : [];
      const measures = Array.isArray(cube.qMeasureInfo) ? cube.qMeasureInfo : [];
      const size = record(cube.qSize);
      if (
        hasError(cube.qError) ||
        cube.qCalcCondMsg ||
        !Number.isSafeInteger(size.qcx) ||
        Number(size.qcx) < 0 ||
        !Number.isSafeInteger(size.qcy) ||
        Number(size.qcy) < 0 ||
        dimensions.length !==
          (Array.isArray(definition.qDimensions) ? definition.qDimensions.length : 0) ||
        measures.length !==
          (Array.isArray(definition.qMeasures) ? definition.qMeasures.length : 0) ||
        [...dimensions, ...measures].some(
          (field) => hasError(record(field).qError) || record(field).qCalcCondMsg,
        )
      )
        throw uncertain();
    }
    return actual;
  }

  private async chart(action: EngineManagementAction): Promise<Properties> {
    const state = await this.sheetState();
    if (action === 'chart.create' || action === 'filter.create')
      return this.createChart(state, action);
    if (action === 'chart.reorder') {
      precondition(state.snapshot, this.input.expectedHash);
      const ids = this.input.objectIds as string[];
      if (
        !sameMembers(
          state.cells.map((cell) => cell.name),
          ids,
        )
      )
        throw createError('MALFORMED_REQUEST', {
          message: 'Chart ordering must include every child exactly once.',
        });
      const next: Properties = {
        ...state.properties,
        cells: ids.map((id) => state.cells.find((cell) => cell.name === id)!),
      };
      const ownedOrder = ids.filter((id) => state.ownedChildIds.includes(id));
      if (ownedOrder.length) await this.write(() => state.object.setChildArrayOrder(ownedOrder));
      await this.write(() => state.object.setProperties(next as ObjectPropertiesInput));
      await this.save();
      const actual = await this.sheetState();
      const children = await actual.object.getChildInfos();
      if (
        !containsProperties(actual.properties, next) ||
        children.length !== ownedOrder.length ||
        children.some((child, index) => child.qId !== ownedOrder[index])
      )
        throw uncertain();
      return {
        sheetId: this.input.sheetId,
        saved: true,
        verified: true,
        expectedHash: actual.expectedHash,
        objectIds: ids,
      };
    }
    const chart = await this.chartState(state);
    if (action === 'chart.get') {
      const layout = record(await chart.object.getLayout());
      semantic(layout, String(this.input.objectId), chart.type);
      return {
        sheetId: this.input.sheetId,
        objectId: this.input.objectId,
        type: chart.type,
        ownership: state.ownedChildIds.includes(String(this.input.objectId))
          ? 'sheet-child'
          : 'app-reference',
        title: chart.properties.title,
        subtitle: chart.properties.subtitle,
        footnote: chart.properties.footnote,
        showTitles: chart.properties.showTitles,
        binding: chart.properties.qHyperCubeDef ?? null,
        expectedHash: propertiesHash(chart.properties),
        expectedSheetHash: state.expectedHash,
      };
    }
    if (action === 'chart.export') return this.exportChart(chart);
    precondition(chart.properties, this.input.expectedHash);
    if (action === 'chart.delete') {
      precondition(state.snapshot, this.input.expectedSheetHash);
      const owned = state.ownedChildIds.includes(String(this.input.objectId));
      const next: Properties = {
        ...state.properties,
        cells: state.cells.filter((cell) => cell.name !== this.input.objectId),
      };
      if (owned) {
        if (
          !(await this.write(() =>
            state.object.destroyChild(String(this.input.objectId), next as ObjectPropertiesInput),
          ))
        )
          throw uncertain();
      } else {
        // A cell reference does not establish ownership. Removing the placement
        // preserves a reusable app object that other sheets or containers may use.
        await this.write(() => state.object.setProperties(next as ObjectPropertiesInput));
      }
      await this.save();
      const actual = await this.sheetState();
      const objectStillExists = (await this.doc.getAllInfos()).some(
        (info) => info.qId === this.input.objectId,
      );
      if (
        actual.cells.some((cell) => cell.name === this.input.objectId) ||
        (owned ? objectStillExists : !objectStillExists)
      )
        throw uncertain();
      return {
        objectId: this.input.objectId,
        deleted: true,
        objectDeleted: owned,
        ...(owned ? {} : { retainedAppObject: true }),
        saved: true,
        verified: true,
        expectedSheetHash: actual.expectedHash,
      };
    }
    let next = chart.properties;
    if (this.input.intent !== undefined) {
      next = await this.compiled();
      if (record(next.qInfo).qType !== chart.type)
        throw createError('MALFORMED_REQUEST', {
          message:
            'Editing chart bindings preserves the existing chart type. Create a replacement chart to change visualization type.',
        });
      next = { ...chart.properties, ...next };
    }
    next = {
      ...next,
      ...Object.fromEntries(
        ['title', 'subtitle', 'footnote', 'showTitles']
          .filter((key) => this.input[key] !== undefined)
          .map((key) => [key, this.input[key]]),
      ),
    };
    precondition(await chart.object.getProperties(), this.input.expectedHash);
    await this.write(() => chart.object.setProperties(next as ObjectPropertiesInput));
    await this.save();
    const actual = await this.verifyChart(chart.object, next);
    return {
      objectId: this.input.objectId,
      saved: true,
      verified: true,
      expectedHash: propertiesHash(actual),
    };
  }

  private async createChart(
    state: Awaited<ReturnType<EngineManagementAttempt['sheetState']>>,
    action: string,
  ): Promise<Properties> {
    precondition(state.snapshot, this.input.expectedSheetHash);
    if (state.cells.length >= MAX_SHEET_OBJECTS) throw createError('CAPACITY_EXHAUSTED');
    const objectId = String(this.input.objectId);
    await this.absent(objectId);
    let fields: string[] = [];
    let properties: Properties;
    if (action === 'filter.create') {
      const catalog = await this.catalog();
      fields = (this.input.fields as string[]).map(
        (field) => resolveCatalogFieldLabel(catalog, field).label,
      );
      if (new Set(fields).size !== fields.length) throw createError('MALFORMED_REQUEST');
      for (const [index] of fields.entries())
        await this.absent(derivedObjectId(objectId, `field-${index + 1}`));
      // Qlik's published sn-filter-pane property schema version 1.4.0.
      properties = {
        qInfo: { qId: objectId, qType: 'filterpane' },
        visualization: 'filterpane',
        version: '1.4.0',
        title: this.input.title,
        showTitles: true,
        subtitle: '',
        footnote: '',
        qChildListDef: { qData: { title: '/title' } },
      };
    } else properties = await this.compiled();
    const placement = this.input.placement as SheetPlacement;
    const cell = {
      ...placement,
      name: objectId,
      type: String(record(properties.qInfo).qType),
      bounds: sheetCellBounds(
        placement,
        Number(state.properties.columns ?? 24),
        Number(state.properties.rows ?? 12),
      ),
    };
    const cells = [...state.cells, cell];
    validateCells(cells, state.properties);
    precondition((await this.sheetState()).snapshot, this.input.expectedSheetHash);
    const parentProperties: Properties = { ...state.properties, cells };
    const object = await this.write(() =>
      state.object.createChild(properties, parentProperties as ObjectPropertiesInput),
    );
    semantic(record(await object.getProperties()), objectId, cell.type);
    for (const [index, field] of fields.entries()) {
      const childId = derivedObjectId(objectId, `field-${index + 1}`);
      const childProperties = {
        qInfo: { qId: childId, qType: 'listbox' },
        title: field,
        qListObjectDef: {
          qDef: { qFieldDefs: [field], qSortCriterias: [{ qSortByAscii: 1 }] },
          qShowAlternatives: true,
          qInitialDataFetch: [{ qTop: 0, qLeft: 0, qHeight: 50, qWidth: 1 }],
        },
      };
      const child = await this.write(() => object.createChild(childProperties));
      semantic(record(await child.getProperties()), childId, 'listbox');
    }
    await this.save();
    const actual = await this.verifyChart(object, properties);
    const actualSheet = await this.sheetState();
    if (!containsProperties(actualSheet.properties, parentProperties)) throw uncertain();
    return {
      objectId,
      sheetId: this.input.sheetId,
      type: cell.type,
      saved: true,
      verified: true,
      expectedHash: propertiesHash(actual),
      expectedSheetHash: actualSheet.expectedHash,
    };
  }

  private async exportChart(
    chart: Awaited<ReturnType<EngineManagementAttempt['chartState']>>,
  ): Promise<Properties> {
    if (chart.type === 'filterpane')
      throw createError('MALFORMED_REQUEST', {
        message: 'Filter panes do not contain an exportable hypercube.',
      });
    const layout = record(await chart.object.getLayout());
    semantic(layout, String(this.input.objectId), chart.type);
    const cube = record(layout.qHyperCube);
    if (cube.qMode !== 'S')
      throw createError('MALFORMED_REQUEST', {
        message:
          'Bounded data export currently supports straight hypercubes. Export a table chart for tree or stacked data.',
      });
    const size = record(cube.qSize);
    const width = Number(size.qcx);
    const totalRows = Number(size.qcy);
    const limit = Number(this.input.limit);
    const offset = Number(this.input.offset);
    if (
      !Number.isSafeInteger(width) ||
      width < 1 ||
      width > 100 ||
      !Number.isSafeInteger(totalRows) ||
      totalRows < 0 ||
      width * limit > 10_000
    )
      throw createError('CAPACITY_EXHAUSTED');
    const height = Math.max(0, Math.min(limit, totalRows - offset));
    const pages = height
      ? await chart.object.getHyperCubeData('/qHyperCubeDef', [
          { qTop: offset, qLeft: 0, qHeight: height, qWidth: width },
        ])
      : [];
    if (
      pages.length > 1 ||
      pages.some(
        (page) =>
          !Array.isArray(page.qMatrix) ||
          page.qMatrix.length > height ||
          page.qMatrix.some((row) => row.length !== width) ||
          page.qArea?.qTop !== offset ||
          page.qArea.qLeft !== 0 ||
          page.qArea.qWidth !== width ||
          page.qArea.qHeight !== page.qMatrix.length,
      )
    )
      throw createError('MALFORMED_REQUEST', {
        message: 'The export page did not match the requested bounds.',
      });
    const rows = pages
      .flatMap((page) => page.qMatrix ?? [])
      .map((row) =>
        row.map((cell) => ({
          text: cell.qText ?? '',
          number: Number.isFinite(cell.qNum) ? cell.qNum : null,
        })),
      );
    const columns = [
      ...(Array.isArray(cube.qDimensionInfo) ? cube.qDimensionInfo : []),
      ...(Array.isArray(cube.qMeasureInfo) ? cube.qMeasureInfo : []),
    ].map((field) => record(field).qFallbackTitle ?? '');
    if (columns.length !== width) throw createError('MALFORMED_REQUEST');
    const result = {
      objectId: this.input.objectId,
      columns,
      rows,
      offset,
      returnedRows: rows.length,
      totalRows,
      truncated: offset + rows.length < totalRows,
      selectionScope: 'isolated session default selection state',
    };
    boundedJson(result);
    return result;
  }
}
