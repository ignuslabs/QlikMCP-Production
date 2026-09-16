import { describe, expect, it } from 'vitest';
import type { HostConfig } from '@qlik/api/auth';
import type {
  AnyGenericObjectLayout,
  AppSession,
  Doc,
  GenericObject,
  OpenAppSessionProps,
} from '@qlik/api/qix';
import { QlikWindowsEngineSessionFactory } from '../../../src/adapters/windows/qlikWindowsEngineSession.js';
import type { ResolvedChartPlan } from '../../../src/domain/types.js';
import { MUTATOR_ACTOR } from '../../helpers/testContext.js';

type TestObject = GenericObject<Record<string, unknown>, AnyGenericObjectLayout>;

const target = {
  connection: 'windows-dev',
  appId: 'app-sales',
  sheetId: 'sheet-approved',
};

const plan = {
  nativeChartType: 'barchart',
  title: 'Revenue by region',
  resultLimit: 2,
  resolved: {
    dimensions: [{ label: 'Region' }],
    measures: [{ label: 'Revenue' }],
    filters: [],
  },
  propertyProposal: {
    qInfo: { qId: 'compiled-id', qType: 'barchart' },
    qMetaDef: { title: 'Revenue by region' },
    qHyperCubeDef: {},
  },
} as unknown as ResolvedChartPlan;

function objectFrom(partial: object): TestObject {
  return partial as TestObject;
}

function docFrom(partial: object): Doc {
  return partial as Doc;
}

function appSessionFrom(doc: Doc, onClose: () => void): AppSession {
  return {
    getDoc: async () => doc,
    close: async () => onClose(),
  } as AppSession;
}

function pfxSecret() {
  const pfx = new Uint8Array(64).fill(1);
  pfx[0] = 0x30;
  return {
    authMode: 'trusted-backend' as const,
    pfx,
    passphrase: 'passphrase',
    userHeader: 'UserDirectory=HARNESS;UserId=svc_windows',
  };
}

describe('QlikWindowsEngineSessionFactory', () => {
  it('uses windowscookie auth and disposes a preview on the exact app session that created it', async () => {
    const opened: OpenAppSessionProps[] = [];
    const destroyed: string[] = [];
    let closeCount = 0;
    const doc = docFrom({
      createSessionObject: async (properties: Record<string, unknown>) => {
        const qInfo = properties.qInfo as { qId: string; qType: string };
        return objectFrom({
          id: qInfo.qId,
          getLayout: async () => ({
            qInfo: { qId: qInfo.qId, qType: qInfo.qType },
            qHyperCube: {
              qSize: { qcx: 2, qcy: 3 },
              qMode: 'S',
              qDimensionInfo: [{ qFallbackTitle: 'Region', qCardinal: 3 }],
              qMeasureInfo: [{ qFallbackTitle: 'Revenue' }],
            },
          }),
          getHyperCubeData: async () => [
            {
              qMatrix: [
                [{ qText: 'North' }, { qText: '10', qNum: 10 }],
                [{ qText: 'South' }, { qText: '8', qNum: 8 }],
              ],
            },
          ],
        });
      },
      destroySessionObject: async (objectId: string) => {
        destroyed.push(objectId);
        return true;
      },
    });
    const appSession = appSessionFrom(doc, () => {
      closeCount += 1;
    });
    const accessToken = 'header.payload.signature';
    const factory = new QlikWindowsEngineSessionFactory({
      createIdentity: () => 'preview-identity',
      openAppSession: (options) => {
        opened.push(options);
        return appSession;
      },
    });
    const session = await factory.open({
      connection: target.connection,
      serverAlias: 'windows.example.test',
      virtualProxyAlias: 'jwt',
      authMode: 'proxy-session',
      secret: { authMode: 'proxy-session', accessToken },
    });

    const preview = await session.createSessionChart({
      target,
      plan,
      actor: MUTATOR_ACTOR,
      signal: new AbortController().signal,
    });

    expect(opened).toHaveLength(1);
    expect(opened[0]?.appId).toBe(target.appId);
    const hostConfig = opened[0]?.hostConfig as HostConfig & {
      getAccessToken: () => Promise<string>;
    };
    expect(hostConfig).toMatchObject({
      authType: 'windowscookie',
      host: 'https://windows.example.test/jwt',
    });
    await expect(hostConfig.getAccessToken()).resolves.toBe(accessToken);
    expect(preview.layout.bounded).toMatchObject({
      returnedRows: 2,
      maxRows: 2,
      truncated: true,
      rawDataIncluded: false,
    });
    expect(closeCount).toBe(0);

    await session.disposeSessionChart(preview.sessionObjectId);

    expect(destroyed).toEqual([preview.sessionObjectId]);
    expect(closeCount).toBe(1);
  });

  it('maps live QIX metadata into a policy-filtered catalog and bounded discovery pages', async () => {
    let closeCount = 0;
    const doc = docFrom({
      global: {
        getDocList: async () => [
          { qDocId: 'app-z', qTitle: 'Zulu app' },
          { qDocId: 'app-a', qTitle: 'Alpha app' },
        ],
      } as Doc['global'],
      getFieldList: async () => [
        { qName: 'Region', qTags: ['$text'], qCardinal: 5 },
        { qName: 'Revenue', qTags: ['$numeric'], qCardinal: 500, qIsImplicit: true },
        { qName: 'NumericCode', qTags: ['$numeric'], qCardinal: 25 },
        { qName: 'Secret', qTags: ['sensitive'], qCardinal: 1 },
        { qName: 'SystemField', qIsSystem: true },
      ],
      getDimensionList: async () => [
        {
          qInfo: { qId: 'master-region', qType: 'dimension' },
          qData: {
            title: 'Master Region',
            tags: ['$text'],
            grouping: 'N',
            info: [],
            labelExpression: '',
          },
        },
      ],
      getMeasureList: async () => [
        {
          qInfo: { qId: 'master-revenue', qType: 'measure' },
          qData: { title: 'Master Revenue', tags: ['$numeric'], labelExpression: '' },
        },
      ],
      getSheetList: async () => [
        {
          qInfo: { qId: 'sheet-readonly', qType: 'sheet' },
          qData: { title: 'Read only' },
        },
        {
          qInfo: { qId: target.sheetId, qType: 'sheet' },
          qData: { title: 'Approved target' },
        },
      ],
    });
    const opened: OpenAppSessionProps[] = [];
    const factory = new QlikWindowsEngineSessionFactory({
      openAppSession: (options) => {
        opened.push(options);
        return appSessionFrom(doc, () => {
          closeCount += 1;
        });
      },
      createIdentity: () => `metadata-${opened.length}`,
    });
    const session = await factory.open({
      connection: target.connection,
      serverAlias: 'windows.example.test',
      virtualProxyAlias: 'jwt',
      discoveryAppId: target.appId,
      writeTarget: target,
      authMode: 'proxy-session',
      secret: { authMode: 'proxy-session', accessToken: 'header.payload.signature' },
    });

    const apps = await session.listAccessibleApps(MUTATOR_ACTOR, { pageSize: 1 });
    const context = await session.getCompilationContext(target.appId, MUTATOR_ACTOR);
    const nextApps = await session.listAccessibleApps(MUTATOR_ACTOR, {
      pageSize: 1,
      pageToken: apps.nextPageToken,
    });

    expect(apps).toMatchObject({
      apps: [{ appId: 'app-a', name: 'Alpha app', platform: 'windows' }],
      truncated: true,
      nextPageToken: 'windows:1',
    });
    expect(nextApps.apps).toMatchObject([{ appId: 'app-z' }]);
    expect(context.catalog.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Region', role: 'dimension', semanticType: 'text' }),
        expect.objectContaining({ label: 'Revenue', role: 'measure', semanticType: 'numeric' }),
        expect.objectContaining({
          label: 'NumericCode',
          role: 'dimension',
          semanticType: 'numeric',
        }),
      ]),
    );
    expect(context.catalog.fields).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Secret' })]),
    );
    expect(context.catalog.masterItems).toHaveLength(2);
    expect(context.sheets.find((sheet) => sheet.sheetId === target.sheetId)?.writeAllowed).toBe(
      true,
    );
    expect(context.sheets.find((sheet) => sheet.sheetId === 'sheet-readonly')?.writeAllowed).toBe(
      false,
    );
    expect(closeCount).toBe(3);
  });

  it('closes the originating app session when QIX does not acknowledge preview disposal', async () => {
    let closeCount = 0;
    const doc = docFrom({
      createSessionObject: async (properties: Record<string, unknown>) => {
        const qInfo = properties.qInfo as { qId: string; qType: string };
        return objectFrom({
          id: qInfo.qId,
          getLayout: async () => ({
            qInfo,
            qHyperCube: { qSize: { qcx: 1, qcy: 0 }, qMode: 'S' },
          }),
          getHyperCubeData: async () => [{ qMatrix: [] }],
        });
      },
      destroySessionObject: async () => false,
    });
    const factory = new QlikWindowsEngineSessionFactory({
      openAppSession: () =>
        appSessionFrom(doc, () => {
          closeCount += 1;
        }),
      createIdentity: () => 'unacknowledged-disposal',
    });
    const session = await factory.open({
      connection: target.connection,
      serverAlias: 'windows.example.test',
      virtualProxyAlias: 'jwt',
      authMode: 'proxy-session',
      secret: { authMode: 'proxy-session', accessToken: 'header.payload.signature' },
    });
    const preview = await session.createSessionChart({
      target,
      plan,
      actor: MUTATOR_ACTOR,
      signal: new AbortController().signal,
    });

    await expect(session.disposeSessionChart(preview.sessionObjectId)).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    expect(closeCount).toBe(1);

    await session.close();
  });

  it('uses PFX auth and performs persistent root plus linked sheet-child lifecycle', async () => {
    const opened: OpenAppSessionProps[] = [];
    const destroyedObjects: string[] = [];
    const destroyedChildren: string[] = [];
    let childId: string | undefined;
    let childProperties: Record<string, unknown> | undefined;
    let parentProperties: Record<string, unknown> | undefined;
    let cleanupParentProperties: Record<string, unknown> | undefined;
    const rootProperties = {
      qInfo: { qId: 'root-object', qType: 'barchart' },
      qMetaDef: { title: 'Revenue by region' },
    };
    const child = objectFrom({
      get id() {
        return childId ?? '';
      },
      getProperties: async () => childProperties ?? {},
    });
    const root = objectFrom({
      id: 'root-object',
      getProperties: async () => rootProperties,
      getLayout: async () => ({
        qInfo: { qId: 'root-object', qType: 'barchart' },
        qHyperCube: { qSize: { qcx: 2, qcy: 1 }, qMode: 'S' },
      }),
    });
    const sheet = objectFrom({
      id: target.sheetId,
      getChildInfos: async () => (childId ? [{ qId: childId, qType: 'barchart' }] : []),
      getChild: async () => child,
      getProperties: async () =>
        parentProperties ?? {
          qInfo: { qId: target.sheetId, qType: 'sheet' },
          columns: 24,
          rows: 12,
          cells: [],
        },
      createChild: async (
        properties: Record<string, unknown>,
        propertiesForSheet?: Record<string, unknown>,
      ) => {
        childProperties = properties;
        parentProperties = propertiesForSheet;
        childId = (properties.qInfo as { qId: string }).qId;
        return child;
      },
      destroyChild: async (objectId: string, propertiesForSheet?: Record<string, unknown>) => {
        destroyedChildren.push(objectId);
        cleanupParentProperties = propertiesForSheet;
        childId = undefined;
        return true;
      },
    });
    const doc = docFrom({
      createObject: async () => root,
      getObject: async (objectId: string) => {
        if (objectId === target.sheetId) return sheet;
        return root;
      },
      destroyObject: async (objectId: string) => {
        destroyedObjects.push(objectId);
        return true;
      },
    });
    const secret = pfxSecret();
    const factory = new QlikWindowsEngineSessionFactory({
      openAppSession: (options) => {
        opened.push(options);
        return appSessionFrom(doc, () => undefined);
      },
      createIdentity: () => `write-${opened.length}`,
    });
    const session = await factory.open({
      connection: target.connection,
      serverAlias: 'windows.example.test',
      writeTarget: target,
      authMode: 'trusted-backend',
      secret,
    });

    const persisted = await session.persistChart({
      target,
      plan,
      actor: MUTATOR_ACTOR,
      idempotencyKey: 'idempotency-key',
    });
    const attached = await session.attachChartToSheet({ target, objectId: persisted.objectId });
    const visibleParentProperties = parentProperties;
    parentProperties = { ...visibleParentProperties, cells: [] };
    const missingCellVerification = await session.verifyChart({
      target,
      objectId: persisted.objectId,
    });
    parentProperties = visibleParentProperties;
    const verified = await session.verifyChart({ target, objectId: persisted.objectId });
    const cleaned = await session.cleanupObject({
      target,
      objectId: persisted.objectId,
      sheetAttachmentId: attached.sheetAttachmentId,
    });

    expect(persisted).toEqual({ objectId: 'root-object' });
    expect(childProperties).toMatchObject({
      qInfo: { qId: attached.sheetAttachmentId, qType: 'barchart' },
      qExtendsId: 'root-object',
    });
    expect(parentProperties).toMatchObject({
      cells: [
        {
          name: attached.sheetAttachmentId,
          type: 'barchart',
          col: 0,
          row: 0,
          colspan: 24,
          rowspan: 6,
        },
      ],
    });
    expect(missingCellVerification).toEqual({ verified: false });
    expect(verified).toEqual({ verified: true });
    expect(cleaned).toEqual({ attempted: true, outcome: 'cleanup-complete' });
    expect(destroyedChildren).toEqual([attached.sheetAttachmentId]);
    expect(cleanupParentProperties).toMatchObject({ cells: [] });
    expect(destroyedObjects).toEqual(['root-object']);
    const hostConfig = opened[0]?.hostConfig as HostConfig & { pfx: Uint8Array };
    expect(hostConfig).toMatchObject({
      authType: 'pfx',
      host: 'https://windows.example.test:4747',
      passphrase: 'passphrase',
      userHeader: 'UserDirectory=HARNESS;UserId=svc_windows',
    });
    expect([...hostConfig.pfx].some((byte) => byte !== 0)).toBe(true);

    await session.close();

    expect([...hostConfig.pfx].every((byte) => byte === 0)).toBe(true);
  });

  it('removes the just-added sheet cell when a child identifier mismatch is rolled back', async () => {
    const existingCell = {
      name: 'existing-object',
      type: 'kpi',
      col: 0,
      row: 0,
      colspan: 8,
      rowspan: 4,
    };
    const originalSheetProperties = {
      qInfo: { qId: target.sheetId, qType: 'sheet' },
      columns: 24,
      rows: 4,
      cells: [existingCell],
    };
    let createdParentProperties: Record<string, unknown> | undefined;
    let rollbackParentProperties: Record<string, unknown> | undefined;
    const destroyedChildren: string[] = [];
    const root = objectFrom({
      id: 'root-object',
      getProperties: async () => ({ qInfo: { qId: 'root-object', qType: 'barchart' } }),
    });
    const sheet = objectFrom({
      getChildInfos: async () => [],
      getProperties: async () => originalSheetProperties,
      createChild: async (
        _properties: Record<string, unknown>,
        propertiesForSheet?: Record<string, unknown>,
      ) => {
        createdParentProperties = propertiesForSheet;
        return objectFrom({ id: 'unexpected-child-id' });
      },
      destroyChild: async (objectId: string, propertiesForSheet?: Record<string, unknown>) => {
        destroyedChildren.push(objectId);
        rollbackParentProperties = propertiesForSheet;
        return true;
      },
    });
    const doc = docFrom({
      getObject: async (objectId: string) => (objectId === target.sheetId ? sheet : root),
    });
    const factory = new QlikWindowsEngineSessionFactory({
      openAppSession: () => appSessionFrom(doc, () => undefined),
    });
    const session = await factory.open({
      connection: target.connection,
      serverAlias: 'windows.example.test',
      writeTarget: target,
      authMode: 'trusted-backend',
      secret: pfxSecret(),
    });

    await expect(
      session.attachChartToSheet({ target, objectId: 'root-object' }),
    ).rejects.toMatchObject({ code: 'PARTIAL_APPLY' });
    expect(createdParentProperties).toMatchObject({
      rows: 10,
      cells: [existingCell, expect.objectContaining({ type: 'barchart', row: 4, rowspan: 6 })],
    });
    expect(destroyedChildren).toEqual(['unexpected-child-id']);
    expect(rollbackParentProperties).toEqual(originalSheetProperties);
  });

  it('reports cleanup failure when QIX does not acknowledge either deletion', async () => {
    const sheet = objectFrom({
      getProperties: async () => ({ cells: [] }),
      destroyChild: async () => false,
    });
    const doc = docFrom({
      getObject: async () => sheet,
      destroyObject: async () => false,
    });
    const factory = new QlikWindowsEngineSessionFactory({
      openAppSession: () => appSessionFrom(doc, () => undefined),
    });
    const session = await factory.open({
      connection: target.connection,
      serverAlias: 'windows.example.test',
      writeTarget: target,
      authMode: 'trusted-backend',
      secret: pfxSecret(),
    });

    await expect(
      session.cleanupObject({
        target,
        objectId: 'root-object',
        sheetAttachmentId: 'linked-child',
      }),
    ).resolves.toEqual({ attempted: true, outcome: 'cleanup-failed' });

    await session.close();
  });

  it('rejects authentication-mode mismatches before opening a WebSocket', async () => {
    let opens = 0;
    const factory = new QlikWindowsEngineSessionFactory({
      openAppSession: () => {
        opens += 1;
        throw new Error('must not open');
      },
    });

    await expect(
      factory.open({
        connection: target.connection,
        serverAlias: 'windows.example.test',
        virtualProxyAlias: 'jwt',
        authMode: 'proxy-session',
        secret: pfxSecret(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(opens).toBe(0);
  });
});
