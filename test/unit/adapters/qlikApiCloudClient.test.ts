import { describe, expect, it } from 'vitest';
import { QlikApiAppSession } from '../../../src/adapters/cloud/qlikApiCloudClient.js';

describe('QlikApiAppSession sheet placement', () => {
  it('adds and removes the exact sheet cell through atomic parent-property updates', async () => {
    const objectId = 'native-table-visible';
    const existingCell = {
      name: 'existing-object',
      type: 'kpi',
      col: 0,
      row: 0,
      colspan: 6,
      rowspan: 4,
    };
    let sheetProperties: Record<string, unknown> = {
      qInfo: { qId: 'sheet-1', qType: 'sheet' },
      columns: 12,
      rows: 4,
      cells: [existingCell],
    };
    let createParentProperties: Record<string, unknown> | undefined;
    let destroyParentProperties: Record<string, unknown> | undefined;
    const child = {
      id: objectId,
      type: 'table',
      getInfo: async () => ({ qId: objectId }),
      getProperties: async () => ({ qInfo: { qId: objectId, qType: 'table' } }),
      getLayout: async () => ({ qInfo: { qId: objectId, qType: 'table' } }),
    };
    const sheet = {
      getProperties: async () => sheetProperties,
      createChild: async (
        _properties: Readonly<Record<string, unknown>>,
        parentProperties?: Record<string, unknown>,
      ) => {
        createParentProperties = parentProperties;
        sheetProperties = parentProperties ?? sheetProperties;
        return child;
      },
      getChildInfos: async () => [{ qId: objectId, qType: 'table' }],
      destroyChild: async (_id: string, parentProperties?: Record<string, unknown>) => {
        destroyParentProperties = parentProperties;
        sheetProperties = parentProperties ?? sheetProperties;
        return true;
      },
    };
    let saveCount = 0;
    const doc = {
      getObject: async (id: string) => (id === 'sheet-1' ? sheet : child),
      doSave: async () => {
        saveCount += 1;
      },
    };
    const appSession = { close: async () => undefined };
    const session = new QlikApiAppSession(appSession as never, doc as never);

    await expect(session.isSheetChild('sheet-1', objectId)).resolves.toBe(true);
    await expect(session.getObjectProperties(objectId)).resolves.toEqual({
      qInfo: { qId: objectId, qType: 'table' },
    });
    await expect(session.hasSheetCell('sheet-1', objectId)).resolves.toBe(false);

    await expect(
      session.createChildObject('sheet-1', {
        qInfo: { qId: objectId, qType: 'table' },
      }),
    ).resolves.toBe(objectId);
    expect(createParentProperties).toMatchObject({
      columns: 12,
      rows: 10,
      cells: [
        existingCell,
        {
          name: objectId,
          type: 'table',
          col: 0,
          row: 4,
          colspan: 12,
          rowspan: 6,
        },
      ],
    });
    await expect(session.isSheetChild('sheet-1', objectId)).resolves.toBe(true);
    await expect(session.hasSheetCell('sheet-1', objectId)).resolves.toBe(true);

    const placedProperties = sheetProperties;
    sheetProperties = {
      ...sheetProperties,
      cells: (sheetProperties.cells as Array<Record<string, unknown>>).map((cell) =>
        cell.name === objectId ? { ...cell, type: 'kpi' } : cell,
      ),
    };
    await expect(session.hasSheetCell('sheet-1', objectId)).resolves.toBe(false);
    sheetProperties = placedProperties;

    await expect(session.destroyChildObject('sheet-1', objectId)).resolves.toBe(true);
    expect(destroyParentProperties).toMatchObject({ cells: [existingCell] });
    await expect(session.hasSheetCell('sheet-1', objectId)).resolves.toBe(false);
    await session.save();
    expect(saveCount).toBe(1);
  });
});
