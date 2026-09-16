import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { HostConfig } from '@qlik/api/auth';
import type { CloudRestManagementOptions } from '../../../src/management/cloudRestProvider.js';
import type * as RestProviderModule from '../../../src/management/cloudRestProvider.js';
import type { CloudEngineManagementOptions } from '../../../src/management/cloudEngineProvider.js';
import type * as EngineProviderModule from '../../../src/management/cloudEngineProvider.js';
import { ENGINE_ACTION_SCHEMAS } from '../../../src/management/cloudEngineProvider.js';
import { REST_ACTION_SCHEMAS } from '../../../src/management/restContracts.js';
import { buildManagementContext } from '../../../src/management/context.js';
import { MemoryManagementStore } from '../../../src/management/state.js';
import { createError } from '../../../src/domain/errors.js';
import { buildTestService, CLOUD_DEV } from '../../helpers/testContext.js';

const provider = vi.hoisted(() => ({
  restConstructor: vi.fn<(options: unknown) => void>(),
  engineConstructor: vi.fn<(...options: unknown[]) => void>(),
  inspect:
    vi.fn<(action: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
  execute:
    vi.fn<
      (
        action: string,
        input: Record<string, unknown>,
        onReceipt?: (record: Record<string, unknown>) => Promise<void>,
      ) => Promise<Record<string, unknown>>
    >(),
  resumeExport:
    vi.fn<
      (
        input: { connection: string; appId: string },
        receipt: { appId: string; exportId: string },
      ) => Promise<Record<string, unknown>>
    >(),
  verify:
    vi.fn<
      (
        action: string,
        input: Record<string, unknown>,
        result: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>
    >(),
  engineExecute:
    vi.fn<(action: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>>(),
  engineVerify:
    vi.fn<
      (
        action: string,
        input: Record<string, unknown>,
        result: Record<string, unknown>,
      ) => Promise<boolean>
    >(),
}));

vi.mock('../../../src/management/cloudRestProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RestProviderModule>();
  return {
    ...actual,
    CloudRestManagementProvider: class {
      constructor(options: unknown) {
        provider.restConstructor(options);
      }
      inspect(action: string, input: Record<string, unknown>) {
        return provider.inspect(action, input);
      }
      execute(
        action: string,
        input: Record<string, unknown>,
        onReceipt?: (record: Record<string, unknown>) => Promise<void>,
      ) {
        return onReceipt
          ? provider.execute(action, input, onReceipt)
          : provider.execute(action, input);
      }
      resumeExport(
        input: { connection: string; appId: string },
        receipt: { appId: string; exportId: string },
      ) {
        return provider.resumeExport(input, receipt);
      }
      verify(action: string, input: Record<string, unknown>, result: Record<string, unknown>) {
        return provider.verify(action, input, result);
      }
    },
  };
});

vi.mock('../../../src/management/cloudEngineProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EngineProviderModule>();
  return {
    ...actual,
    CloudEngineManagementProvider: class {
      constructor(...options: unknown[]) {
        provider.engineConstructor(...options);
      }
      execute(action: string, input: Record<string, unknown>) {
        return provider.engineExecute(action, input);
      }
      verify(action: string, input: Record<string, unknown>, result: Record<string, unknown>) {
        return provider.engineVerify(action, input, result);
      }
    },
  };
});

const CONNECTION = CLOUD_DEV.connection;
const APP = CLOUD_DEV.appId;
const SPACE = 'space-allowed';
const SPACE_NAME = 'Trial Finance';
const FOREIGN = 'space-forbidden';
const OWNER = { actor: 'context-owner', hostClientId: 'context-client' };
const VERSION = 'a'.repeat(64);
const CHANGED_VERSION = 'b'.repeat(64);
const HASH = `sha256:${'c'.repeat(64)}`;
const FILE = 'file-data';
const allActions = [
  ...new Set([
    ...Object.keys(REST_ACTION_SCHEMAS),
    ...Object.keys(ENGINE_ACTION_SCHEMAS),
    'data.profile',
    'data.prepare',
    'script.apply',
    'reload.wait',
    'artifact.read',
  ]),
];

function manifest() {
  return {
    version: 1,
    tables: [
      {
        name: 'Sales',
        source: { format: 'csv', dataFileId: FILE },
        fields: [{ source: 'ID' }, { source: 'Amount' }],
      },
    ],
  };
}

function fixture(
  options: {
    appIds?: string[];
    spaceIds?: string[];
    allowPersonalSpace?: boolean;
    actions?: string[];
    enabled?: boolean;
    adapter?: boolean;
    mode?: string;
    secrets?: boolean;
    actor?: typeof OWNER;
    store?: MemoryManagementStore;
  } = {},
) {
  const store = options.store ?? new MemoryManagementStore();
  const cloudAdapter = buildTestService().fixtureAdapter;
  const secrets = vi.fn(async () => 'synthetic-context-secret');
  const environment = {
    QLIK_HARNESS_TARGET_MODE: options.mode ?? 'cloud',
    QLIK_CLOUD_CONNECTION_ALIAS: CONNECTION,
    QLIK_CLOUD_TENANT_HOST: 'https://tenant.example.test',
    QLIK_CLOUD_OAUTH_CLIENT_ID: 'synthetic-oauth-client',
    QLIK_MANAGEMENT_POLICY_JSON: JSON.stringify({
      version: 1,
      enabled: options.enabled ?? true,
      environment: 'test',
      maxUploadBytes: 50 * 1024 * 1024,
      maxArtifactBytes: 200 * 1024 * 1024,
      grants: [
        {
          actor: OWNER.actor,
          clientId: OWNER.hostClientId,
          connection: CONNECTION,
          actions: options.actions ?? allActions,
          appIds: options.appIds ?? [],
          spaceIds: options.spaceIds ?? [SPACE],
          allowPersonalSpace: options.allowPersonalSpace ?? false,
          requireApproval: false,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
      reviewers: [],
    }),
  };
  const context = buildManagementContext({
    environment,
    actor: options.actor ?? OWNER,
    store,
    ...(options.secrets === false ? {} : { cloudClientSecrets: secrets }),
    ...(options.adapter === false ? {} : { cloudAdapter }),
  });
  return { context, store, secrets, cloudAdapter };
}

async function staged(
  context: NonNullable<ReturnType<typeof buildManagementContext>>,
  options: {
    owner?: string;
    connection?: string;
    spaceId?: string;
    purpose?: 'dataset' | 'app-export';
  } = {},
) {
  return context.artifacts.save(options.owner ?? OWNER.actor, Buffer.from('ID,Amount\n1,10\n'), {
    connection: options.connection ?? CONNECTION,
    spaceId: options.spaceId ?? SPACE,
    filename: 'data.csv',
    mimeType: 'text/csv',
    purpose: options.purpose ?? 'dataset',
  });
}

async function interruptedExport() {
  const prepared = fixture();
  const steps = [{ action: 'app.export', input: { connection: CONNECTION, appId: APP } }];
  const plan = await prepared.context!.workflow.plan(steps);
  const planId = String(plan.planId);
  provider.execute.mockImplementationOnce(async (action, input, onReceipt) => {
    expect(action).toBe('app.export');
    expect(input.appId).toBe(APP);
    expect(onReceipt).toBeTypeOf('function');
    await onReceipt!({ appId: APP, exportId: 'saved-temporary-export' });
    expect(await prepared.store.get(OWNER.actor, `${planId}/step/0`)).toMatchObject({
      owner: OWNER.actor,
      data: { status: 'in-progress', result: { appId: APP, exportId: 'saved-temporary-export' } },
    });
    throw createError('TRANSIENT_UNAVAILABLE');
  });
  expect(await prepared.context!.workflow.execute(planId, steps)).toMatchObject({
    status: 'needs-reconciliation',
  });
  expect(await prepared.store.get(OWNER.actor, `${planId}/step/0`)).toMatchObject({
    owner: OWNER.actor,
    data: { status: 'uncertain', result: { appId: APP, exportId: 'saved-temporary-export' } },
  });
  return { ...prepared, steps, planId };
}

function resumeToPrivateArtifact(options: { mismatchChecksum?: boolean } = {}) {
  const restOptions = provider.restConstructor.mock.calls.at(-1)![0] as CloudRestManagementOptions;
  const bytes = Buffer.from('synthetic recovered QVF');
  provider.resumeExport.mockImplementation(async (input) => {
    const saved = await restOptions.storeArtifact!(new Blob([bytes]), {
      connection: input.connection,
      appId: input.appId,
      filename: `${input.appId}.qvf`,
      kind: 'app-export',
    });
    return {
      ...saved,
      appId: input.appId,
      kind: 'app-export',
      byteLength: bytes.length,
      sha256: options.mismatchChecksum
        ? '0'.repeat(64)
        : createHash('sha256').update(bytes).digest('hex'),
    };
  });
  return bytes;
}

beforeEach(() => {
  vi.clearAllMocks();
  provider.inspect.mockReset().mockImplementation(async (action, input) => {
    if (action === 'app.create') return { exists: true, targetSpaceId: input.spaceId };
    if (action === 'space.list' || action === 'datafile.quotas') return { exists: true };
    return {
      exists: true,
      ...(input.appId ? { appId: input.appId } : {}),
      spaceId: SPACE,
      ...(Object.hasOwn(input, 'spaceId') ? { targetSpaceId: input.spaceId } : {}),
    };
  });
  provider.execute.mockReset().mockImplementation(async (action, input) => {
    if (action === 'app.get') return { appId: input.appId, spaceId: SPACE, sourceVersion: VERSION };
    if (action === 'space.get') return { spaceId: SPACE, name: SPACE_NAME };
    if (action === 'app.create')
      return {
        appId: 'app-created',
        spaceId: input.spaceId,
        sourceVersion: VERSION,
        created: true,
      };
    if (action === 'datafile.get')
      return { fileId: input.fileId, name: 'data.csv', spaceId: SPACE, sourceVersion: VERSION };
    return { verified: true };
  });
  provider.verify.mockReset().mockResolvedValue({ verified: true });
  provider.resumeExport.mockReset().mockRejectedValue(new Error('Unexpected export resumption.'));
  provider.engineExecute.mockReset().mockImplementation(async (_action, input) => ({
    appId: input.appId,
    sheetId: input.sheetId,
    expectedHash: HASH,
    created: true,
  }));
  provider.engineVerify.mockReset().mockResolvedValue(true);
});

describe('management context security with constructor-injected provider mocks', () => {
  it.each(['FAILED', 'CANCELED', 'EXCEEDED_LIMIT'])(
    'reports terminal reload %s as failed without replaying its reload or entering later steps',
    async (status) => {
      const { context, store } = fixture();
      const reloadId = 'original-reload';
      provider.execute.mockImplementation(async (action) => {
        if (action === 'reload.create') return { appId: APP, reloadId };
        if (action === 'reload.get')
          return { appId: APP, reloadId, status, terminal: true, privateLog: 'never persist' };
        throw new Error(`Unexpected action ${action}`);
      });
      const steps = [
        { action: 'reload.create', input: { connection: CONNECTION, appId: APP } },
        {
          action: 'reload.wait',
          input: { connection: CONNECTION, reloadId: { $ref: { step: 0, field: 'reloadId' } } },
        },
        { action: 'app.get', input: { connection: CONNECTION, appId: APP } },
      ];
      const plan = await context!.workflow.plan(steps);
      const expected = {
        status: 'failed',
        outcome: 'terminal-failure',
        retryable: false,
        errorCode: 'MALFORMED_REQUEST',
        result: { reloadId, status },
      };
      expect(await context!.workflow.execute(String(plan.planId), steps)).toMatchObject({
        ...expected,
        stoppedAt: 1,
        steps: [{ appId: APP, reloadId }],
      });
      expect(await context!.workflow.reconcile(String(plan.planId), steps, 1)).toMatchObject(
        expected,
      );
      expect(await context!.workflow.execute(String(plan.planId), steps)).toMatchObject(expected);
      expect(provider.execute.mock.calls.map(([action]) => action)).toEqual([
        'reload.create',
        'reload.get',
      ]);
      const execution = await store.get(OWNER.actor, `${plan.planId}/step/1`);
      expect(execution?.data).toMatchObject(expected);
      expect(execution?.data.result).toEqual({ reloadId, status });
      expect(execution?.data).not.toHaveProperty('lockId');
      expect(await store.get(OWNER.actor, `${plan.planId}/step/2`)).toBeUndefined();
    },
  );

  it('keeps disabled context credential-free and requires Cloud credentials when enabled', () => {
    expect(fixture({ enabled: false, mode: 'fixture', secrets: false }).context).toBeUndefined();
    expect(provider.restConstructor).not.toHaveBeenCalled();
    expect(provider.engineConstructor).not.toHaveBeenCalled();
    expect(() => fixture({ mode: 'fixture' })).toThrow('Qlik Cloud');
    expect(() => fixture({ secrets: false })).toThrow('Qlik Cloud');
  });

  it('wires exact host/secret factories and the existing adapter catalog without performing provider calls', async () => {
    const { context, secrets, cloudAdapter } = fixture();
    expect(context).toBeDefined();
    expect(secrets).not.toHaveBeenCalled();
    const restOptions = provider.restConstructor.mock.calls[0]![0] as CloudRestManagementOptions;
    expect(restOptions).toMatchObject({
      maxUploadBytes: 50 * 1024 * 1024,
      maxArtifactBytes: 200 * 1024 * 1024,
    });
    expect(await restOptions.getHostConfig(CONNECTION)).toMatchObject({
      host: 'https://tenant.example.test',
      clientId: 'synthetic-oauth-client',
      clientSecret: 'synthetic-context-secret',
      authType: 'oauth2',
    });
    await expect(restOptions.getHostConfig('ungranted')).rejects.toThrow();
    expect(secrets).toHaveBeenCalledExactlyOnceWith(CONNECTION);
    const engineFactory = provider.engineConstructor.mock.calls[0]![0] as (
      connection: string,
    ) => Promise<HostConfig>;
    expect((await engineFactory(CONNECTION)).host).toBe('https://tenant.example.test');
    const engineOptions = provider.engineConstructor.mock
      .calls[0]![2] as CloudEngineManagementOptions;
    const catalog = vi.spyOn(cloudAdapter, 'getCompilationContext');
    expect(await engineOptions.getCatalog!(CONNECTION, APP)).toBeDefined();
    expect(catalog).toHaveBeenCalledWith(CONNECTION, APP, OWNER);
    expect(provider.inspect).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(provider.engineExecute).not.toHaveBeenCalled();
  });

  it('fails catalog requests clearly when no existing adapter is supplied', async () => {
    fixture({ adapter: false });
    const engineOptions = provider.engineConstructor.mock
      .calls[0]![2] as CloudEngineManagementOptions;
    await expect(engineOptions.getCatalog!(CONNECTION, APP)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('authorizes newly created apps by their inspected current space and verifies their writes', async () => {
    const { context } = fixture();
    const steps = [
      { action: 'app.create', input: { connection: CONNECTION, name: 'New app', spaceId: SPACE } },
      {
        action: 'sheet.create',
        input: {
          connection: CONNECTION,
          appId: { $ref: { step: 0, field: 'appId' } },
          sheetId: 'sheet-new',
          title: 'Overview',
        },
      },
    ];
    const plan = await context!.workflow.plan(steps);
    expect(await context!.workflow.execute(String(plan.planId), steps)).toMatchObject({
      status: 'completed',
    });
    expect(provider.inspect).toHaveBeenCalledWith('app.get', {
      connection: CONNECTION,
      appId: 'app-created',
    });
    expect(provider.engineExecute).toHaveBeenCalledWith('sheet.create', {
      connection: CONNECTION,
      appId: 'app-created',
      sheetId: 'sheet-new',
      title: 'Overview',
    });
    expect(provider.verify).toHaveBeenCalledOnce();
    expect(provider.engineVerify).toHaveBeenCalledOnce();
  });

  it('does not authorize forged caller app/space metadata over the inspected target', async () => {
    const { context } = fixture();
    provider.inspect.mockResolvedValue({ exists: true, appId: 'foreign-app', spaceId: FOREIGN });
    await expect(
      context!.workflow.read('app.get', { connection: CONNECTION, appId: APP }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      context!.workflow.read('datafile.get', {
        connection: CONNECTION,
        fileId: FILE,
        appId: APP,
        spaceId: SPACE,
      }),
    ).rejects.toThrow();
    expect(provider.execute).not.toHaveBeenCalled();
    provider.inspect.mockResolvedValue({
      exists: true,
      appId: APP,
      spaceId: SPACE,
      targetSpaceId: FOREIGN,
    });
    await expect(
      context!.workflow.plan([
        {
          action: 'app.move',
          input: {
            connection: CONNECTION,
            appId: APP,
            expectedSourceVersion: VERSION,
            spaceId: FOREIGN,
          },
        },
      ]),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, null])(
    'resolves current parent app scope for app-scoped files with space=%s',
    async (spaceId) => {
      const { context } = fixture();
      provider.inspect.mockImplementation(async (action) =>
        action === 'datafile.get'
          ? { exists: true, appId: APP, ...(spaceId === undefined ? {} : { spaceId }) }
          : { exists: true, appId: APP, spaceId: SPACE },
      );
      await expect(
        context!.workflow.read('datafile.get', { connection: CONNECTION, fileId: FILE }),
      ).resolves.toMatchObject({ fileId: FILE });
      expect(provider.inspect).toHaveBeenCalledWith('app.get', {
        connection: CONNECTION,
        appId: APP,
      });
      provider.execute.mockClear();
      provider.inspect.mockImplementation(async (action) =>
        action === 'datafile.get'
          ? { exists: true, appId: APP, ...(spaceId === undefined ? {} : { spaceId }) }
          : { exists: true, appId: APP, spaceId: FOREIGN },
      );
      await expect(
        context!.workflow.read('datafile.get', { connection: CONNECTION, fileId: FILE }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(provider.execute).not.toHaveBeenCalled();
    },
  );

  it('fails closed for absent resources and absent parent apps even with an explicit app grant', async () => {
    const { context } = fixture({ appIds: [APP], spaceIds: [] });
    provider.inspect.mockResolvedValue({ exists: false });
    await expect(
      context!.workflow.read('app.get', { connection: CONNECTION, appId: APP }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    provider.inspect.mockImplementation(async (action) =>
      action === 'datafile.get' ? { exists: true, appId: APP } : { exists: false },
    );
    await expect(
      context!.workflow.read('datafile.get', { connection: CONNECTION, fileId: FILE }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('accepts only owner-bound dataset artifacts and hides direct provider upload fields', async () => {
    const { context } = fixture();
    const contract = context!.workflow.actions['datafile.upload']!.schema;
    expect(
      contract.safeParse({
        connection: CONNECTION,
        name: 'data.csv',
        spaceId: SPACE,
        contentBase64: 'SUQKMQ==',
        contentSha256: VERSION,
      }).success,
    ).toBe(false);
    for (const options of [
      { owner: 'another-owner' },
      { connection: 'another-connection' },
      { purpose: 'app-export' as const },
    ]) {
      const artifact = await staged(context!, options);
      await expect(
        context!.workflow.plan([
          {
            action: 'datafile.upload',
            input: { connection: CONNECTION, artifactId: artifact.artifactId, spaceId: SPACE },
          },
        ]),
      ).rejects.toThrow();
    }
    expect(provider.inspect).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    const own = await staged(context!);
    const steps = [
      {
        action: 'datafile.upload',
        input: { connection: CONNECTION, artifactId: own.artifactId, spaceId: SPACE },
      },
    ];
    const plan = await context!.workflow.plan(steps);
    expect(await context!.workflow.execute(String(plan.planId), steps)).toMatchObject({
      status: 'completed',
    });
    expect(provider.execute).toHaveBeenCalledWith(
      'datafile.upload',
      expect.objectContaining({
        name: 'data.csv',
        contentBase64: Buffer.from('ID,Amount\n1,10\n').toString('base64'),
      }),
    );
    expect(provider.execute.mock.calls[0]![1]).not.toHaveProperty('artifactId');
  });

  it('rejects staged datasets whose inspected upload destination disagrees with their recorded space', async () => {
    const { context } = fixture({ spaceIds: [SPACE, FOREIGN] });
    const artifact = await staged(context!);
    provider.inspect.mockResolvedValue({ exists: true, spaceId: FOREIGN, targetSpaceId: FOREIGN });
    await expect(
      context!.workflow.plan([
        {
          action: 'datafile.upload',
          input: { connection: CONNECTION, artifactId: artifact.artifactId, spaceId: FOREIGN },
        },
      ]),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('deduplicates repeated file sources, preserves verified folder paths, and returns version bindings', async () => {
    const { context } = fixture();
    provider.execute.mockImplementation(async (action, input) => {
      if (action === 'app.get') return { appId: APP, spaceId: SPACE, sourceVersion: VERSION };
      if (action === 'space.get') return { spaceId: SPACE, name: SPACE_NAME };
      return {
        fileId: input.fileId,
        name: 'data.csv',
        spaceId: SPACE,
        folderId: 'folder-team',
        folderPath: 'Team/Current',
        sourceVersion: VERSION,
      };
    });
    const request = manifest();
    request.tables.push({
      ...request.tables[0]!,
      name: 'Other',
    });
    const result = await context!.workflow.read('data.prepare', {
      connection: CONNECTION,
      appId: APP,
      manifest: request,
    });
    expect(
      provider.execute.mock.calls.filter(([action]) => action === 'datafile.get'),
    ).toHaveLength(1);
    expect(result.loadScript).toContain('[lib://Trial Finance:DataFiles/Team/Current/data.csv]');
    expect(provider.execute).toHaveBeenCalledWith('space.get', {
      connection: CONNECTION,
      spaceId: SPACE,
    });
    expect(result.fileVersions).toEqual({ [FILE]: VERSION });
  });

  it('prepares an app-scoped dataset using its current parent app space when file space metadata is absent', async () => {
    const { context } = fixture();
    provider.execute.mockImplementation(async (action) => {
      if (action === 'app.get') return { appId: APP, spaceId: SPACE, sourceVersion: VERSION };
      if (action === 'space.get') return { spaceId: SPACE, name: SPACE_NAME };
      return { fileId: FILE, appId: APP, name: 'data.csv', spaceId: null, sourceVersion: VERSION };
    });
    const result = await context!.workflow.read('data.prepare', {
      connection: CONNECTION,
      appId: APP,
      manifest: manifest(),
    });
    expect(result.loadScript).toContain('[lib://Trial Finance:DataFiles/data.csv]');
    expect(result.fileVersions).toEqual({ [FILE]: VERSION });
  });

  it('keeps explicitly authorized personal-space sources unqualified without looking up a named space', async () => {
    const { context } = fixture({ spaceIds: [], allowPersonalSpace: true });
    provider.inspect.mockResolvedValue({ exists: true, appId: APP, spaceId: null });
    provider.execute.mockImplementation(async (action) => {
      if (action === 'app.get') return { appId: APP, spaceId: null };
      return { fileId: FILE, appId: APP, name: 'data.csv', spaceId: null, sourceVersion: VERSION };
    });
    const result = await context!.workflow.read('data.prepare', {
      connection: CONNECTION,
      appId: APP,
      manifest: manifest(),
    });
    expect(result.loadScript).toContain('[lib://DataFiles/data.csv]');
    expect(provider.execute.mock.calls.some(([action]) => action === 'space.get')).toBe(false);
  });

  it.each([
    { spaceId: FOREIGN, name: SPACE_NAME },
    { spaceId: SPACE },
    { spaceId: SPACE, name: 'Finance$(include=bad)' },
    { spaceId: SPACE, name: 'Finance:Other' },
  ])('rejects an unverified or unsafe source space name %j', async (metadata) => {
    const { context } = fixture();
    provider.execute.mockImplementation(async (action) => {
      if (action === 'app.get') return { appId: APP, spaceId: SPACE };
      if (action === 'space.get') return metadata;
      return { fileId: FILE, name: 'data.csv', spaceId: SPACE, sourceVersion: VERSION };
    });
    await expect(
      context!.workflow.read('data.prepare', {
        connection: CONNECTION,
        appId: APP,
        manifest: manifest(),
      }),
    ).rejects.toThrow();
    expect(provider.engineExecute).not.toHaveBeenCalled();
  });

  it.each([
    { spaceId: FOREIGN },
    { appId: 'other-app' },
    { folderId: 'folder-unresolved' },
    { folderId: 'folder-invalid', folderPath: '../Other' },
    { name: 'wrong.xlsx' },
  ])('rejects unverified preparation sources %j', async (overrides) => {
    const { context } = fixture();
    provider.execute.mockImplementation(async (action) => {
      if (action === 'app.get') return { appId: APP, spaceId: SPACE };
      if (action === 'space.get') return { spaceId: SPACE, name: SPACE_NAME };
      return {
        fileId: FILE,
        name: 'data.csv',
        spaceId: SPACE,
        sourceVersion: VERSION,
        ...overrides,
      };
    });
    await expect(
      context!.workflow.read('data.prepare', {
        connection: CONNECTION,
        appId: APP,
        manifest: manifest(),
      }),
    ).rejects.toThrow();
    expect(provider.engineExecute).not.toHaveBeenCalled();
  });

  it.each(['before-prepare', 'during-prepare'])(
    'rejects script.apply without retaining its app lock when a source changes %s',
    async (when) => {
      const { context, store } = fixture();
      let reads = 0;
      provider.execute.mockImplementation(async (action) => {
        if (action === 'app.get') return { appId: APP, spaceId: SPACE };
        if (action === 'space.get') return { spaceId: SPACE, name: SPACE_NAME };
        reads += 1;
        return {
          fileId: FILE,
          name: 'data.csv',
          spaceId: SPACE,
          sourceVersion: when === 'before-prepare' || reads > 1 ? CHANGED_VERSION : VERSION,
        };
      });
      const steps = [
        {
          action: 'script.apply',
          input: {
            connection: CONNECTION,
            appId: APP,
            expectedHash: HASH,
            manifest: manifest(),
            fileVersions: { [FILE]: VERSION },
          },
        },
      ];
      const plan = await context!.workflow.plan(steps);
      expect(await context!.workflow.execute(String(plan.planId), steps)).toMatchObject({
        status: 'failed',
        outcome: 'rejected',
        errorCode: 'IDEMPOTENCY_CONFLICT',
      });
      expect(provider.engineExecute).not.toHaveBeenCalled();
      const saved = await store.get(OWNER.actor, `${plan.planId}/step/0`);
      expect(saved?.data).toMatchObject({
        status: 'failed',
        outcome: 'rejected',
        dispatch: 'not-started',
      });
      expect(
        (await store.get('__management_locks__', String(saved?.data.lockId)))?.data.status,
      ).toBe('released');
      const sourceReadCount = provider.execute.mock.calls.length;
      expect(await context!.workflow.execute(String(plan.planId), steps)).toMatchObject({
        status: 'failed',
        outcome: 'rejected',
      });
      expect(await context!.workflow.reconcile(String(plan.planId), steps, 0)).toMatchObject({
        status: 'failed',
        outcome: 'rejected',
      });
      expect(provider.execute).toHaveBeenCalledTimes(sourceReadCount);
      expect(provider.engineExecute).not.toHaveBeenCalled();

      const refreshedSteps = steps.map((step) => ({
        ...step,
        input: { ...step.input, fileVersions: { [FILE]: CHANGED_VERSION } },
      }));
      const refreshedPlan = await context!.workflow.plan(refreshedSteps);
      expect(
        await context!.workflow.execute(String(refreshedPlan.planId), refreshedSteps),
      ).toMatchObject({ status: 'completed' });
      expect(provider.engineExecute).toHaveBeenCalledOnce();
    },
  );

  it('applies an unchanged source manifest only through the expected script hash and independent readback', async () => {
    const { context } = fixture();
    const steps = [
      {
        action: 'script.apply',
        input: {
          connection: CONNECTION,
          appId: APP,
          expectedHash: HASH,
          manifest: manifest(),
          fileVersions: [{ fileId: FILE, sourceVersion: VERSION }],
        },
      },
    ];
    const plan = await context!.workflow.plan(steps);
    expect(await context!.workflow.execute(String(plan.planId), steps)).toMatchObject({
      status: 'completed',
    });
    expect(provider.engineExecute).toHaveBeenCalledWith(
      'script.set',
      expect.objectContaining({
        appId: APP,
        expectedHash: HASH,
        script: expect.stringContaining('[lib://Trial Finance:DataFiles/data.csv]'),
      }),
    );
    expect(provider.engineVerify).toHaveBeenCalledWith(
      'script.set',
      expect.objectContaining({ appId: APP, expectedHash: HASH }),
      expect.any(Object),
    );
  });

  it('rechecks deleted/moved export apps and does not trust artifact creation-time space metadata', async () => {
    const { context } = fixture();
    const artifact = await context!.artifacts.save(OWNER.actor, Buffer.from('synthetic export'), {
      connection: CONNECTION,
      appId: APP,
      spaceId: SPACE,
      filename: 'app.qvf',
      mimeType: 'application/octet-stream',
      purpose: 'app-export',
    });
    await expect(
      context!.authorizeArtifact!(artifact.artifactId, CONNECTION, 'artifact.read'),
    ).resolves.toBeUndefined();
    provider.inspect.mockResolvedValue({ exists: true, appId: APP, spaceId: FOREIGN });
    await expect(
      context!.authorizeArtifact!(artifact.artifactId, CONNECTION, 'artifact.read'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    provider.inspect.mockResolvedValue({ exists: false });
    await expect(
      context!.authorizeArtifact!(artifact.artifactId, CONNECTION, 'artifact.read'),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    await expect(
      context!.authorizeArtifact!(artifact.artifactId, 'another-connection', 'artifact.read'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('resumes a durable export receipt in a fresh owner context and exposes the verified artifact chunk', async () => {
    const { store, planId, steps } = await interruptedExport();
    const resumed = fixture({ store }).context!;
    const bytes = resumeToPrivateArtifact();
    const reconciliation = await resumed.workflow.reconcile(planId, steps, 0);
    expect(reconciliation).toMatchObject({
      status: 'completed',
      result: {
        appId: APP,
        exportId: 'saved-temporary-export',
        kind: 'app-export',
        verified: true,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    });
    expect(provider.resumeExport).toHaveBeenCalledExactlyOnceWith(
      { connection: CONNECTION, appId: APP },
      { appId: APP, exportId: 'saved-temporary-export' },
    );
    const artifactId = String((reconciliation.result as Record<string, unknown>).artifactId);
    expect(await store.get(OWNER.actor, artifactId)).toMatchObject({
      owner: OWNER.actor,
      kind: 'artifact',
      data: { appId: APP, connection: CONNECTION, spaceId: SPACE, status: 'sealed' },
    });
    expect(await store.get('another-owner', artifactId)).toBeUndefined();
    await resumed.authorizeArtifact!(artifactId, CONNECTION, 'artifact.read');
    const chunk = await resumed.artifacts.downloadChunk(OWNER.actor, artifactId, 0);
    expect(chunk).toMatchObject({
      artifactId,
      contentBase64: bytes.toString('base64'),
      byteLength: bytes.length,
    });
    expect(await resumed.workflow.execute(planId, steps)).toMatchObject({ status: 'completed' });
    expect(await resumed.workflow.reconcile(planId, steps, 0)).toMatchObject({
      status: 'completed',
    });
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(provider.resumeExport).toHaveBeenCalledTimes(1);
  });

  it('rejects other owners, other clients, and forged app input before resuming an export receipt', async () => {
    const { store, planId, steps } = await interruptedExport();
    for (const actor of [
      { actor: 'another-owner', hostClientId: OWNER.hostClientId },
      { actor: OWNER.actor, hostClientId: 'another-client' },
    ]) {
      const foreign = fixture({ store, actor }).context!;
      await expect(foreign.workflow.reconcile(planId, steps, 0)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
    }
    const owner = fixture({ store }).context!;
    const forged = [
      { action: 'app.export', input: { connection: CONNECTION, appId: 'foreign-app' } },
    ];
    await expect(owner.workflow.reconcile(planId, forged, 0)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(provider.resumeExport).not.toHaveBeenCalled();
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });

  it('requires current app scope again before resuming and retains the receipt after denial', async () => {
    const { store, planId, steps } = await interruptedExport();
    const resumed = fixture({ store }).context!;
    provider.inspect.mockResolvedValue({ exists: true, appId: APP, spaceId: FOREIGN });
    await expect(resumed.workflow.reconcile(planId, steps, 0)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(provider.resumeExport).not.toHaveBeenCalled();
    expect(await store.get(OWNER.actor, `${planId}/step/0`)).toMatchObject({
      data: { status: 'uncertain', result: { appId: APP, exportId: 'saved-temporary-export' } },
    });
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps resumed exports pending when saved artifact bytes do not match the returned checksum', async () => {
    const { store, planId, steps } = await interruptedExport();
    const resumed = fixture({ store }).context!;
    resumeToPrivateArtifact({ mismatchChecksum: true });
    expect(await resumed.workflow.reconcile(planId, steps, 0)).toMatchObject({
      status: 'needs-reconciliation',
      verification: { verified: false },
    });
    expect(await store.get(OWNER.actor, `${planId}/step/0`)).toMatchObject({
      data: { status: 'uncertain' },
    });
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });

  it('preserves strict pure-profile refinements through safeExtend without contacting providers', async () => {
    const { context } = fixture();
    const sample = {
      connection: CONNECTION,
      columns: [{ name: 'ID' }, { name: 'Amount', expectedType: 'number' }],
      rows: [
        ['001', '10'],
        ['001', 'bad'],
      ],
      keyFields: ['ID'],
    };
    expect(await context!.workflow.read('data.profile', sample)).toMatchObject({
      scope: 'supplied-rows',
      rowCount: 2,
      keys: { duplicateKeyRows: 1 },
      columns: [{ name: 'ID' }, { name: 'Amount', typeMismatchCount: 1 }],
    });
    for (const bad of [
      { ...sample, rows: [['short']] },
      { ...sample, keyFields: ['missing'] },
      { ...sample, columns: [{ name: 'ID' }, { name: 'ID' }] },
      { ...sample, rows: [[null, Number.POSITIVE_INFINITY]] },
      { ...sample, rows: Array.from({ length: 5001 }, () => ['x', '1']) },
      { ...sample, extraneous: true },
    ])
      await expect(context!.workflow.read('data.profile', bad)).rejects.toThrow();
    expect(provider.inspect).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(provider.engineExecute).not.toHaveBeenCalled();
  });

  it('filters every app-list page to exact app, space, or personal grants while retaining the provider cursor', async () => {
    const { context } = fixture({ appIds: ['allowed-app'], allowPersonalSpace: true });
    provider.inspect.mockResolvedValue({ exists: true });
    const foreign = { appId: 'foreign-app', name: 'private-foreign-name', spaceId: FOREIGN };
    provider.execute.mockImplementation(async (_action, input) =>
      input.cursor
        ? { items: [foreign], count: 1, cursor: 'next-provider-page' }
        : {
            items: [
              foreign,
              { appId: 'allowed-app', spaceId: FOREIGN },
              { appId: 'space-app', spaceId: SPACE },
              { appId: 'personal-app', spaceId: null },
              { appId: 'missing-scope' },
              null,
            ],
            count: 6,
            cursor: 'first-provider-page',
          },
    );
    const first = await context!.workflow.read('app.list', { connection: CONNECTION });
    expect(first).toEqual({
      items: [
        { appId: 'allowed-app', spaceId: FOREIGN },
        { appId: 'space-app', spaceId: SPACE },
        { appId: 'personal-app', spaceId: null },
      ],
      count: 3,
      cursor: 'first-provider-page',
    });
    const second = await context!.workflow.read('app.list', {
      connection: CONNECTION,
      cursor: first.cursor,
    });
    expect(second).toEqual({ items: [], count: 0, cursor: 'next-provider-page' });
    expect(JSON.stringify([first, second])).not.toContain('private-foreign-name');
  });

  it('omits personal-space apps when the grant does not explicitly allow them', async () => {
    const { context } = fixture();
    provider.inspect.mockResolvedValue({ exists: true });
    provider.execute.mockResolvedValue({
      items: [{ appId: 'personal-app', name: 'private-personal-name', spaceId: null }],
      count: 1,
      cursor: 'continued-page',
    });
    expect(await context!.workflow.read('app.list', { connection: CONNECTION })).toEqual({
      items: [],
      count: 0,
      cursor: 'continued-page',
    });
  });

  it('filters space listings to exact policy grants', async () => {
    const { context } = fixture();
    provider.execute.mockResolvedValue({
      items: [
        { spaceId: SPACE, name: 'Allowed' },
        { spaceId: FOREIGN, name: 'Private' },
      ],
      count: 2,
    });
    expect(await context!.workflow.read('space.list', { connection: CONNECTION })).toMatchObject({
      items: [{ spaceId: SPACE, name: 'Allowed' }],
      count: 1,
    });
  });
});
