import { describe, expect, it, vi } from 'vitest';
import type { HostConfig } from '@qlik/api/auth';
import {
  CloudEngineManagementProvider,
  ENGINE_ACTION_SCHEMAS,
  type EngineManagementDoc,
} from '../../../src/management/cloudEngineProvider.js';
import type { CatalogDefinition } from '../../../src/catalog/catalogTypes.js';
import { computePlanHash } from '../../../src/domain/ids.js';

type Properties = Record<string, unknown>;
const base = { connection: 'cloud', appId: 'app-1' };
const clone = <T>(value: T): T => structuredClone(value);
const catalog: CatalogDefinition = {
  catalogId: 'catalog',
  description: 'test',
  visibilityPolicy: {
    includeVisibleMetadata: true,
    excludeHiddenMetadata: true,
    excludeSensitiveMetadata: true,
    excludeLoadScripts: true,
    excludeDataConnections: true,
    excludeSecurityRules: true,
  },
  fields: [
    {
      id: 'region',
      label: 'Region',
      role: 'dimension',
      semanticType: 'string',
      visible: true,
      cardinality: { band: 'low', maxDistinctValues: 5 },
    },
    {
      id: 'revenue',
      label: 'Revenue',
      role: 'measure',
      semanticType: 'numeric',
      visible: true,
      cardinality: { band: 'continuous' },
    },
  ],
  masterItems: [],
  chartSupport: [
    { type: 'barchart', enabled: true, maxDimensionCardinalityBand: 'high', boundedResultRows: 50 },
  ],
  excludedMetadataExamples: [],
  excludedResponseProperties: [],
};
const intent = {
  analysis: { dimensions: ['Region'], measures: ['Sum(Revenue)'] },
  presentation: { preferredChartType: 'bar', title: 'Revenue by Region' },
};

function fixture() {
  const objects = new Map<string, ReturnType<typeof object>>();
  const dimensions = new Map<string, ReturnType<typeof object>>();
  const measures = new Map<string, ReturnType<typeof object>>();
  function object(initial: Properties) {
    let properties = clone(initial);
    let children: string[] = [];
    let published = false;
    const handle = {
      id: String((initial.qInfo as Properties).qId),
      getProperties: vi.fn(async () => clone(properties)),
      setProperties: vi.fn(async (value: Properties) => {
        properties = clone(value);
      }),
      getInfo: vi.fn(async () => clone(properties.qInfo)),
      getLinkedObjects: vi.fn(async () => [] as unknown[]),
      getChildInfos: vi.fn(async () => children.map((id) => clone(objects.get(id)!.peek().qInfo))),
      getFullPropertyTree: vi.fn(async (): Promise<Properties> => ({
        qProperty: clone(properties),
        qChildren: await Promise.all(children.map((id) => objects.get(id)!.getFullPropertyTree())),
      })),
      setFullPropertyTree: vi.fn(async (tree: Properties) => {
        properties = clone(tree.qProperty as Properties);
        children = [];
        for (const entry of (tree.qChildren as Properties[]) ?? []) {
          const child = object(entry.qProperty as Properties);
          objects.set(child.id, child);
          children.push(child.id);
          await child.setFullPropertyTree(entry);
        }
      }),
      createChild: vi.fn(async (value: Properties, parent?: Properties) => {
        if (parent) properties = clone(parent);
        const child = object(value);
        objects.set(child.id, child);
        children.push(child.id);
        return child;
      }),
      destroyChild: vi.fn(async (id: string, parent?: Properties) => {
        if (parent) properties = clone(parent);
        children = children.filter((value) => value !== id);
        return objects.delete(id);
      }),
      setChildArrayOrder: vi.fn(async (ids: string[]) => {
        children = clone(ids);
      }),
      publish: vi.fn(async () => {
        published = true;
      }),
      unPublish: vi.fn(async () => {
        published = false;
      }),
      getLayout: vi.fn(async (): Promise<Properties> => {
        if ((properties.qInfo as Properties).qType === 'sheet')
          return { qInfo: clone(properties.qInfo), qMeta: { published, approved: false } };
        if ((properties.qInfo as Properties).qType === 'listbox')
          return { qInfo: clone(properties.qInfo), qListObject: { qDimensionInfo: {} } };
        if ((properties.qInfo as Properties).qType === 'filterpane')
          return {
            qInfo: clone(properties.qInfo),
            qChildList: { qItems: await handle.getChildInfos() },
          };
        const definition = (properties.qHyperCubeDef as Properties) ?? {};
        const dimensions = (definition.qDimensions as unknown[]) ?? [];
        const measures = (definition.qMeasures as unknown[]) ?? [];
        return {
          qInfo: clone(properties.qInfo),
          title: properties.title,
          qHyperCube: {
            qMode: definition.qMode ?? 'S',
            qSize: { qcx: dimensions.length + measures.length, qcy: 2 },
            qDimensionInfo: dimensions.map(() => ({ qFallbackTitle: 'Region' })),
            qMeasureInfo: measures.map(() => ({ qFallbackTitle: 'Revenue' })),
            qDataPages: [],
          },
        };
      }),
      getHyperCubeData: vi.fn(async (_path: string, pages: Properties[]) =>
        pages.map((page) => ({
          qArea: { qTop: page.qTop, qLeft: page.qLeft, qWidth: page.qWidth, qHeight: page.qHeight },
          qMatrix: Array.from({ length: Number(page.qHeight) }, () => [
            { qText: 'North', qNum: NaN },
            { qText: '12', qNum: 12 },
          ]),
        })),
      ),
      peek: () => clone(properties),
      addChild: (id: string) => {
        children.push(id);
      },
    };
    return handle;
  }
  const chart = object({
    qInfo: { qId: 'chart-1', qType: 'barchart' },
    visualization: 'barchart',
    title: 'Sales',
    qHyperCubeDef: {
      qMode: 'S',
      qDimensions: [{ qDef: { qFieldDefs: ['Region'] } }],
      qMeasures: [{ qDef: { qDef: 'Sum(Revenue)' } }],
    },
  });
  objects.set(chart.id, chart);
  const sheet = object({
    qInfo: { qId: 'sheet-1', qType: 'sheet' },
    qMetaDef: { title: 'Overview' },
    columns: 24,
    rows: 12,
    cells: [{ name: 'chart-1', type: 'barchart', col: 0, row: 0, colspan: 12, rowspan: 6 }],
  });
  sheet.addChild(chart.id);
  objects.set(sheet.id, sheet);
  let script = 'LOAD * FROM [lib://DataFiles/sales.csv];';
  const doc = {
    getScript: vi.fn(async () => script),
    setScript: vi.fn(async (value: string) => {
      script = value;
    }),
    doSave: vi.fn(async () => undefined),
    getObject: vi.fn(async (id: string) => {
      const found = objects.get(id);
      if (!found) throw new Error('404 private token');
      return found;
    }),
    getAllInfos: vi.fn(async () =>
      [...objects.values(), ...dimensions.values(), ...measures.values()].map(
        (value) => value.peek().qInfo,
      ),
    ),
    createObject: vi.fn(async (properties: Properties) => {
      const created = object(properties);
      objects.set(created.id, created);
      return created;
    }),
    destroyObject: vi.fn(async (id: string) => objects.delete(id)),
    getDimensionList: vi.fn(async () =>
      [...dimensions.values()].map((value) => ({
        qInfo: value.peek().qInfo,
        qData: value.peek().qMetaDef,
      })),
    ),
    getMeasureList: vi.fn(async () =>
      [...measures.values()].map((value) => ({
        qInfo: value.peek().qInfo,
        qData: value.peek().qMetaDef,
      })),
    ),
    getDimension: vi.fn(async (id: string) => dimensions.get(id)!),
    getMeasure: vi.fn(async (id: string) => measures.get(id)!),
    createDimension: vi.fn(async (properties: Properties) => {
      const created = object(properties);
      dimensions.set(created.id, created);
      return created;
    }),
    createMeasure: vi.fn(async (properties: Properties) => {
      const created = object(properties);
      measures.set(created.id, created);
      return created;
    }),
    destroyDimension: vi.fn(async (id: string) => dimensions.delete(id)),
    destroyMeasure: vi.fn(async (id: string) => measures.delete(id)),
    checkExpression: vi.fn(async () => ({
      qErrorMsg: '',
      qBadFieldNames: [],
      qDangerousFieldNames: [],
    })),
    getTablesAndKeys: vi.fn<EngineManagementDoc['getTablesAndKeys']>(async () => ({
      qtr: [
        {
          qName: 'Sales',
          qNoOfRows: 2,
          qFields: [
            {
              qName: 'Region',
              qHasNull: true,
              qHasDuplicates: true,
              qnNonNulls: 1,
              qnRows: 2,
              qnTotalDistinctValues: 1,
            },
          ],
        },
      ],
      qk: [],
    })),
    getTableData: vi.fn<EngineManagementDoc['getTableData']>(async (offset, rows) =>
      offset === -1
        ? [{ qValue: [{ qText: 'Region' }] }, { qValue: [{ qText: 'North' }] }].slice(0, rows)
        : [{ qValue: [{ qText: 'North' }] }],
    ),
  };
  const close = vi.fn(async () => undefined);
  const getDoc = vi.fn(async () => doc as unknown as EngineManagementDoc);
  const open = vi.fn(() => ({ getDoc, close }));
  const provider = new CloudEngineManagementProvider(
    async () => ({ host: 'tenant.qlikcloud.com' }) as HostConfig,
    open,
    { getCatalog: async () => catalog },
  );
  return {
    provider,
    doc,
    open,
    close,
    getDoc,
    objects,
    dimensions,
    measures,
    sheet,
    chart,
    object,
  };
}

describe('CloudEngineManagementProvider contracts', () => {
  it('publishes and unpublishes only an explicit hash-bound sheet and verifies visibility in fresh sessions', async () => {
    const f = fixture();
    const target = { ...base, sheetId: 'sheet-1' };
    const before = await f.provider.execute('sheet.get', target);
    expect(before.published).toBe(false);
    expect(f.sheet.publish).not.toHaveBeenCalled();
    const input = { ...target, expectedHash: before.expectedHash };
    const published = await f.provider.execute('sheet.publish', input);
    expect(published).toMatchObject({ sheetId: 'sheet-1', published: true, verified: true });
    expect(f.sheet.publish).toHaveBeenCalledOnce();
    expect(await f.provider.verify('sheet.publish', input, published)).toBe(true);
    expect(
      await f.provider.verify('sheet.publish', input, { ...published, published: false }),
    ).toBe(false);
    const current = await f.provider.execute('sheet.get', target);
    const privateInput = { ...target, expectedHash: current.expectedHash };
    const unpublished = await f.provider.execute('sheet.unpublish', privateInput);
    expect(unpublished).toMatchObject({ sheetId: 'sheet-1', published: false, verified: true });
    expect(f.sheet.unPublish).toHaveBeenCalledOnce();
    expect(await f.provider.verify('sheet.unpublish', privateInput, unpublished)).toBe(true);
    expect(f.close).toHaveBeenCalledTimes(f.open.mock.calls.length);
  });

  it('rejects publication conflicts and a non-sheet before dispatch', async () => {
    const f = fixture();
    await expect(
      f.provider.execute('sheet.publish', {
        ...base,
        sheetId: 'sheet-1',
        expectedHash: computePlanHash({}),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      f.provider.execute('sheet.publish', {
        ...base,
        sheetId: 'chart-1',
        expectedHash: computePlanHash({}),
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(f.sheet.publish).not.toHaveBeenCalled();
    expect(f.chart.publish).not.toHaveBeenCalled();
  });

  it('requires authoritative publication metadata and keeps approved base content protected', async () => {
    const f = fixture();
    const target = { ...base, sheetId: 'sheet-1' };
    const current = await f.provider.execute('sheet.get', target);
    f.sheet.getLayout.mockResolvedValue({ qInfo: { qId: 'sheet-1', qType: 'sheet' } });
    await expect(
      f.provider.execute('sheet.publish', { ...target, expectedHash: current.expectedHash }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    f.sheet.getLayout.mockResolvedValue({
      qInfo: { qId: 'sheet-1', qType: 'sheet' },
      qMeta: { published: true, approved: true },
    });
    await expect(
      f.provider.execute('sheet.unpublish', { ...target, expectedHash: current.expectedHash }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.sheet.publish).not.toHaveBeenCalled();
    expect(f.sheet.unPublish).not.toHaveBeenCalled();
  });

  it('reports uncertain publication when the provider acknowledgement is not reflected by readback', async () => {
    const f = fixture();
    const target = { ...base, sheetId: 'sheet-1' };
    const current = await f.provider.execute('sheet.get', target);
    const input = { ...target, expectedHash: current.expectedHash };
    f.sheet.publish.mockResolvedValue(undefined);
    await expect(f.provider.execute('sheet.publish', input)).rejects.toMatchObject({
      details: { outcome: 'uncertain' },
    });
    expect(await f.provider.verify('sheet.publish', input, { sheetId: 'sheet-1' })).toBe(false);
    expect(f.sheet.publish).toHaveBeenCalledOnce();
  });

  it('rejects raw properties and arbitrary actions before opening a session', async () => {
    const f = fixture();
    await expect(f.provider.execute('Doc.Evaluate', base)).rejects.toMatchObject({
      code: 'MALFORMED_REQUEST',
    });
    await expect(
      f.provider.execute('sheet.update', {
        ...base,
        sheetId: 'sheet-1',
        expectedHash: computePlanHash({}),
        properties: { qScript: 'bad' },
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(f.open).not.toHaveBeenCalled();
    expect(
      ENGINE_ACTION_SCHEMAS['chart.create'].safeParse({
        ...base,
        sheetId: 's',
        objectId: 'c',
        expectedSheetHash: computePlanHash({}),
        placement: { col: 0, row: 0, colspan: 1, rowspan: 1 },
        intent,
      }).success,
    ).toBe(true);
  });

  it('reads and edits scripts with hashes and no script echo in write results', async () => {
    const f = fixture();
    const before = await f.provider.execute('script.get', base);
    const result = await f.provider.execute('script.set', {
      ...base,
      expectedHash: before.expectedHash,
      script: 'LOAD 1 AS Value AUTOGENERATE 1;',
    });
    expect(result).toMatchObject({ saved: true, verified: true });
    expect(result).not.toHaveProperty('script');
    expect(f.doc.doSave).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it('refuses a changed script before dispatch', async () => {
    const f = fixture();
    await expect(
      f.provider.execute('script.set', {
        ...base,
        expectedHash: computePlanHash('old'),
        script: 'new',
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { outcome: 'rejected', dispatch: 'not-started' },
    });
    expect(f.doc.setScript).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('marks a stale unpublish as rejected only after closing the session without dispatch', async () => {
    const f = fixture();
    const target = { ...base, sheetId: 'sheet-1' };
    const before = await f.provider.execute('sheet.get', target);
    await f.sheet.publish();
    await f.sheet.setProperties({ ...f.sheet.peek(), title: 'Changed after planning' });
    await expect(
      f.provider.execute('sheet.unpublish', { ...target, expectedHash: before.expectedHash }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { outcome: 'rejected', dispatch: 'not-started' },
    });
    expect(f.sheet.unPublish).not.toHaveBeenCalled();
    expect(f.doc.doSave).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(await f.sheet.getLayout()).toMatchObject({ qMeta: { published: true } });
  });

  it('retains uncertainty if closing a rejected pre-dispatch attempt fails', async () => {
    const f = fixture();
    f.close.mockRejectedValue(new Error('close failure'));
    await expect(
      f.provider.execute('sheet.unpublish', {
        ...base,
        sheetId: 'sheet-1',
        expectedHash: computePlanHash({}),
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { outcome: 'uncertain' },
    });
    expect(f.sheet.unPublish).not.toHaveBeenCalled();
  });

  it('reports uncertain when save fails and hides provider secrets', async () => {
    const f = fixture();
    const before = await f.provider.execute('script.get', base);
    f.doc.doSave.mockRejectedValue(new Error('secret-token=abc'));
    await expect(
      f.provider.execute('script.set', {
        ...base,
        expectedHash: before.expectedHash,
        script: 'new',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', details: { outcome: 'uncertain' } });
    await expect(
      f.provider.execute('script.set', {
        ...base,
        expectedHash: computePlanHash('new'),
        script: 'other',
      }),
    ).rejects.not.toThrow('secret-token');
  });

  it('disposes failed opens and read errors without leaking provider messages', async () => {
    const f = fixture();
    f.getDoc.mockRejectedValue(new Error('private token'));
    await expect(f.provider.execute('script.get', base)).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('a failed session close overrides an otherwise successful result', async () => {
    const f = fixture();
    f.close.mockRejectedValue(new Error('private close error'));
    await expect(f.provider.execute('script.get', base)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { outcome: 'uncertain' },
    });
  });

  it('revokes writes after timeout even when opening finishes late', async () => {
    const f = fixture();
    let finish!: (doc: EngineManagementDoc) => void;
    const close = vi.fn(async () => undefined);
    const provider = new CloudEngineManagementProvider(
      async () => ({}) as HostConfig,
      () => ({
        getDoc: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        close,
      }),
      { timeoutMs: 5 },
    );
    await expect(
      provider.execute('script.set', {
        ...base,
        expectedHash: computePlanHash(await f.doc.getScript()),
        script: 'new',
      }),
    ).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
      details: { outcome: 'rejected', dispatch: 'not-started' },
    });
    finish(f.doc as unknown as EngineManagementDoc);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.doc.setScript).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('bounds a session close that does not settle', async () => {
    const f = fixture();
    const provider = new CloudEngineManagementProvider(
      async () => ({}) as HostConfig,
      () => ({ getDoc: f.getDoc, close: () => new Promise(() => undefined) }),
      { closeTimeoutMs: 5 },
    );
    await expect(provider.execute('script.get', base)).rejects.toMatchObject({
      details: { outcome: 'uncertain' },
    });
  });

  it('sanitizes credential factory failures before opening a session', async () => {
    const f = fixture();
    const provider = new CloudEngineManagementProvider(async () => {
      throw new Error('private client secret');
    }, f.open);
    await expect(provider.execute('script.get', base)).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    expect(f.open).not.toHaveBeenCalled();
  });
});

describe('sheet and chart semantic management', () => {
  it('requires a real sheet semantic type', async () => {
    const f = fixture();
    await f.sheet.setProperties({
      ...f.sheet.peek(),
      qInfo: { qId: 'sheet-1', qType: 'barchart' },
    });
    await expect(
      f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('hashes child definitions so stale sheet deletion cannot remove a changed chart', async () => {
    const f = fixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' });
    await f.chart.setProperties({ ...f.chart.peek(), title: 'Someone edited' });
    await expect(
      f.provider.execute('sheet.delete', {
        ...base,
        sheetId: 'sheet-1',
        expectedHash: before.expectedHash,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(f.doc.destroyObject).not.toHaveBeenCalled();
  });

  it('creates a native sheet and reads back the saved definition', async () => {
    const f = fixture();
    const result = await f.provider.execute('sheet.create', {
      ...base,
      sheetId: 'new-sheet',
      title: 'New',
    });
    expect(result).toMatchObject({
      sheetId: 'new-sheet',
      title: 'New',
      saved: true,
      verified: true,
      cells: [],
    });
    expect(f.doc.doSave).toHaveBeenCalledOnce();
  });

  it('refuses stable-ID collisions without creating another sheet', async () => {
    const f = fixture();
    await expect(
      f.provider.execute('sheet.create', { ...base, sheetId: 'chart-1', title: 'Oops' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(f.doc.createObject).not.toHaveBeenCalled();
  });

  it('renames a sheet and preserves its children', async () => {
    const f = fixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' });
    const result = await f.provider.execute('sheet.update', {
      ...base,
      sheetId: 'sheet-1',
      expectedHash: before.expectedHash,
      title: 'Renamed',
    });
    expect(result).toMatchObject({ title: 'Renamed', saved: true, verified: true });
    expect(f.objects.has('chart-1')).toBe(true);
  });

  it('validates complete layout membership and native grid bounds', async () => {
    const f = fixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' });
    await expect(
      f.provider.execute('sheet.update', {
        ...base,
        sheetId: 'sheet-1',
        expectedHash: before.expectedHash,
        cells: [],
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    await expect(
      f.provider.execute('sheet.update', {
        ...base,
        sheetId: 'sheet-1',
        expectedHash: before.expectedHash,
        cells: [{ objectId: 'chart-1', col: 23, row: 0, colspan: 12, rowspan: 6 }],
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(f.sheet.setProperties).not.toHaveBeenCalled();
  });

  it('duplicates supported children with new deterministic identifiers', async () => {
    const f = fixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' });
    const result = await f.provider.execute('sheet.duplicate', {
      ...base,
      sheetId: 'sheet-1',
      expectedHash: before.expectedHash,
      newSheetId: 'copy-sheet',
      title: 'Copy',
    });
    expect(result).toMatchObject({
      sheetId: 'copy-sheet',
      sourceSheetId: 'sheet-1',
      saved: true,
      verified: true,
    });
    const copy = f.objects.get('copy-sheet')!;
    const copiedId = (copy.peek().cells as Properties[])[0]!.name;
    expect(copiedId).not.toBe('chart-1');
    expect(f.objects.has(String(copiedId))).toBe(true);
  });

  it('rejects cell-child type disagreement and charts outside the selected sheet', async () => {
    const f = fixture();
    await expect(
      f.provider.execute('chart.get', { ...base, sheetId: 'sheet-1', objectId: 'other' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await f.chart.setProperties({ ...f.chart.peek(), qInfo: { qId: 'chart-1', qType: 'sheet' } });
    await expect(
      f.provider.execute('chart.get', { ...base, sheetId: 'sheet-1', objectId: 'chart-1' }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  it('updates chart bindings through the existing compiler and verifies evaluated shape', async () => {
    const f = fixture();
    const before = await f.provider.execute('chart.get', {
      ...base,
      sheetId: 'sheet-1',
      objectId: 'chart-1',
    });
    const result = await f.provider.execute('chart.update', {
      ...base,
      sheetId: 'sheet-1',
      objectId: 'chart-1',
      expectedHash: before.expectedHash,
      intent,
    });
    expect(result).toMatchObject({ saved: true, verified: true });
    expect(f.chart.peek().title).toBe('Revenue by Region');
  });

  it('refuses unknown fields before creating charts', async () => {
    const f = fixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' });
    await expect(
      f.provider.execute('chart.create', {
        ...base,
        sheetId: 'sheet-1',
        objectId: 'chart-2',
        expectedSheetHash: before.expectedHash,
        placement: { col: 12, row: 0, colspan: 12, rowspan: 6 },
        intent: { ...intent, analysis: { ...intent.analysis, dimensions: ['Secret'] } },
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_FIELD' });
    expect(f.sheet.createChild).not.toHaveBeenCalled();
  });

  it('creates compiled charts with verified parent placement', async () => {
    const f = fixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' });
    expect(
      await f.provider.execute('chart.create', {
        ...base,
        sheetId: 'sheet-1',
        objectId: 'chart-2',
        expectedSheetHash: before.expectedHash,
        placement: { col: 12, row: 0, colspan: 12, rowspan: 6 },
        intent,
      }),
    ).toMatchObject({ objectId: 'chart-2', saved: true, verified: true });
    expect(f.objects.get('chart-2')!.peek().visualization).toBe('barchart');
  });

  it('creates field-backed filter panes with deterministic listbox children', async () => {
    const f = fixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' });
    expect(
      await f.provider.execute('filter.create', {
        ...base,
        sheetId: 'sheet-1',
        objectId: 'filters',
        expectedSheetHash: before.expectedHash,
        title: 'Filters',
        fields: ['Region'],
        placement: { col: 12, row: 0, colspan: 12, rowspan: 6 },
      }),
    ).toMatchObject({ objectId: 'filters', saved: true, verified: true });
    expect(f.objects.get('filters-field-1')!.peek().qListObjectDef).toMatchObject({
      qDef: { qFieldDefs: ['Region'] },
    });
  });

  it('keeps derived filter identifiers within the public identifier bound', async () => {
    const f = fixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' });
    const objectId = 'f'.repeat(200);
    await f.provider.execute('filter.create', {
      ...base,
      sheetId: 'sheet-1',
      objectId,
      expectedSheetHash: before.expectedHash,
      title: 'Filters',
      fields: ['Region'],
      placement: { col: 12, row: 0, colspan: 12, rowspan: 6 },
    });
    const children = await f.objects.get(objectId)!.getChildInfos();
    expect(String((children[0] as Properties).qId).length).toBeLessThanOrEqual(200);
  });

  it('requires a policy-visible catalog for binding writes', async () => {
    const f = fixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' });
    const provider = new CloudEngineManagementProvider(async () => ({}) as HostConfig, f.open);
    await expect(
      provider.execute('chart.create', {
        ...base,
        sheetId: 'sheet-1',
        objectId: 'chart-2',
        expectedSheetHash: before.expectedHash,
        intent,
        placement: { col: 12, row: 0, colspan: 12, rowspan: 6 },
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(f.sheet.createChild).not.toHaveBeenCalled();
  });

  it('reorders complete child membership and verifies both order representations', async () => {
    const f = fixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' });
    const created = await f.provider.execute('chart.create', {
      ...base,
      sheetId: 'sheet-1',
      objectId: 'chart-2',
      expectedSheetHash: before.expectedHash,
      intent,
      placement: { col: 12, row: 0, colspan: 12, rowspan: 6 },
    });
    const result = await f.provider.execute('chart.reorder', {
      ...base,
      sheetId: 'sheet-1',
      expectedHash: created.expectedSheetHash,
      objectIds: ['chart-2', 'chart-1'],
    });
    expect(result).toMatchObject({ objectIds: ['chart-2', 'chart-1'], verified: true });
    expect((f.sheet.peek().cells as Properties[]).map((cell) => cell.name)).toEqual([
      'chart-2',
      'chart-1',
    ]);
  });

  it('treats mismatched evaluated chart shape as uncertain after mutation', async () => {
    const f = fixture();
    const before = await f.provider.execute('chart.get', {
      ...base,
      sheetId: 'sheet-1',
      objectId: 'chart-1',
    });
    f.chart.getLayout.mockResolvedValue({
      qInfo: { qId: 'chart-1', qType: 'barchart' },
      qHyperCube: { qSize: { qcx: 2, qcy: 1 }, qDimensionInfo: [], qMeasureInfo: [] },
    });
    await expect(
      f.provider.execute('chart.update', {
        ...base,
        sheetId: 'sheet-1',
        objectId: 'chart-1',
        expectedHash: before.expectedHash,
        title: 'Edited',
      }),
    ).rejects.toMatchObject({ details: { outcome: 'uncertain' } });
  });

  it('deletes charts atomically with their parent cell and verifies absence', async () => {
    const f = fixture();
    const before = await f.provider.execute('chart.get', {
      ...base,
      sheetId: 'sheet-1',
      objectId: 'chart-1',
    });
    expect(
      await f.provider.execute('chart.delete', {
        ...base,
        sheetId: 'sheet-1',
        objectId: 'chart-1',
        expectedHash: before.expectedHash,
        expectedSheetHash: before.expectedSheetHash,
      }),
    ).toMatchObject({ deleted: true, verified: true });
    expect(f.objects.has('chart-1')).toBe(false);
    expect(f.sheet.peek().cells).toEqual([]);
  });
});

describe('Qlik-authored sheets with app-level cell references', () => {
  function referencedFixture() {
    const f = fixture();
    const chart = f.object({ ...f.chart.peek(), qInfo: { qId: 'app-chart', qType: 'barchart' } });
    const sheet = f.object({
      ...f.sheet.peek(),
      qInfo: { qId: 'native-sheet', qType: 'sheet' },
      cells: [{ name: 'app-chart', type: 'barchart', col: 0, row: 0, colspan: 12, rowspan: 6 }],
    });
    f.objects.set(chart.id, chart);
    f.objects.set(sheet.id, sheet);
    return {
      ...f,
      nativeSheet: sheet,
      appChart: chart,
      target: { ...base, sheetId: 'native-sheet', objectId: 'app-chart' },
    };
  }

  it('reads app-level chart references without claiming child ownership', async () => {
    const f = referencedFixture();
    expect(await f.provider.execute('chart.get', f.target)).toMatchObject({
      objectId: 'app-chart',
      ownership: 'app-reference',
    });
    expect(await f.nativeSheet.getChildInfos()).toEqual([]);
  });

  it('hashes changes to referenced chart definitions and rejects stale sheet edits', async () => {
    const f = referencedFixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'native-sheet' });
    await f.appChart.setProperties({ ...f.appChart.peek(), title: 'External edit' });
    await expect(
      f.provider.execute('sheet.update', {
        ...base,
        sheetId: 'native-sheet',
        expectedHash: before.expectedHash,
        title: 'Rename',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(f.nativeSheet.setProperties).not.toHaveBeenCalled();
  });

  it('rejects orphan and type-confused app-level references', async () => {
    const f = referencedFixture();
    f.objects.delete('app-chart');
    await expect(
      f.provider.execute('sheet.get', { ...base, sheetId: 'native-sheet' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.objects.set('app-chart', f.object({ qInfo: { qId: 'app-chart', qType: 'sheet' } }));
    await expect(
      f.provider.execute('sheet.get', { ...base, sheetId: 'native-sheet' }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  it('reorders app-level cells without invoking owned-child reordering', async () => {
    const f = referencedFixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'native-sheet' });
    expect(
      await f.provider.execute('chart.reorder', {
        ...base,
        sheetId: 'native-sheet',
        expectedHash: before.expectedHash,
        objectIds: ['app-chart'],
      }),
    ).toMatchObject({ verified: true });
    expect(f.nativeSheet.setChildArrayOrder).not.toHaveBeenCalled();
  });

  it('duplicates references into new owned charts without altering app-level originals', async () => {
    const f = referencedFixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'native-sheet' });
    const request = {
      ...base,
      sheetId: 'native-sheet',
      newSheetId: 'native-copy',
      title: 'Copy',
      expectedHash: before.expectedHash,
    };
    const result = await f.provider.execute('sheet.duplicate', request);
    expect(result).toMatchObject({ verified: true });
    expect(await f.objects.get('native-copy')!.getChildInfos()).toHaveLength(1);
    expect(f.objects.has('app-chart')).toBe(true);
    expect(await f.provider.verify('sheet.duplicate', request, result)).toBe(true);
  });

  it('removes the selected cell while retaining the reusable app-level object', async () => {
    const f = referencedFixture();
    const before = await f.provider.execute('chart.get', f.target);
    const request = {
      ...f.target,
      expectedHash: before.expectedHash,
      expectedSheetHash: before.expectedSheetHash,
    };
    const result = await f.provider.execute('chart.delete', request);
    expect(result).toMatchObject({
      deleted: true,
      objectDeleted: false,
      retainedAppObject: true,
      verified: true,
    });
    expect(f.objects.has('app-chart')).toBe(true);
    expect(f.nativeSheet.peek().cells).toEqual([]);
    expect(f.nativeSheet.destroyChild).not.toHaveBeenCalled();
    expect(await f.provider.verify('chart.delete', request, result)).toBe(true);
  });
});

describe('independent receipt verification', () => {
  it('verifies exact script effects through a new read-only session', async () => {
    const f = fixture();
    const before = await f.provider.execute('script.get', base);
    const input = {
      ...base,
      expectedHash: before.expectedHash,
      script: 'LOAD 1 AS Value AUTOGENERATE 1;',
    };
    const receipt = await f.provider.execute('script.set', input);
    f.doc.setScript.mockClear();
    f.doc.doSave.mockClear();
    expect(await f.provider.verify('script.set', input, receipt)).toBe(true);
    expect(f.doc.setScript).not.toHaveBeenCalled();
    expect(f.doc.doSave).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(3);
    expect(await f.provider.verify('script.set', { ...input, script: 'Different' }, receipt)).toBe(
      false,
    );
  });

  it('verifies deterministic creation without replay and fails on a changed binding', async () => {
    const f = fixture();
    const before = await f.provider.execute('sheet.get', { ...base, sheetId: 'sheet-1' });
    const input = {
      ...base,
      sheetId: 'sheet-1',
      objectId: 'chart-2',
      expectedSheetHash: before.expectedHash,
      intent,
      placement: { col: 12, row: 0, colspan: 12, rowspan: 6 },
    };
    const result = await f.provider.execute('chart.create', input);
    f.sheet.createChild.mockClear();
    f.doc.doSave.mockClear();
    expect(await f.provider.verify('chart.create', input, {})).toBe(true);
    expect(f.sheet.createChild).not.toHaveBeenCalled();
    expect(f.doc.doSave).not.toHaveBeenCalled();
    await f.objects.get('chart-2')!.setProperties({
      ...f.objects.get('chart-2')!.peek(),
      qHyperCubeDef: { qDimensions: [], qMeasures: [] },
    });
    expect(await f.provider.verify('chart.create', input, result)).toBe(false);
  });

  it('requires a verified post-write hash to recover an update', async () => {
    const f = fixture();
    const before = await f.provider.execute('chart.get', {
      ...base,
      sheetId: 'sheet-1',
      objectId: 'chart-1',
    });
    const input = {
      ...base,
      sheetId: 'sheet-1',
      objectId: 'chart-1',
      expectedHash: before.expectedHash,
      title: 'Updated',
    };
    const result = await f.provider.execute('chart.update', input);
    expect(await f.provider.verify('chart.update', input, {})).toBe(false);
    expect(await f.provider.verify('chart.update', input, result)).toBe(true);
    expect(
      await f.provider.verify('chart.update', input, { ...result, objectId: 'someone-else' }),
    ).toBe(false);
  });

  it('does not mistake a provider read or close failure for successful deletion', async () => {
    const f = fixture();
    const input = {
      ...base,
      kind: 'measure',
      itemId: 'missing',
      expectedHash: computePlanHash({}),
    };
    expect(await f.provider.verify('master.delete', input, {})).toBe(true);
    f.doc.getAllInfos.mockRejectedValue(new Error('Network failed'));
    expect(await f.provider.verify('master.delete', input, {})).toBe(false);
    f.doc.getAllInfos.mockResolvedValue([]);
    f.close.mockRejectedValue(new Error('Close failed'));
    expect(await f.provider.verify('master.delete', input, {})).toBe(false);
  });
});

describe('master items, profiling and bounded data', () => {
  it('creates, edits and deletes verified master dimensions', async () => {
    const f = fixture();
    const created = await f.provider.execute('master.create', {
      ...base,
      kind: 'dimension',
      itemId: 'dim-1',
      title: 'Regions',
      fields: ['Region'],
    });
    const changed = await f.provider.execute('master.update', {
      ...base,
      kind: 'dimension',
      itemId: 'dim-1',
      expectedHash: created.expectedHash,
      title: 'Geography',
      fields: ['Region'],
    });
    expect(
      await f.provider.execute('master.delete', {
        ...base,
        kind: 'dimension',
        itemId: 'dim-1',
        expectedHash: changed.expectedHash,
      }),
    ).toMatchObject({ deleted: true, verified: true });
  });

  it('validates master measure expression and rejects kind-confused definitions', async () => {
    const f = fixture();
    await expect(
      f.provider.execute('master.create', {
        ...base,
        kind: 'dimension',
        itemId: 'dim-1',
        title: 'Bad',
        fields: ['Region'],
        expression: 'Sum(Revenue)',
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    f.doc.checkExpression.mockResolvedValue({
      qErrorMsg: 'private expression details',
      qBadFieldNames: [],
      qDangerousFieldNames: [],
    });
    await expect(
      f.provider.execute('master.create', {
        ...base,
        kind: 'measure',
        itemId: 'measure-1',
        title: 'Bad',
        expression: 'Broken()',
      }),
    ).rejects.toMatchObject({ code: 'DISALLOWED_EXPRESSION' });
    expect(f.doc.createMeasure).not.toHaveBeenCalled();
  });

  it('refuses deleting referenced master items', async () => {
    const f = fixture();
    const created = await f.provider.execute('master.create', {
      ...base,
      kind: 'measure',
      itemId: 'measure-1',
      title: 'Revenue',
      expression: 'Sum(Revenue)',
    });
    f.measures.get('measure-1')!.getLinkedObjects.mockResolvedValue([{ qId: 'chart-1' }]);
    await expect(
      f.provider.execute('master.delete', {
        ...base,
        kind: 'measure',
        itemId: 'measure-1',
        expectedHash: created.expectedHash,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(f.doc.destroyMeasure).not.toHaveBeenCalled();
  });

  it('checks master object semantic type before exposing or mutating it', async () => {
    const f = fixture();
    f.dimensions.set('dim-1', f.object({ qInfo: { qId: 'dim-1', qType: 'measure' } }));
    await expect(
      f.provider.execute('master.get', { ...base, kind: 'dimension', itemId: 'dim-1' }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  it('returns bounded expression diagnostics without echoing expressions', async () => {
    const f = fixture();
    expect(
      await f.provider.execute('expression.validate', { ...base, expression: 'Sum(Revenue)' }),
    ).toEqual({ valid: true, hasSyntaxError: false, unknownFieldCount: 0, dangerousFieldCount: 0 });
    f.doc.checkExpression.mockResolvedValue({
      qErrorMsg: 'bad private field',
      qBadFieldNames: [],
      qDangerousFieldNames: [],
    });
    expect(
      await f.provider.execute('expression.validate', { ...base, expression: 'Bad()' }),
    ).toMatchObject({ valid: false, hasSyntaxError: true });
  });

  it('reports profiling scope accurately and verifies preview width', async () => {
    const f = fixture();
    expect(await f.provider.execute('model.inspect', base)).toMatchObject({
      totalTables: 1,
      tables: [{ name: 'Sales', fields: [{ hasNull: true, hasDuplicates: true }] }],
    });
    expect(
      await f.provider.execute('table.preview', { ...base, tableName: 'Sales' }),
    ).toMatchObject({ columns: ['Region'], returnedRows: 1 });
    f.doc.getTableData.mockResolvedValue([{ qValue: [{ qText: 'Region' }] }, { qValue: [] }]);
    await expect(
      f.provider.execute('table.preview', { ...base, tableName: 'Sales' }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  it('takes preview column order from table data when a join reorders model fields', async () => {
    const f = fixture();
    f.doc.getTablesAndKeys.mockResolvedValue({
      qtr: [
        {
          qName: 'Sales',
          qNoOfRows: 2,
          qFields: [{ qName: 'OrderID' }, { qName: 'OrderDate' }, { qName: 'Region' }],
        },
      ],
    });
    const headers = { qValue: ['Region', 'OrderID', 'OrderDate'].map((qText) => ({ qText })) };
    const row = { qValue: ['EAST', 'S009', '2026-03-15'].map((qText) => ({ qText })) };
    f.doc.getTableData.mockImplementation(async (offset) =>
      offset === -1 ? [headers, row] : [row],
    );

    expect(
      await f.provider.execute('table.preview', { ...base, tableName: 'Sales', limit: 1 }),
    ).toMatchObject({
      columns: ['Region', 'OrderID', 'OrderDate'],
      rows: [row.qValue],
      returnedRows: 1,
      offset: 0,
      totalRows: 2,
    });
    expect(f.doc.getTableData).toHaveBeenCalledExactlyOnceWith(-1, 2, true, 'Sales');
  });

  it('reads later preview pages at the requested offset without counting the header', async () => {
    const f = fixture();
    f.doc.getTableData.mockResolvedValueOnce([{ qValue: [{ qText: 'Region' }] }]);
    f.doc.getTableData.mockResolvedValueOnce([{ qValue: [{ qText: 'South' }] }]);

    expect(
      await f.provider.execute('table.preview', {
        ...base,
        tableName: 'Sales',
        offset: 1,
        limit: 1,
      }),
    ).toMatchObject({
      columns: ['Region'],
      rows: [[{ qText: 'South' }]],
      returnedRows: 1,
      offset: 1,
      totalRows: 2,
    });
    expect(f.doc.getTableData.mock.calls).toEqual([
      [-1, 1, true, 'Sales'],
      [1, 1, true, 'Sales'],
    ]);
  });

  it('returns an empty preview page with verified headers when the offset is past the data', async () => {
    const f = fixture();
    f.doc.getTableData.mockResolvedValueOnce([{ qValue: [{ qText: 'Region' }] }]);
    f.doc.getTableData.mockResolvedValueOnce([]);

    expect(
      await f.provider.execute('table.preview', {
        ...base,
        tableName: 'Sales',
        offset: 2,
      }),
    ).toMatchObject({ columns: ['Region'], rows: [], returnedRows: 0, offset: 2, totalRows: 2 });
  });

  it.each([
    { description: 'missing', header: [] },
    { description: 'unnamed', header: [{ qValue: [{ qText: 'Region' }, {}] }] },
    { description: 'duplicate', header: [{ qValue: [{ qText: 'Region' }, { qText: 'Region' }] }] },
    { description: 'unknown', header: [{ qValue: [{ qText: 'Region' }, { qText: 'Unknown' }] }] },
    { description: 'incomplete', header: [{ qValue: [{ qText: 'Region' }] }] },
  ])(
    'rejects a $description preview header instead of guessing its column order',
    async ({ header }) => {
      const f = fixture();
      f.doc.getTablesAndKeys.mockResolvedValue({
        qtr: [
          { qName: 'Sales', qNoOfRows: 2, qFields: [{ qName: 'Region' }, { qName: 'OrderID' }] },
        ],
      });
      f.doc.getTableData.mockResolvedValue(header);

      await expect(
        f.provider.execute('table.preview', {
          ...base,
          tableName: 'Sales',
          offset: 1,
        }),
      ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
      expect(f.doc.getTableData).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves duplicate preview rows and raw null markers', async () => {
    const f = fixture();
    const duplicate = { qValue: [{ qText: '-', qNumber: 0 }] };
    f.doc.getTableData.mockResolvedValue([{ qValue: [{ qText: 'Region' }] }, duplicate, duplicate]);

    expect(
      await f.provider.execute('table.preview', {
        ...base,
        tableName: 'Sales',
        limit: 2,
      }),
    ).toMatchObject({
      columns: ['Region'],
      rows: [duplicate.qValue, duplicate.qValue],
      returnedRows: 2,
    });
  });

  it('rejects a preview page that exceeds its data-row limit', async () => {
    const f = fixture();
    f.doc.getTableData.mockResolvedValueOnce([{ qValue: [{ qText: 'Region' }] }]);
    f.doc.getTableData.mockResolvedValueOnce([
      { qValue: [{ qText: 'North' }] },
      { qValue: [{ qText: 'South' }] },
    ]);

    await expect(
      f.provider.execute('table.preview', {
        ...base,
        tableName: 'Sales',
        offset: 1,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  it('exports only the bounded full-width straight cube page', async () => {
    const f = fixture();
    const result = await f.provider.execute('chart.export', {
      ...base,
      sheetId: 'sheet-1',
      objectId: 'chart-1',
      limit: 1,
    });
    expect(result).toMatchObject({
      columns: ['Region', 'Revenue'],
      returnedRows: 1,
      totalRows: 2,
      truncated: true,
      rows: [
        [
          { text: 'North', number: null },
          { text: '12', number: 12 },
        ],
      ],
    });
    expect(f.chart.getHyperCubeData).toHaveBeenCalledWith('/qHyperCubeDef', [
      { qTop: 0, qLeft: 0, qHeight: 1, qWidth: 2 },
    ]);
  });

  it('rejects provider pages exceeding requested bounds', async () => {
    const f = fixture();
    f.chart.getHyperCubeData.mockResolvedValue([
      {
        qArea: { qTop: 0, qLeft: 0, qWidth: 2, qHeight: 2 },
        qMatrix: [
          [
            { qText: 'North', qNum: NaN },
            { qText: '12', qNum: 12 },
          ],
          [
            { qText: 'South', qNum: NaN },
            { qText: '10', qNum: 10 },
          ],
        ],
      },
    ]);
    await expect(
      f.provider.execute('chart.export', {
        ...base,
        sheetId: 'sheet-1',
        objectId: 'chart-1',
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  it('fails closed for non-straight cube export', async () => {
    const f = fixture();
    const layout = await f.chart.getLayout();
    f.chart.getLayout.mockResolvedValue({
      ...layout,
      qHyperCube: { ...(layout.qHyperCube as Properties), qMode: 'T' },
    });
    await expect(
      f.provider.execute('chart.export', { ...base, sheetId: 'sheet-1', objectId: 'chart-1' }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(f.chart.getHyperCubeData).not.toHaveBeenCalled();
  });
});
