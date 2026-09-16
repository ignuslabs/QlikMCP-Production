import { createError } from '../../domain/errors.js';
import type { SheetPlacement } from '../targetAdapter.js';
import {
  assertSheetPlacement,
  containsProperties,
  isSheetPlacement,
  matchesSheetCellBounds,
  NATIVE_SHEET_LAYOUT,
  sheetCellBounds,
  MAX_SHEET_OBJECTS,
  placementsOverlap,
  samePlacement,
} from '../sheetLayout.js';
import { createQlikApi } from '@qlik/api';
import type { HostConfig } from '@qlik/api/auth';
import { openAppSession, type GenericObject } from '@qlik/api/qix';

export interface CloudAppItem {
  readonly appId: string;
  readonly name: string;
}

export interface CloudAppPage {
  readonly apps: readonly CloudAppItem[];
  readonly nextPageToken?: string;
}

export interface CloudFieldMetadata {
  readonly name: string;
  readonly cardinal?: number;
  readonly tags: readonly string[];
  readonly hidden: boolean;
  readonly system: boolean;
  readonly definitionOnly: boolean;
  readonly implicitMeasure: boolean;
}

export interface CloudMasterItemMetadata {
  readonly id: string;
  readonly title: string;
  readonly kind: 'dimension' | 'measure';
  readonly tags: readonly string[];
}

export interface CloudSheetMetadata {
  readonly id: string;
  readonly title: string;
}

export interface CloudCatalogSnapshot {
  readonly fields: readonly CloudFieldMetadata[];
  readonly masterItems: readonly CloudMasterItemMetadata[];
  readonly sheets: readonly CloudSheetMetadata[];
}

export interface CloudSheetObjectItem {
  readonly id: string;
  readonly type: string;
  readonly title: string;
}

export interface CloudSheetObjectPage {
  readonly objects: readonly CloudSheetObjectItem[];
  readonly total: number;
}

export interface CloudSdkAppSession {
  getCatalogSnapshot(): Promise<CloudCatalogSnapshot>;
  listSheetObjects(sheetId: string, offset: number, limit: number): Promise<CloudSheetObjectPage>;
  createSessionObject(properties: Readonly<Record<string, unknown>>): Promise<{
    readonly objectId: string;
    readonly layout: unknown;
    readonly treeNodes?: readonly unknown[];
  }>;
  destroySessionObject(objectId: string): Promise<boolean>;
  ensureSheet?(
    properties: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly sheetId: string; readonly created: boolean }>;
  createChildObject(
    sheetId: string,
    properties: Readonly<Record<string, unknown>>,
    placement?: SheetPlacement,
    allowExisting?: boolean,
  ): Promise<string>;
  isSheetChild(sheetId: string, objectId: string): Promise<boolean>;
  hasSheetCell(sheetId: string, objectId: string, placement?: SheetPlacement): Promise<boolean>;
  getObjectProperties(objectId: string): Promise<unknown>;
  getObjectLayout(objectId: string): Promise<unknown>;
  getObjectTreeData?(objectId: string): Promise<readonly unknown[]>;
  destroyChildObject(sheetId: string, objectId: string): Promise<boolean>;
  save(): Promise<void>;
  close(): Promise<void>;
}

export interface CloudQlikClient {
  listApps(
    hostConfig: HostConfig,
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<CloudAppPage>;
  openAppSession(options: {
    readonly hostConfig: HostConfig;
    readonly appId: string;
    readonly identity: string;
  }): Promise<CloudSdkAppSession>;
}

type QlikAppSession = ReturnType<typeof openAppSession>;
type QlikDoc = Awaited<ReturnType<QlikAppSession['getDoc']>>;
type QlikObject = GenericObject;

const DEFAULT_SHEET_COLUMNS = 24;
const DEFAULT_CHART_ROW_SPAN = 6;
const MAX_BOUNDED_TREE_NODES = 1_000;

type CloudSheetCell = {
  readonly name: string;
  readonly type: string;
  readonly col: number;
  readonly row: number;
  readonly colspan: number;
  readonly rowspan: number;
  readonly bounds?: ReturnType<typeof sheetCellBounds>;
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isSheetCell(value: unknown): value is CloudSheetCell {
  const cell = recordOf(value);
  return Boolean(
    nonEmptyString(cell?.name) && nonEmptyString(cell?.type) && isSheetPlacement(value),
  );
}

function boundedCells(properties: Record<string, unknown>): readonly CloudSheetCell[] {
  const cells = properties.cells ?? [];
  if (!Array.isArray(cells) || cells.length > MAX_SHEET_OBJECTS || !cells.every(isSheetCell)) {
    throw createError('MALFORMED_REQUEST', {
      message: 'The Qlik sheet cell layout is invalid or exceeds its bounded capacity.',
    });
  }
  return cells;
}

function readTitle(layout: unknown, fallback: string): string {
  if (!layout || typeof layout !== 'object') return fallback;
  const record = layout as Record<string, unknown>;
  if (typeof record.title === 'string' && record.title.trim()) return record.title;
  const meta = record.qMeta ?? record.qMetaDef;
  if (meta && typeof meta === 'object') {
    const title = (meta as Record<string, unknown>).title;
    if (typeof title === 'string' && title.trim()) return title;
  }
  return fallback;
}

function nextCursor(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const cursor = new URL(href, 'https://qlik.invalid').searchParams.get('next')?.trim();
    return cursor && cursor.length <= 2_048 ? cursor : undefined;
  } catch {
    return undefined;
  }
}

async function objectIdOf(object: { readonly id: string; getInfo(): Promise<{ qId?: string }> }) {
  if (object.id) return object.id;
  const info = await object.getInfo();
  if (!info.qId) throw new Error('Qlik Engine did not return an object identifier.');
  return info.qId;
}

export class QlikApiAppSession implements CloudSdkAppSession {
  private closed = false;
  private readonly objectHandles = new Map<string, Promise<QlikObject>>();

  constructor(
    private readonly session: QlikAppSession,
    private readonly doc: QlikDoc,
  ) {}

  private assertOpen(): void {
    if (this.closed)
      throw createError('IDEMPOTENCY_CONFLICT', {
        message: 'The native Qlik session has closed; reconcile the attempt before retrying.',
        details: { outcome: 'uncertain' },
      });
  }

  /** Reuse handles only within this caller-owned Engine session; properties stay uncached. */
  private getObject(objectId: string): Promise<QlikObject> {
    this.assertOpen();
    const existing = this.objectHandles.get(objectId);
    if (existing) return existing;
    const handle = this.doc.getObject(objectId).catch((error: unknown) => {
      this.objectHandles.delete(objectId);
      throw error;
    });
    this.objectHandles.set(objectId, handle);
    return handle;
  }

  async getCatalogSnapshot(): Promise<CloudCatalogSnapshot> {
    const [fields, dimensions, measures, sheets] = await Promise.all([
      this.doc.getFieldList(),
      this.doc.getDimensionList(),
      this.doc.getMeasureList(),
      this.doc.getSheetList(),
    ]);
    return {
      fields: fields.flatMap((field) =>
        field.qName
          ? [
              {
                name: field.qName,
                ...(typeof field.qCardinal === 'number' ? { cardinal: field.qCardinal } : {}),
                tags: field.qTags ?? [],
                hidden: field.qIsHidden ?? false,
                system: field.qIsSystem ?? false,
                definitionOnly: field.qIsDefinitionOnly ?? false,
                implicitMeasure: field.qIsImplicit ?? false,
              },
            ]
          : [],
      ),
      masterItems: [
        ...dimensions.flatMap((item) =>
          item.qInfo?.qId && item.qData?.title
            ? [
                {
                  id: item.qInfo.qId,
                  title: item.qData.title,
                  kind: 'dimension' as const,
                  tags: item.qData.tags ?? [],
                },
              ]
            : [],
        ),
        ...measures.flatMap((item) =>
          item.qInfo?.qId && item.qData?.title
            ? [
                {
                  id: item.qInfo.qId,
                  title: item.qData.title,
                  kind: 'measure' as const,
                  tags: item.qData.tags ?? [],
                },
              ]
            : [],
        ),
      ],
      sheets: sheets.flatMap((sheet) =>
        sheet.qInfo?.qId && sheet.qData?.title
          ? [{ id: sheet.qInfo.qId, title: sheet.qData.title }]
          : [],
      ),
    };
  }

  async listSheetObjects(
    sheetId: string,
    offset: number,
    limit: number,
  ): Promise<CloudSheetObjectPage> {
    const sheet = await this.getObject(sheetId);
    const [rawProperties, childInfos] = await Promise.all([
      sheet.getProperties(),
      sheet.getChildInfos(),
    ]);
    const cells = recordOf(rawProperties)?.cells;
    const members = new Map<string, string>();
    for (const cell of Array.isArray(cells) ? cells : []) {
      const member = recordOf(cell);
      if (typeof member?.name === 'string')
        members.set(member.name, typeof member.type === 'string' ? member.type : 'unknown');
    }
    for (const info of childInfos) {
      if (info.qId && !members.has(info.qId)) members.set(info.qId, info.qType ?? 'unknown');
    }
    const selected = [...members].slice(offset, offset + limit);
    const objects: CloudSheetObjectItem[] = [];
    // Keep QIX pressure bounded even when a caller asks for the maximum page size.
    for (let index = 0; index < selected.length; index += 8) {
      const batch = await Promise.all(
        selected.slice(index, index + 8).map(async ([id, type]) => {
          const child = await this.getObject(id);
          const properties = recordOf(await child.getProperties());
          const literalTitle = properties?.title;
          // Expression titles and inherited labels must be read from evaluated layout.
          const staticTitle =
            typeof literalTitle === 'string' &&
            literalTitle.trim() &&
            !literalTitle.trim().startsWith('=') &&
            !properties?.labelExpression;
          const display = staticTitle ? properties : await child.getLayout();
          return { id, type, title: readTitle(display, id) };
        }),
      );
      objects.push(...batch);
    }
    return { objects, total: members.size };
  }

  async createSessionObject(properties: Readonly<Record<string, unknown>>) {
    const object = await this.doc.createSessionObject(properties);
    const objectId = await objectIdOf(object);
    const layout = (await object.getLayout()) as unknown;
    const cube = recordOf(recordOf(layout)?.qHyperCube);
    const treeNodes =
      cube?.qMode === 'T'
        ? ((await object.getHyperCubeTreeData('/qHyperCubeDef', {
            qMaxNbrOfNodes: MAX_BOUNDED_TREE_NODES,
          })) as readonly unknown[])
        : undefined;
    return { objectId, layout, ...(treeNodes ? { treeNodes } : {}) };
  }

  destroySessionObject(objectId: string): Promise<boolean> {
    return this.doc.destroySessionObject(objectId);
  }

  async ensureSheet(
    properties: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly sheetId: string; readonly created: boolean }> {
    this.assertOpen();
    const sheetId = nonEmptyString(recordOf(properties.qInfo)?.qId);
    if (!sheetId || recordOf(properties.qInfo)?.qType !== 'sheet') {
      throw createError('MALFORMED_REQUEST', {
        message: 'A native sheet requires an exact identifier and sheet type.',
      });
    }
    const sheets = await this.doc.getSheetList();
    if (sheets.some((sheet) => sheet.qInfo?.qId === sheetId)) {
      const existing = await this.getObject(sheetId);
      const actual = recordOf(await existing.getProperties());
      if (
        !containsProperties(actual?.qInfo, properties.qInfo) ||
        !containsProperties(actual?.qMetaDef, properties.qMetaDef) ||
        !containsProperties(actual?.qlikAIHarness, properties.qlikAIHarness)
      ) {
        throw createError('IDEMPOTENCY_CONFLICT', {
          message: 'The sheet identifier belongs to a different generation request.',
        });
      }
      return { sheetId, created: false };
    }
    this.assertOpen();
    const sheet = await this.doc.createObject(properties);
    const actualId = await objectIdOf(sheet);
    if (actualId !== sheetId) {
      this.assertOpen();
      await this.doc.destroyObject(actualId);
      throw createError('IDEMPOTENCY_CONFLICT', {
        message:
          'Qlik changed the requested sheet identifier; the conflicting new object was removed.',
      });
    }
    return { sheetId, created: true };
  }

  async createChildObject(
    sheetId: string,
    properties: Readonly<Record<string, unknown>>,
    placement?: SheetPlacement,
    allowExisting = false,
  ): Promise<string> {
    const sheet = await this.getObject(sheetId);
    const info = recordOf(properties.qInfo);
    const requestedObjectId = nonEmptyString(info?.qId);
    const objectType = nonEmptyString(info?.qType);
    if (!requestedObjectId || !objectType) {
      throw new Error(
        'A persistent Qlik sheet object requires a bounded qInfo identifier and type.',
      );
    }
    const sheetProperties = recordOf(await sheet.getProperties()) ?? {};
    const existingCells = boundedCells(sheetProperties);
    const managed = recordOf(sheetProperties.qlikAIHarness)?.managedBy === 'qlik-ai-harness';
    if (managed && !containsProperties(sheetProperties, NATIVE_SHEET_LAYOUT))
      throw createError('IDEMPOTENCY_CONFLICT', {
        message: 'The generated sheet grid or responsive layout has changed.',
      });
    if (placement) assertSheetPlacement(placement);
    const previous = existingCells.find((cell) => cell.name === requestedObjectId);
    if (previous) {
      if (!allowExisting)
        throw createError('IDEMPOTENCY_CONFLICT', {
          message: 'The native chart identifier is already present on this sheet.',
        });
      const child = await this.getObject(requestedObjectId);
      const actual = await child.getProperties();
      if (
        previous.type !== objectType ||
        (placement && !samePlacement(previous, placement)) ||
        (managed &&
          !matchesSheetCellBounds(
            previous.bounds,
            previous,
            NATIVE_SHEET_LAYOUT.columns,
            NATIVE_SHEET_LAYOUT.rows,
          )) ||
        !containsProperties(actual, properties)
      ) {
        throw createError('IDEMPOTENCY_CONFLICT', {
          message: 'The chart identifier already has a different definition or placement.',
        });
      }
      return requestedObjectId;
    }
    if (existingCells.length >= MAX_SHEET_OBJECTS) {
      throw createError('CAPACITY_EXHAUSTED', {
        message: 'The native sheet object limit has been reached.',
      });
    }
    const nextRow = existingCells.reduce(
      (maximum, cell) => Math.max(maximum, cell.row + cell.rowspan),
      0,
    );
    const columns =
      typeof sheetProperties.columns === 'number' &&
      Number.isSafeInteger(sheetProperties.columns) &&
      sheetProperties.columns > 0
        ? Math.min(sheetProperties.columns, DEFAULT_SHEET_COLUMNS)
        : DEFAULT_SHEET_COLUMNS;
    const position = placement ?? {
      col: 0,
      row: nextRow,
      colspan: columns,
      rowspan: DEFAULT_CHART_ROW_SPAN,
    };
    assertSheetPlacement(position);
    if (
      position.col + position.colspan > columns ||
      (managed && position.row + position.rowspan > NATIVE_SHEET_LAYOUT.rows) ||
      existingCells.some((cell) => placementsOverlap(cell, position))
    ) {
      throw createError('MALFORMED_REQUEST', {
        message:
          'The requested chart placement overlaps another chart or exceeds the sheet columns.',
      });
    }
    const cell: CloudSheetCell = {
      name: requestedObjectId,
      type: objectType,
      ...position,
      ...(managed
        ? {
            bounds: sheetCellBounds(
              position,
              NATIVE_SHEET_LAYOUT.columns,
              NATIVE_SHEET_LAYOUT.rows,
            ),
          }
        : {}),
    };
    const parentProperties = {
      ...sheetProperties,
      rows: Math.max(
        typeof sheetProperties.rows === 'number' && Number.isFinite(sheetProperties.rows)
          ? sheetProperties.rows
          : 0,
        position.row + position.rowspan,
      ),
      cells: [...existingCells, cell],
    };
    this.assertOpen();
    const child = await sheet.createChild(properties, parentProperties);
    const actualObjectId = await objectIdOf(child);
    if (actualObjectId !== requestedObjectId) {
      const rollbackProperties = {
        ...parentProperties,
        cells: parentProperties.cells.filter(
          (candidate) => recordOf(candidate)?.name !== requestedObjectId,
        ),
      };
      try {
        this.assertOpen();
        await sheet.destroyChild(actualObjectId, rollbackProperties);
      } catch {
        // The adapter will surface a sanitized failure and the owning session will close.
      }
      throw new Error('Qlik Engine returned a different persistent object identifier.');
    }
    return actualObjectId;
  }

  async isSheetChild(sheetId: string, objectId: string): Promise<boolean> {
    const sheet = await this.getObject(sheetId);
    const children = await sheet.getChildInfos();
    return children.some((child) => child.qId === objectId);
  }

  async hasSheetCell(
    sheetId: string,
    objectId: string,
    placement?: SheetPlacement,
  ): Promise<boolean> {
    const sheet = await this.getObject(sheetId);
    const [rawProperties, children] = await Promise.all([
      sheet.getProperties(),
      sheet.getChildInfos(),
    ]);
    const properties = recordOf(rawProperties);
    const cells = Array.isArray(properties?.cells) ? properties.cells : [];
    if (!cells.every(isSheetCell)) return false;
    const matching = cells.filter((cell) => cell.name === objectId);
    if (matching.length !== 1) return false;
    const placed = matching[0]!;
    const managed = recordOf(properties?.qlikAIHarness)?.managedBy === 'qlik-ai-harness';
    if (
      managed &&
      (!containsProperties(properties, NATIVE_SHEET_LAYOUT) ||
        !matchesSheetCellBounds(
          placed.bounds,
          placed,
          NATIVE_SHEET_LAYOUT.columns,
          NATIVE_SHEET_LAYOUT.rows,
        ))
    )
      return false;
    if (placement && !samePlacement(placed, placement)) return false;
    if (cells.some((cell) => cell !== placed && placementsOverlap(cell, placed))) return false;
    const childType = children.find((child) => child.qId === objectId)?.qType;
    return Boolean(
      childType &&
      cells.some((cell) => isSheetCell(cell) && cell.name === objectId && cell.type === childType),
    );
  }

  async getObjectLayout(objectId: string): Promise<unknown> {
    const object = await this.getObject(objectId);
    return (await object.getLayout()) as unknown;
  }

  async getObjectTreeData(objectId: string): Promise<readonly unknown[]> {
    const object = await this.getObject(objectId);
    return (await object.getHyperCubeTreeData('/qHyperCubeDef', {
      qMaxNbrOfNodes: MAX_BOUNDED_TREE_NODES,
    })) as readonly unknown[];
  }

  async getObjectProperties(objectId: string): Promise<unknown> {
    const object = await this.getObject(objectId);
    return (await object.getProperties()) as unknown;
  }

  async destroyChildObject(sheetId: string, objectId: string): Promise<boolean> {
    const sheet = await this.getObject(sheetId);
    const sheetProperties = recordOf(await sheet.getProperties()) ?? {};
    const existingCells = Array.isArray(sheetProperties.cells) ? sheetProperties.cells : [];
    const parentProperties = {
      ...sheetProperties,
      cells: existingCells.filter((cell) => recordOf(cell)?.name !== objectId),
    };
    this.assertOpen();
    const destroyed = await sheet.destroyChild(objectId, parentProperties);
    if (destroyed) this.objectHandles.delete(objectId);
    return destroyed;
  }

  save(): Promise<void> {
    this.assertOpen();
    return this.doc.doSave();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.objectHandles.clear();
    await this.session.close();
  }
}

/** Concrete `@qlik/api` REST/QIX implementation behind the adapter boundary. */
export class QlikApiCloudClient implements CloudQlikClient {
  async listApps(
    hostConfig: HostConfig,
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<CloudAppPage> {
    const api = createQlikApi({ hostConfig });
    const response = await api.items.getItems({
      resourceType: 'app',
      limit: Math.min(Math.max(page.limit, 1), 100),
      sort: '+name',
      noActions: true,
      ...(page.cursor ? { next: page.cursor } : {}),
    });
    const apps = response.data.data.flatMap((item) =>
      item.resourceId
        ? [
            {
              appId: item.resourceId,
              name: item.name,
            },
          ]
        : [],
    );
    const cursor = nextCursor(response.data.links.next?.href);
    return { apps, ...(cursor ? { nextPageToken: cursor } : {}) };
  }

  async openAppSession(options: {
    readonly hostConfig: HostConfig;
    readonly appId: string;
    readonly identity: string;
  }): Promise<CloudSdkAppSession> {
    const session = openAppSession({
      appId: options.appId,
      identity: options.identity,
      hostConfig: options.hostConfig,
    });
    try {
      return new QlikApiAppSession(session, await session.getDoc());
    } catch (error) {
      try {
        await session.close();
      } catch {
        // Preserve the original, more useful open failure.
      }
      throw error;
    }
  }
}
