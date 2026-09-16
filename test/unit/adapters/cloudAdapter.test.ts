import type { HostConfig } from '@qlik/api/auth';
import { describe, expect, it } from 'vitest';
import {
  CloudAdapter,
  type CloudAdapterConfig,
  type CloudReadinessEvidence,
} from '../../../src/adapters/cloud/cloudAdapter.js';
import type { CloudHostConfigFactory } from '../../../src/adapters/cloud/cloudOAuth.js';
import type {
  CloudAppPage,
  CloudCatalogSnapshot,
  CloudQlikClient,
  CloudSdkAppSession,
  CloudSheetObjectPage,
} from '../../../src/adapters/cloud/qlikApiCloudClient.js';
import { chartIntentSchema } from '../../../src/compiler/chartIntentSchema.js';
import { compileChartIntent } from '../../../src/compiler/compiler.js';
import type { ResolvedChartPlan } from '../../../src/domain/types.js';
import { MUTATOR_ACTOR } from '../../helpers/testContext.js';

const target = {
  connection: 'cloud-dev',
  appId: 'app-sales-cloud-dev',
  sheetId: 'sheet-sales-overview-cloud-dev',
};

const readiness: CloudReadinessEvidence = {
  approved: true,
  expiresAt: '2099-01-01T00:00:00.000Z',
  canRead: true,
  canPreview: true,
  canWriteDesignatedSheet: true,
  cleanupVerified: true,
};

const baseConfig: CloudAdapterConfig = {
  connection: target.connection,
  tenantHost: 'https://tenant.example.qlikcloud.com',
  oauthClientId: 'public-client-id',
  environment: 'development',
  writeTarget: target,
  readiness,
};

const hostConfig = {
  host: 'https://tenant.example.qlikcloud.com',
  authType: 'oauth2',
  clientId: 'public-client-id',
  noCache: true,
  getAccessToken: async () => 'test-token',
} satisfies HostConfig;

const plan: ResolvedChartPlan = {
  planHash: 'sha256:cloud-plan',
  compilerVersion: 'test',
  intentVersion: 'test',
  catalogId: 'catalog',
  target,
  platform: 'cloud',
  chartType: 'bar',
  nativeChartType: 'barchart',
  resolved: {
    dimensions: [{ catalogId: 'region', label: 'Region', role: 'dimension', semanticType: 'text' }],
    measures: [
      {
        catalogId: 'revenue',
        label: 'Revenue',
        role: 'measure',
        semanticType: 'numeric',
        expression: 'Sum(Revenue)',
      },
    ],
    filters: [],
  },
  title: 'Revenue by region',
  sort: 'measure-descending',
  resultLimit: 25,
  riskClass: 'standard',
  warnings: [],
  diff: { summary: 'create chart', additions: [], removals: [] },
  propertyProposal: {
    qInfo: { qId: 'compiled-id', qType: 'barchart' },
    qHyperCubeDef: { qInitialDataFetch: [{ qHeight: 1_000, qWidth: 1_000 }] },
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const snapshot: CloudCatalogSnapshot = {
  fields: [
    {
      name: 'Region',
      cardinal: 5,
      tags: ['$text'],
      hidden: false,
      system: false,
      definitionOnly: false,
      implicitMeasure: false,
    },
    {
      name: 'Revenue',
      tags: ['$numeric', '$money'],
      hidden: false,
      system: false,
      definitionOnly: false,
      implicitMeasure: false,
    },
    {
      name: 'SecretField',
      tags: ['$text'],
      hidden: true,
      system: false,
      definitionOnly: false,
      implicitMeasure: false,
    },
    {
      name: 'VisibleButSensitive',
      tags: ['$numeric', 'sensitive'],
      hidden: false,
      system: false,
      definitionOnly: false,
      implicitMeasure: true,
    },
  ],
  masterItems: [
    { id: 'master-region', title: 'Master Region', kind: 'dimension', tags: ['$text'] },
    { id: 'master-revenue', title: 'Master Revenue', kind: 'measure', tags: [] },
    { id: 'master-secret', title: 'Secret Master', kind: 'measure', tags: ['$restricted'] },
    { id: 'master-hidden', title: 'Hidden Master', kind: 'dimension', tags: ['$hidden'] },
    { id: 'master-internal', title: 'Internal Master', kind: 'dimension', tags: ['$internal'] },
    { id: 'master-system', title: 'System Master', kind: 'dimension', tags: ['$system'] },
  ],
  sheets: [
    { id: target.sheetId, title: 'Sales overview' },
    { id: 'sheet-read-only', title: 'Read only' },
  ],
};

function evaluatedLayout(objectId: string) {
  return {
    qInfo: { qId: objectId, qType: 'barchart' },
    qMeta: { title: 'Revenue by region' },
    qHyperCube: {
      qSize: { qcx: 2, qcy: 2 },
      qMode: 'S',
      qDimensionInfo: [{ qFallbackTitle: 'Region', qCardinal: 5 }],
      qMeasureInfo: [{ qFallbackTitle: 'Revenue' }],
      qDataPages: [
        {
          qMatrix: [
            [
              { qText: 'East', qNum: Number.NaN },
              { qText: '$12', qNum: 12 },
            ],
            [
              { qText: 'West', qNum: Number.NaN },
              { qText: '$9', qNum: 9 },
            ],
          ],
        },
      ],
    },
  };
}

class FakeSession implements CloudSdkAppSession {
  closeCount = 0;
  saveCount = 0;
  readonly destroyedSessionObjects: string[] = [];
  readonly sessionObjectCreateCalls: Readonly<Record<string, unknown>>[] = [];
  readonly childCreateCalls: Array<{
    readonly sheetId: string;
    readonly properties: Readonly<Record<string, unknown>>;
  }> = [];
  readonly destroyedChildren: Array<{ readonly sheetId: string; readonly objectId: string }> = [];
  sessionObjectId = 'session-object-1';
  persistentObjectId = 'persistent-object-1';
  isChild = true;
  hasCell = true;
  destroySessionResult = true;
  destroyChildResult = true;
  saveFailuresRemaining = 0;
  createHook: (() => void) | undefined;
  createdLayout: unknown;
  verificationProperties: unknown;
  verificationLayout: unknown;

  constructor(
    readonly catalog: CloudCatalogSnapshot = snapshot,
    readonly objectPage: CloudSheetObjectPage = { objects: [], total: 0 },
  ) {}

  async getCatalogSnapshot(): Promise<CloudCatalogSnapshot> {
    return this.catalog;
  }

  async listSheetObjects(
    _sheetId: string,
    offset: number,
    limit: number,
  ): Promise<CloudSheetObjectPage> {
    return {
      objects: this.objectPage.objects.slice(offset, offset + limit),
      total: this.objectPage.total,
    };
  }

  async createSessionObject(properties: Readonly<Record<string, unknown>>) {
    this.createHook?.();
    this.sessionObjectCreateCalls.push(properties);
    const cube = properties.qHyperCubeDef as {
      qMode?: string;
      qInitialDataFetch?: Array<Record<string, number>>;
    };
    expect(cube.qInitialDataFetch).toEqual([
      { qTop: 0, qLeft: 0, qHeight: 25, qWidth: cube.qMode === 'K' ? 30 : 2 },
    ]);
    return {
      objectId: this.sessionObjectId,
      layout: this.createdLayout ?? evaluatedLayout(this.sessionObjectId),
    };
  }

  async destroySessionObject(objectId: string): Promise<boolean> {
    this.destroyedSessionObjects.push(objectId);
    return this.destroySessionResult;
  }

  async createChildObject(
    sheetId: string,
    properties: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    this.childCreateCalls.push({ sheetId, properties });
    return this.persistentObjectId;
  }

  async isSheetChild(_sheetId: string, _objectId: string): Promise<boolean> {
    return this.isChild;
  }

  async hasSheetCell(_sheetId: string, _objectId: string): Promise<boolean> {
    return this.hasCell;
  }

  async getObjectLayout(objectId: string): Promise<unknown> {
    return this.verificationLayout ?? evaluatedLayout(objectId);
  }

  async getObjectProperties(objectId: string): Promise<unknown> {
    return (
      this.verificationProperties ?? {
        qInfo: { qId: objectId, qType: 'barchart' },
        qHyperCubeDef: { qColumnOrder: [0, 1], qInterColumnSortOrder: [1, 0] },
      }
    );
  }

  async destroyChildObject(sheetId: string, objectId: string): Promise<boolean> {
    this.destroyedChildren.push({ sheetId, objectId });
    this.hasCell = false;
    return this.destroyChildResult;
  }

  async save(): Promise<void> {
    this.saveCount += 1;
    if (this.saveFailuresRemaining > 0) {
      this.saveFailuresRemaining -= 1;
      throw new Error('raw provider save failure');
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class FakeCloudClient implements CloudQlikClient {
  readonly openCalls: Array<{ readonly appId: string; readonly identity: string }> = [];
  readonly appListCalls: Array<{ readonly limit: number; readonly cursor?: string }> = [];
  appPage: CloudAppPage = { apps: [] };
  appListError: unknown;

  constructor(private readonly sessions: FakeSession[] = []) {}

  async listApps(
    _hostConfig: HostConfig,
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<CloudAppPage> {
    this.appListCalls.push(page);
    if (this.appListError) throw this.appListError;
    return this.appPage;
  }

  async openAppSession(options: {
    readonly hostConfig: HostConfig;
    readonly appId: string;
    readonly identity: string;
  }): Promise<CloudSdkAppSession> {
    this.openCalls.push({ appId: options.appId, identity: options.identity });
    const session = this.sessions.shift();
    if (!session) throw new Error('No fake QIX session was queued.');
    return session;
  }
}

const hostConfigs: CloudHostConfigFactory = {
  async getHostConfig() {
    return hostConfig;
  },
};

function adapterFor(
  client: FakeCloudClient,
  config: CloudAdapterConfig = baseConfig,
  now: () => Date = () => new Date('2026-01-01T00:00:00.000Z'),
) {
  return new CloudAdapter(config, {
    hostConfigs,
    qlik: client,
    now,
    identityFactory: () => 'test-session-identity',
  });
}

describe('CloudAdapter', () => {
  it('keeps capabilities false until dependencies and unexpired admin evidence are present', async () => {
    await expect(
      new CloudAdapter(baseConfig).getEnvironmentCapabilities(target.connection),
    ).resolves.toMatchObject({ configured: false, canRead: false, canPreview: false });

    const configured = adapterFor(new FakeCloudClient());
    await expect(configured.getEnvironmentCapabilities(target.connection)).resolves.toMatchObject({
      configured: true,
      canRead: true,
      canPreview: true,
      canWriteDesignatedSheet: true,
      cleanupVerified: true,
    });

    const expired = adapterFor(
      new FakeCloudClient(),
      { ...baseConfig, readiness: { ...readiness, expiresAt: '2025-01-01T00:00:00.000Z' } },
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
    await expect(expired.getEnvironmentCapabilities(target.connection)).resolves.toMatchObject({
      configured: false,
      canRead: false,
    });
  });

  it('uses REST cursor pagination and maps only bounded app summaries', async () => {
    const client = new FakeCloudClient();
    client.appPage = {
      apps: [
        { appId: 'app-1', name: 'One' },
        { appId: 'app-2', name: 'Two' },
        { appId: 'app-3', name: 'Three' },
      ],
      nextPageToken: 'next-cursor',
    };
    const result = await adapterFor(client).listAccessibleApps(target.connection, MUTATOR_ACTOR, {
      pageSize: 2,
      pageToken: 'current-cursor',
    });

    expect(client.appListCalls).toEqual([{ limit: 2, cursor: 'current-cursor' }]);
    expect(result).toEqual({
      apps: [
        {
          appId: 'app-1',
          name: 'One',
          connection: target.connection,
          platform: 'cloud',
          environment: 'development',
        },
        {
          appId: 'app-2',
          name: 'Two',
          connection: target.connection,
          platform: 'cloud',
          environment: 'development',
        },
      ],
      truncated: true,
      nextPageToken: 'next-cursor',
    });
  });

  it('maps the visible semantic catalog, write target, and a stable catalog page token', async () => {
    const compilationSession = new FakeSession();
    const firstPageSession = new FakeSession();
    const secondPageSession = new FakeSession();
    const adapter = adapterFor(
      new FakeCloudClient([compilationSession, firstPageSession, secondPageSession]),
    );

    const context = await adapter.getCompilationContext(
      target.connection,
      target.appId,
      MUTATOR_ACTOR,
    );
    expect(context.catalog.fields.map((field) => [field.label, field.role])).toEqual([
      ['Region', 'dimension'],
      ['Revenue', 'dimension'],
    ]);
    expect(context.catalog.fields.some((field) => field.label === 'SecretField')).toBe(false);
    expect(context.catalog.fields.some((field) => field.label === 'VisibleButSensitive')).toBe(
      false,
    );
    expect(context.catalog.masterItems.map((item) => [item.label, item.kind])).toEqual([
      ['Master Region', 'dimension'],
      ['Master Revenue', 'measure'],
    ]);
    expect(context.catalog.masterItems.map((item) => item.id)).toEqual([
      'master-region',
      'master-revenue',
    ]);
    expect(context.sheets).toEqual([
      { sheetId: target.sheetId, name: 'Sales overview', writeAllowed: true },
      { sheetId: 'sheet-read-only', name: 'Read only', writeAllowed: false },
    ]);

    const first = await adapter.getSemanticCatalog(
      target.connection,
      target.appId,
      MUTATOR_ACTOR,
      'default',
      { pageSize: 2 },
    );
    expect(first.dimensions.map((field) => field.label)).toEqual(['Region', 'Revenue']);
    expect(first.measures).toEqual([]);
    expect(first).toMatchObject({ truncated: true, nextPageToken: 'catalog:2' });

    const second = await adapter.getSemanticCatalog(
      target.connection,
      target.appId,
      MUTATOR_ACTOR,
      'default',
      { pageSize: 2, pageToken: first.nextPageToken },
    );
    expect(second.masterItems.map((item) => item.label)).toEqual([
      'Master Region',
      'Master Revenue',
    ]);
    expect(compilationSession.closeCount).toBe(1);
    expect(firstPageSession.closeCount).toBe(1);
    expect(secondPageSession.closeCount).toBe(1);
  });

  it('normalizes native field tags for semantic types without promoting raw numerics', async () => {
    const semanticSnapshot: CloudCatalogSnapshot = {
      fields: [
        {
          name: 'OrderDate',
          cardinal: 10,
          tags: ['$date'],
          hidden: false,
          system: false,
          definitionOnly: false,
          implicitMeasure: false,
        },
        {
          name: 'CreatedAt',
          tags: ['$timestamp'],
          hidden: false,
          system: false,
          definitionOnly: false,
          implicitMeasure: false,
        },
        {
          name: 'ClockTime',
          tags: ['$time'],
          hidden: false,
          system: false,
          definitionOnly: false,
          implicitMeasure: false,
        },
        {
          name: 'Amount',
          tags: ['$numeric'],
          hidden: false,
          system: false,
          definitionOnly: false,
          implicitMeasure: false,
        },
        {
          name: 'ImplicitAmount',
          tags: ['$numeric'],
          hidden: false,
          system: false,
          definitionOnly: false,
          implicitMeasure: true,
        },
        {
          name: 'CustomerKey',
          tags: ['$key'],
          hidden: false,
          system: false,
          definitionOnly: false,
          implicitMeasure: false,
        },
      ],
      masterItems: [],
      sheets: [],
    };
    const session = new FakeSession(semanticSnapshot);

    const context = await adapterFor(new FakeCloudClient([session])).getCompilationContext(
      target.connection,
      target.appId,
      MUTATOR_ACTOR,
    );

    expect(
      context.catalog.fields.map(({ label, role, semanticType }) => ({
        label,
        role,
        semanticType,
      })),
    ).toEqual([
      { label: 'OrderDate', role: 'dimension', semanticType: 'date' },
      { label: 'CreatedAt', role: 'dimension', semanticType: 'timestamp' },
      { label: 'ClockTime', role: 'dimension', semanticType: 'time' },
      { label: 'Amount', role: 'dimension', semanticType: 'numeric' },
      { label: 'ImplicitAmount', role: 'measure', semanticType: 'numeric' },
      { label: 'CustomerKey', role: 'dimension', semanticType: 'identifier' },
    ]);
  });

  it('preserves native master-item IDs through compilation into qLibraryId', async () => {
    const nativeDimensionId = 'native-cloud-dimension-id';
    const nativeMeasureId = 'native-cloud-measure-id';
    const nativeMasterSnapshot: CloudCatalogSnapshot = {
      fields: [],
      masterItems: [
        {
          id: nativeDimensionId,
          title: 'Native Region',
          kind: 'dimension',
          tags: ['$text'],
        },
        {
          id: nativeMeasureId,
          title: 'Native Revenue',
          kind: 'measure',
          tags: ['$numeric'],
        },
      ],
      sheets: [{ id: target.sheetId, title: 'Sales overview' }],
    };
    const context = await adapterFor(
      new FakeCloudClient([new FakeSession(nativeMasterSnapshot)]),
    ).getCompilationContext(target.connection, target.appId, MUTATOR_ACTOR);
    const intent = chartIntentSchema.parse({
      analysis: { dimensions: ['Native Region'], measures: ['Native Revenue'] },
      presentation: { preferredChartType: 'bar', title: 'Native master items' },
    });

    const compiled = compileChartIntent({
      catalog: context.catalog,
      target,
      platform: 'cloud',
      intent,
    });

    expect(context.catalog.masterItems.map((item) => item.id)).toEqual([
      nativeDimensionId,
      nativeMeasureId,
    ]);
    expect(compiled.propertyProposal).toMatchObject({
      qHyperCubeDef: {
        qDimensions: [{ qLibraryId: nativeDimensionId }],
        qMeasures: [{ qLibraryId: nativeMeasureId }],
      },
    });
  });

  it('rejects synthetic catalog variants before opening a live QIX session', async () => {
    const client = new FakeCloudClient();
    const adapter = adapterFor(client);

    await expect(
      adapter.getCompilationContext(target.connection, target.appId, MUTATOR_ACTOR, 'empty'),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    await expect(
      adapter.getSemanticCatalog(target.connection, target.appId, MUTATOR_ACTOR, 'empty'),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(client.openCalls).toHaveLength(0);
  });

  it('paginates native sheet-child mappings', async () => {
    const session = new FakeSession(snapshot, {
      objects: [
        { id: 'object-1', type: 'barchart', title: 'One' },
        { id: 'object-2', type: 'kpi', title: 'Two' },
        { id: 'object-3', type: 'table', title: 'Three' },
      ],
      total: 3,
    });
    const result = await adapterFor(new FakeCloudClient([session])).listSheetObjects(
      target.connection,
      target.appId,
      target.sheetId,
      MUTATOR_ACTOR,
      { pageSize: 2 },
    );
    expect(result).toEqual({
      objects: [
        { objectId: 'object-1', type: 'barchart', title: 'One' },
        { objectId: 'object-2', type: 'kpi', title: 'Two' },
      ],
      truncated: true,
      nextPageToken: 'sheet:2',
    });
  });

  it('keeps a preview object and its disposal on the exact same QIX app session', async () => {
    const session = new FakeSession();
    const client = new FakeCloudClient([session]);
    const adapter = adapterFor(client);
    const controller = new AbortController();

    const result = await adapter.createSessionChart({
      target,
      plan,
      actor: MUTATOR_ACTOR,
      signal: controller.signal,
    });
    expect(result.sessionObjectId).toBe('session-object-1');
    expect(result.layout.bounded).toEqual({
      returnedRows: 2,
      maxRows: 25,
      truncated: false,
      rawDataIncluded: false,
    });
    expect(session.closeCount).toBe(0);

    await adapter.disposeSessionChart(target.connection, result.sessionObjectId);
    await adapter.disposeSessionChart(target.connection, result.sessionObjectId);
    expect(client.openCalls).toHaveLength(1);
    expect(session.destroyedSessionObjects).toEqual(['session-object-1']);
    expect(session.closeCount).toBe(1);
  });

  it('normalizes bounded stacked treemap pages into privacy-safe preview rows', async () => {
    const session = new FakeSession();
    session.createdLayout = {
      qInfo: { qId: session.sessionObjectId, qType: 'treemap' },
      qMeta: { title: 'Revenue treemap' },
      qHyperCube: {
        qSize: { qcx: 1, qcy: 2 },
        qMode: 'K',
        qDimensionInfo: [{ qFallbackTitle: 'Region', qCardinal: 2 }],
        qMeasureInfo: [{ qFallbackTitle: 'Revenue' }],
        qStackedDataPages: [
          {
            qData: [
              {
                qType: 'R',
                qSubNodes: [
                  {
                    qType: 'N',
                    qText: 'East',
                    qSubNodes: [{ qType: 'V', qText: '$12', qValue: 12 }],
                  },
                  {
                    qType: 'N',
                    qText: 'West',
                    qSubNodes: [{ qType: 'V', qText: '$9', qValue: 9 }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const treemapPlan: ResolvedChartPlan = {
      ...plan,
      chartType: 'treemap',
      nativeChartType: 'treemap',
      title: 'Revenue treemap',
      propertyProposal: {
        ...plan.propertyProposal,
        qInfo: { qId: 'compiled-treemap-id', qType: 'treemap' },
        qHyperCubeDef: { qMode: 'K' },
      },
    };
    const adapter = adapterFor(new FakeCloudClient([session]));

    const created = await adapter.createSessionChart({
      target,
      plan: treemapPlan,
      actor: MUTATOR_ACTOR,
      signal: new AbortController().signal,
    });

    expect(created.layout.qHyperCube).toMatchObject({
      qMode: 'K',
      qDataPages: [
        {
          qMatrix: [
            [{ qText: 'East' }, { qText: '$12', qNum: 12 }],
            [{ qText: 'West' }, { qText: '$9', qNum: 9 }],
          ],
        },
      ],
    });
    expect(created.layout.bounded).toMatchObject({ returnedRows: 2, rawDataIncluded: false });
    await adapter.disposeSessionChart(target.connection, created.sessionObjectId);
  });

  it('preserves the versioned sn-table contract for preview and persistence', async () => {
    const propertyProposal = {
      qInfo: { qId: 'compiled-table-id', qType: 'sn-table' },
      version: '6.51.0',
      qHyperCubeDef: {
        qDimensions: [{ qDef: { qFieldDefs: ['Region'] } }],
        qMeasures: [{ qDef: { qDef: 'Sum(Revenue)' } }],
        qColumnOrder: [0, 1],
        qInterColumnSortOrder: [1, 0],
        qInitialDataFetch: [{ qTop: 0, qLeft: 0, qHeight: 25, qWidth: 2 }],
      },
      showTitles: true,
      enableChartExploration: false,
      title: 'Revenue table',
      subtitle: '',
      footnote: '',
      totals: { label: 'Totals', show: true, position: 'noTotals' },
      usePagination: false,
      components: [],
    };
    const tablePlan: ResolvedChartPlan = {
      ...plan,
      chartType: 'table',
      nativeChartType: 'sn-table',
      visualizationSchemaProfile: 'qlik-cloud-current',
      visualizationSchemaVersion: '6.51.0',
      propertyProposal,
    };
    const previewSession = new FakeSession();
    previewSession.createdLayout = {
      ...evaluatedLayout(previewSession.sessionObjectId),
      qInfo: { qId: previewSession.sessionObjectId, qType: 'sn-table' },
      visualization: 'sn-table',
    };
    const persistenceSession = new FakeSession();
    const adapter = adapterFor(new FakeCloudClient([previewSession, persistenceSession]));
    const preview = await adapter.createSessionChart({
      target,
      plan: tablePlan,
      actor: MUTATOR_ACTOR,
      signal: new AbortController().signal,
    });
    await adapter.persistChart({
      target,
      plan: tablePlan,
      actor: MUTATOR_ACTOR,
      idempotencyKey: 'sn-table-contract',
    });

    for (const properties of [
      previewSession.sessionObjectCreateCalls[0],
      persistenceSession.childCreateCalls[0]?.properties,
    ]) {
      expect(properties).toMatchObject({
        qInfo: { qType: 'sn-table' },
        version: '6.51.0',
        qHyperCubeDef: {
          qColumnOrder: [0, 1],
          qInterColumnSortOrder: [1, 0],
        },
      });
      expect(properties).not.toHaveProperty('sorting');
    }
    await adapter.disposeSessionChart(target.connection, preview.sessionObjectId);
  });

  it('destroys an object and closes its owning QIX session when cancellation wins creation', async () => {
    const controller = new AbortController();
    const session = new FakeSession();
    session.createHook = () => controller.abort();
    const adapter = adapterFor(new FakeCloudClient([session]));

    await expect(
      adapter.createSessionChart({
        target,
        plan,
        actor: MUTATOR_ACTOR,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(session.destroyedSessionObjects).toEqual(['session-object-1']);
    expect(session.closeCount).toBe(1);
  });

  it('creates a persistent native sheet child, verifies it, and removes that child', async () => {
    const createSession = new FakeSession();
    const attachSession = new FakeSession();
    const verifySession = new FakeSession();
    const cleanupSession = new FakeSession();
    const adapter = adapterFor(
      new FakeCloudClient([createSession, attachSession, verifySession, cleanupSession]),
    );

    const persisted = await adapter.persistChart({
      target,
      plan,
      actor: MUTATOR_ACTOR,
      idempotencyKey: 'idempotency-key',
    });
    expect(persisted).toEqual({ objectId: 'persistent-object-1' });
    expect(createSession.childCreateCalls[0]?.sheetId).toBe(target.sheetId);
    expect(createSession.saveCount).toBe(1);

    await expect(
      adapter.attachChartToSheet({ target, objectId: persisted.objectId }),
    ).resolves.toEqual({ sheetAttachmentId: persisted.objectId });
    await expect(adapter.verifyChart({ target, objectId: persisted.objectId })).resolves.toEqual({
      verified: true,
    });
    await expect(
      adapter.cleanupObject({
        target,
        objectId: persisted.objectId,
        sheetAttachmentId: persisted.objectId,
      }),
    ).resolves.toEqual({ attempted: true, outcome: 'cleanup-complete' });
    expect(cleanupSession.destroyedChildren).toEqual([
      { sheetId: target.sheetId, objectId: 'persistent-object-1' },
    ]);
    expect(cleanupSession.hasCell).toBe(false);
    expect(cleanupSession.saveCount).toBe(1);
  });

  it('returns a bounded, data-free visualization contract snapshot', async () => {
    const session = new FakeSession();
    session.verificationProperties = {
      qInfo: { qId: 'persistent-object-1', qType: 'sn-table' },
      version: '6.51.0',
      qHyperCubeDef: {
        qDimensions: [{ qDef: { qFieldDefs: ['Sensitive field name'] } }],
        qMeasures: [{ qDef: { qDef: 'Sum(Sensitive value)' } }],
        qColumnOrder: [0, 1],
        qInterColumnSortOrder: [1, 0],
      },
    };
    session.verificationLayout = {
      qInfo: { qId: 'persistent-object-1', qType: 'sn-table' },
      visualization: 'sn-table',
      qHyperCube: {
        qSize: { qcx: 2, qcy: 1 },
        qDimensionInfo: [{ qFallbackTitle: 'Sensitive field name' }],
        qMeasureInfo: [{ qFallbackTitle: 'Sensitive measure name' }],
        qDataPages: {
          unexpected: 'not-an-array',
        },
      },
    };
    const adapter = adapterFor(new FakeCloudClient([session]));

    await expect(
      adapter.inspectVisualizationContract(target.connection, target.appId, 'persistent-object-1'),
    ).resolves.toEqual({
      objectId: 'persistent-object-1',
      propertyType: 'sn-table',
      propertyVersion: '6.51.0',
      hasRootSorting: false,
      qColumnOrder: [0, 1],
      qInterColumnSortOrder: [1, 0],
      propertyDimensionCount: 1,
      propertyMeasureCount: 1,
      layoutType: 'sn-table',
      layoutVisualization: 'sn-table',
      layoutDimensionInfoCount: 1,
      layoutMeasureInfoCount: 1,
      cubeColumnCount: 2,
      cubeRowCount: 1,
      firstPageRowCount: 0,
      fullWidthRowCount: 0,
      usableMeasureRowCount: 0,
      hasLayoutError: false,
    });
  });

  it('summarizes persisted evaluated rows without returning labels, expressions, or values', async () => {
    const session = new FakeSession();
    session.verificationProperties = {
      qInfo: { qId: 'persistent-object-1', qType: 'barchart' },
      version: '2.7.0',
      qHyperCubeDef: {
        qDimensions: [{ qDef: { qFieldDefs: ['Sensitive Region'] } }],
        qMeasures: [{ qDef: { qDef: 'Sum([Sensitive Revenue])' } }],
      },
    };
    session.verificationLayout = {
      qInfo: { qId: 'persistent-object-1', qType: 'barchart' },
      visualization: 'barchart',
      qHyperCube: {
        qSize: { qcx: 2, qcy: 2 },
        qDimensionInfo: [{ qFallbackTitle: 'Sensitive Region' }],
        qMeasureInfo: [{ qFallbackTitle: 'Sensitive Revenue' }],
        qDataPages: [
          {
            qMatrix: [
              [{ qText: 'North' }, { qText: '$12', qNum: 12 }],
              [{ qText: 'South' }, { qText: '$9', qNum: 9 }],
            ],
          },
        ],
      },
    };
    const adapter = adapterFor(new FakeCloudClient([session]));

    const contract = await adapter.inspectVisualizationContract(
      target.connection,
      target.appId,
      'persistent-object-1',
    );

    expect(contract).toMatchObject({
      propertyType: 'barchart',
      propertyVersion: '2.7.0',
      propertyDimensionCount: 1,
      propertyMeasureCount: 1,
      layoutDimensionInfoCount: 1,
      layoutMeasureInfoCount: 1,
      cubeColumnCount: 2,
      cubeRowCount: 2,
      firstPageRowCount: 2,
      fullWidthRowCount: 2,
      usableMeasureRowCount: 2,
      hasLayoutError: false,
    });
    expect(JSON.stringify(contract)).not.toMatch(/Sensitive|North|South|Revenue|qMatrix/);
  });

  it('rolls back the child and cell locally when the first persistent save fails', async () => {
    const createSession = new FakeSession();
    createSession.saveFailuresRemaining = 1;
    const adapter = adapterFor(new FakeCloudClient([createSession]));

    const failure = adapter.persistChart({
      target,
      plan,
      actor: MUTATOR_ACTOR,
      idempotencyKey: 'idempotency-key',
    });

    await expect(failure).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
      message: 'The Qlik Cloud operation failed; sensitive transport details were removed.',
    });
    await expect(failure).rejects.not.toThrow('provider save failure');
    expect(createSession.destroyedChildren).toEqual([
      { sheetId: target.sheetId, objectId: createSession.persistentObjectId },
    ]);
    expect(createSession.hasCell).toBe(false);
    expect(createSession.saveCount).toBe(2);
    expect(createSession.closeCount).toBe(1);
  });

  it('rejects child membership without a matching visible sheet cell', async () => {
    const attachSession = new FakeSession();
    attachSession.isChild = true;
    attachSession.hasCell = false;
    const verifySession = new FakeSession();
    verifySession.isChild = true;
    verifySession.hasCell = false;
    const adapter = adapterFor(new FakeCloudClient([attachSession, verifySession]));

    await expect(
      adapter.attachChartToSheet({ target, objectId: 'persistent-object-1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(adapter.verifyChart({ target, objectId: 'persistent-object-1' })).resolves.toEqual(
      { verified: false },
    );
  });

  it('accepts only the exact child and visible-cell placement together', async () => {
    const attachSession = new FakeSession();
    attachSession.isChild = true;
    attachSession.hasCell = true;
    const verifySession = new FakeSession();
    verifySession.isChild = true;
    verifySession.hasCell = true;
    const adapter = adapterFor(new FakeCloudClient([attachSession, verifySession]));

    await expect(
      adapter.attachChartToSheet({ target, objectId: 'persistent-object-1' }),
    ).resolves.toEqual({ sheetAttachmentId: 'persistent-object-1' });
    await expect(adapter.verifyChart({ target, objectId: 'persistent-object-1' })).resolves.toEqual(
      { verified: true },
    );
  });

  it('rejects incomplete preview and verification layouts instead of synthesizing success', async () => {
    const previewSession = new FakeSession();
    previewSession.createdLayout = { qInfo: { qId: previewSession.sessionObjectId } };
    const verificationSession = new FakeSession();
    verificationSession.verificationLayout = {
      qInfo: { qId: verificationSession.persistentObjectId, qType: 'barchart' },
    };
    const adapter = adapterFor(new FakeCloudClient([previewSession, verificationSession]));

    await expect(
      adapter.createSessionChart({
        target,
        plan,
        actor: MUTATOR_ACTOR,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'TRANSIENT_UNAVAILABLE' });
    expect(previewSession.destroyedSessionObjects).toEqual([previewSession.sessionObjectId]);
    await expect(
      adapter.verifyChart({ target, objectId: verificationSession.persistentObjectId }),
    ).resolves.toEqual({ verified: false });
  });

  it('rejects a non-designated mutation before opening a QIX session', async () => {
    const client = new FakeCloudClient([new FakeSession()]);
    const adapter = adapterFor(client);
    await expect(
      adapter.persistChart({
        target: { ...target, sheetId: 'another-sheet' },
        plan,
        actor: MUTATOR_ACTOR,
        idempotencyKey: 'idempotency-key',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(client.openCalls).toHaveLength(0);
  });

  it('maps raw SDK failures to sanitized typed errors', async () => {
    const client = new FakeCloudClient();
    client.appListError = {
      status: 429,
      data: { errors: [{ detail: 'raw tenant response that must not escape' }] },
    };
    await expect(
      adapterFor(client).listAccessibleApps(target.connection, MUTATOR_ACTOR),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', category: 'rate-limit' });
  });

  it.each([
    [2, 'NOT_FOUND'],
    [5, 'PERMISSION_DENIED'],
    [19, 'CAPACITY_EXHAUSTED'],
    [22001, 'OPERATION_CANCELLED'],
  ])(
    'maps numeric Cloud QIX error code %i to %s without provider details',
    async (code, expected) => {
      const client = new FakeCloudClient();
      client.appListError = { code, message: 'raw provider secret and tenant detail' };

      const failure = adapterFor(client).listAccessibleApps(target.connection, MUTATOR_ACTOR);
      await expect(failure).rejects.toMatchObject({
        code: expected,
        message: 'The Qlik Cloud operation failed; sensitive transport details were removed.',
      });
      await expect(failure).rejects.not.toThrow('provider secret');
    },
  );

  it('allows designated cleanup after readiness expires mid-operation', async () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const cleanupSession = new FakeSession();
    const adapter = adapterFor(new FakeCloudClient([cleanupSession]), baseConfig, () => current);
    current = new Date('2100-01-01T00:00:00.000Z');

    await expect(
      adapter.cleanupObject({
        target,
        objectId: 'persistent-object-1',
        sheetAttachmentId: 'persistent-object-1',
      }),
    ).resolves.toEqual({ attempted: true, outcome: 'cleanup-complete' });
  });
});
