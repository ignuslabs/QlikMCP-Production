import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudRestManagementProvider,
  type CloudRestApi,
  type CloudRestManagementOptions,
} from '../../../src/management/cloudRestProvider.js';
import { REST_ACTION_SCHEMAS, REST_READ_ACTIONS } from '../../../src/management/restContracts.js';

const connection = 'cloud';
const appId = 'app-1';
const spaceId = 'space-1';
const options = { noCache: true, timeoutMs: 30_000 };
const appResponse = {
  attributes: { id: appId, name: 'Sales', modifiedDate: '2026-09-15T12:00:00Z' },
  privileges: ['read', 'update', 'delete'],
};
const appItemResponse = {
  id: 'catalog-item-1',
  resourceType: 'app',
  resourceId: appId,
  name: 'Sales',
  description: 'Quarterly sales',
  spaceId,
  resourceCreatedAt: '2026-09-15T10:00:00Z',
  resourceUpdatedAt: '2026-09-15T12:00:00Z',
  links: { open: { href: 'https://tenant.example/signed?token=secret' } },
  resourceAttributes: { sensitive: 'secret' },
  resourceCustomAttributes: { data: 'secret' },
};
const spaceResponse = {
  id: spaceId,
  name: 'Team',
  type: 'shared',
  updatedAt: '2026-09-15T12:00:00Z',
  meta: {
    assignableRoles: ['consumer', 'producer'],
    roles: ['producer'],
    actions: ['read', 'update'],
  },
};
const fileResponse = {
  id: 'file-1',
  name: 'data.csv',
  size: 4,
  spaceId,
  appId,
  folderId: 'folder-1',
  modifiedDate: '2026-09-15T12:00:00Z',
  actions: ['read', 'update'],
  folder: false,
};
const reloadResponse = {
  id: 'reload-1',
  appId,
  status: 'QUEUED',
  creationTime: '2026-09-15T12:00:00Z',
  log: 'password=secret',
  errorMessage: 'Bearer secret',
};
const taskResponse = {
  id: 'task-1',
  name: 'Daily',
  specVersion: '0.8',
  enabled: true,
  metadata: { spaceId, updatedAt: '2026-09-15T12:00:00Z' },
  start: { stateName: 'reload', schedule: { recurrence: 'RRULE:FREQ=DAILY', timezone: 'UTC' } },
  states: [
    {
      name: 'reload',
      type: 'EVENT',
      end: true,
      onEvents: [
        {
          eventRefs: [],
          actions: [
            {
              name: 'reload-action',
              functionRef: { refName: 'app.reload', arguments: { appId, partial: false } },
            },
          ],
        },
      ],
    },
  ],
};
const memberResponse = {
  id: 'assignment-1',
  spaceId,
  assigneeId: 'user-1',
  roles: ['consumer'],
  type: 'user',
};
const shareResponse = {
  id: 'share-1',
  spaceId,
  resourceId: appId,
  assigneeId: 'user-1',
  roles: ['consumer'],
  type: 'user',
};
const response = (data: unknown) => Promise.resolve({ data, headers: new Headers(), status: 200 });

function setup(overrides: Partial<CloudRestManagementOptions> = {}) {
  const sdk = {
    apps: {
      getAppInfo: vi.fn(() => response(appResponse)),
      createApp: vi.fn(() => response(appResponse)),
      updateAppInfo: vi.fn(() => response(appResponse)),
      copyApp: vi.fn(() =>
        response({ ...appResponse, attributes: { ...appResponse.attributes, id: 'copy-1' } }),
      ),
      moveAppToSpace: vi.fn(() => response(appResponse)),
      removeAppFromSpace: vi.fn(() => response(appResponse)),
      deleteApp: vi.fn(() => response(undefined)),
      publishApp: vi.fn(() =>
        response({ ...appResponse, attributes: { ...appResponse.attributes, id: 'published-1' } }),
      ),
      exportApp: vi.fn(() => response(new Blob(['qvf-content']))),
      getAppReloadLog: vi.fn(() => response(new Blob(['reload-log']))),
    },
    items: { getItems: vi.fn(() => response({ data: [{ resourceId: appId, spaceId }] })) },
    tempContents: {
      getTempFileDetails: vi.fn(() => response({ ID: 'temporary-export', Size: '11' })),
      downloadTempFile: vi.fn(() => response(new Blob(['qvf-content']))),
    },
    spaces: {
      getSpace: vi.fn(() => response(spaceResponse)),
      getSpaces: vi.fn(() =>
        response({
          data: [spaceResponse],
          links: { next: { href: '/api/v1/spaces?next=cursor-two' } },
        }),
      ),
      createSpace: vi.fn(() => response(spaceResponse)),
      updateSpace: vi.fn(() => response(spaceResponse)),
      deleteSpace: vi.fn(() => response(undefined)),
      getSpaceAssignment: vi.fn(() => response(memberResponse)),
      getSpaceAssignments: vi.fn(() => response({ data: [memberResponse] })),
      createSpaceAssignment: vi.fn(() => response(memberResponse)),
      updateSpaceAssignment: vi.fn(() => response(memberResponse)),
      deleteSpaceAssignment: vi.fn(() => response(undefined)),
      getSpaceShare: vi.fn(() => response(shareResponse)),
      getSpaceShares: vi.fn(() => response({ data: [shareResponse] })),
      createSpaceShare: vi.fn(() => response(shareResponse)),
      patchShare: vi.fn(() => response(undefined)),
      deleteSpaceShare: vi.fn(() => response(undefined)),
    },
    dataFiles: {
      getDataFile: vi.fn(() => response(fileResponse)),
      getDataFiles: vi.fn(() => response({ data: [fileResponse], links: {} })),
      getDataFilesConnections: vi.fn(() =>
        response({ data: [{ id: 'connection-1', spaceId }], links: {} }),
      ),
      getDataFilesQuotas: vi.fn(() =>
        response({
          allowedExtensions: ['.csv', '.qvd', '.xlsx'],
          maxFileSize: 1_000,
          maxLargeFileSize: 100_000,
          maxSize: 500_000,
          size: 4,
        }),
      ),
      uploadDataFile: vi.fn(() => response(fileResponse)),
      reuploadDataFile: vi.fn(() => response(fileResponse)),
      deleteDataFile: vi.fn(() => response(undefined)),
    },
    reloads: {
      getReload: vi.fn(() => response(reloadResponse)),
      getReloads: vi.fn(() => response({ data: [reloadResponse], links: {} })),
      queueReload: vi.fn(() => response(reloadResponse)),
      cancelReload: vi.fn(() => response(undefined)),
    },
    scheduling: {
      tasks: {
        getTask: vi.fn(() => response(taskResponse)),
        getTasks: vi.fn(() => response({ data: [taskResponse] })),
        createTaskWithoutQuery: vi.fn(() => response(taskResponse)),
        updateTask: vi.fn(() => response(taskResponse)),
        patchTask: vi.fn(() => response(taskResponse)),
        deleteTask: vi.fn(() => response(undefined)),
      },
    },
  };
  const getHostConfig = vi.fn(async () => ({
    host: 'https://tenant.example',
    apiKey: 'not-a-real-key',
  }));
  const apiFactory = vi.fn(() => sdk as unknown as CloudRestApi);
  const provider = new CloudRestManagementProvider({ getHostConfig, apiFactory, ...overrides });
  return { provider, sdk, getHostConfig, apiFactory };
}

async function version(
  provider: CloudRestManagementProvider,
  action: string,
  input: Record<string, unknown>,
) {
  return (await provider.inspect(action, { connection, ...input })).sourceVersion;
}
function content(text = 'a\n1\n') {
  return {
    contentBase64: Buffer.from(text).toString('base64'),
    contentSha256: createHash('sha256').update(text).digest('hex'),
  };
}

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network access in offline tests.');
    }),
  ),
);
afterEach(() => vi.unstubAllGlobals());

describe('CloudRestManagementProvider', () => {
  it('uses the installed SDK Items route for a bounded personal app page', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request | string | URL, init?: RequestInit) => {
        requests.push(new Request(request, init));
        return new Response(JSON.stringify({ data: [], links: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const provider = new CloudRestManagementProvider({
      getHostConfig: async () => ({ host: 'https://tenant.example', apiKey: 'test-placeholder' }),
    });
    await provider.execute('app.list', {
      connection,
      spaceId: null,
      limit: 2,
      cursor: 'cursor-one',
      name: 'Sales',
    });
    const calls = requests.filter((request) => new URL(request.url).pathname === '/api/v1/items');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toEqual({
      resourceType: 'app',
      limit: '2',
      next: 'cursor-one',
      name: 'Sales',
      spaceId: 'personal',
      sort: '+name',
      noActions: 'true',
    });
  });

  it('lists app IDs and current spaces without catalog internals or a partial write version', async () => {
    const { provider, sdk } = setup();
    sdk.items.getItems.mockImplementation(() =>
      response({
        data: [
          appItemResponse,
          { ...appItemResponse, resourceId: 'personal-app', spaceId: undefined },
        ],
        links: { next: { href: '/api/v1/items?next=cursor-two&token=secret' } },
      }),
    );
    const result = await provider.execute('app.list', { connection, limit: 2 });
    expect(sdk.items.getItems).toHaveBeenCalledTimes(1);
    expect(sdk.items.getItems).toHaveBeenCalledWith(
      {
        resourceType: 'app',
        limit: 2,
        next: undefined,
        name: undefined,
        spaceId: undefined,
        sort: '+name',
        noActions: true,
      },
      options,
    );
    const expected = {
      resourceType: 'app',
      resourceId: appId,
      appId,
      name: 'Sales',
      description: 'Quarterly sales',
      spaceId,
      createdDate: appItemResponse.resourceCreatedAt,
      modifiedDate: appItemResponse.resourceUpdatedAt,
    };
    expect(result).toEqual({
      items: [
        expected,
        { ...expected, resourceId: 'personal-app', appId: 'personal-app', spaceId: null },
      ],
      count: 2,
      nextCursor: 'cursor-two',
    });
    expect(REST_READ_ACTIONS.has('app.list')).toBe(true);
    expect(sdk.apps.getAppInfo).not.toHaveBeenCalled();
    await provider.execute('app.list', { connection, spaceId });
    expect(sdk.items.getItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ spaceId, limit: 50 }),
      options,
    );
  });

  it('rejects malformed app catalog entries and oversized pages without continuing', async () => {
    const { provider, sdk } = setup();
    sdk.items.getItems.mockImplementation(() =>
      response({ data: [appItemResponse, appItemResponse] }),
    );
    await expect(provider.execute('app.list', { connection, limit: 1 })).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    sdk.items.getItems.mockImplementation(() =>
      response({ data: [{ ...appItemResponse, resourceId: undefined }] }),
    );
    await expect(provider.execute('app.list', { connection })).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    await expect(provider.execute('app.list', { connection, limit: 101 })).rejects.toMatchObject({
      code: 'MALFORMED_REQUEST',
    });
    expect(sdk.items.getItems).toHaveBeenCalledTimes(2);
  });

  it('uses the installed SDK transport for the actual app endpoint and JSON body', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request | string | URL, init?: RequestInit) => {
        requests.push(new Request(request, init));
        return new Response(JSON.stringify(appResponse), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const provider = new CloudRestManagementProvider({
      getHostConfig: async () => ({
        host: 'https://tenant.example',
        apiKey: 'test-only-placeholder',
      }),
    });
    await provider.execute('app.create', { connection, name: 'Sales', spaceId });
    const writes = requests.filter((request) => request.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toBe('https://tenant.example/api/v1/apps');
    expect(await writes[0]!.json()).toEqual({ attributes: { name: 'Sales', spaceId } });
  });

  it('uses installed SDK multipart conversion for file bytes and JSON metadata', async () => {
    let uploaded: Request | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request | string | URL, init?: RequestInit) => {
        const current = new Request(request, init);
        let data: unknown;
        if (current.url.endsWith('/data-files/quotas'))
          data = { allowedExtensions: ['.csv'], maxFileSize: 1_000 };
        else if (current.url.includes('/data-files/connections'))
          data = { data: [{ id: 'connection-1', spaceId }], links: {} };
        else if (current.url.endsWith('/data-files') && current.method === 'POST') {
          uploaded = current;
          data = fileResponse;
        } else throw new Error('Unexpected SDK request');
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const provider = new CloudRestManagementProvider({
      getHostConfig: async () => ({
        host: 'https://tenant.example',
        apiKey: 'test-only-placeholder',
      }),
    });
    await provider.execute('datafile.upload', {
      connection,
      name: 'data.csv',
      spaceId,
      ...content(),
    });
    const form = await uploaded!.formData();
    expect(await (form.get('File') as Blob).text()).toBe('a\n1\n');
    const json = form.get('Json');
    expect(JSON.parse(typeof json === 'string' ? json : await (json as Blob).text())).toEqual({
      name: 'data.csv',
      connectionId: 'connection-1',
      folder: false,
    });
  });

  it('creates an app with exact SDK attributes and emits only bounded metadata', async () => {
    const { provider, sdk, getHostConfig } = setup();
    const result = await provider.execute('app.create', {
      connection,
      name: 'Sales',
      spaceId,
      description: 'Revenue',
    });
    expect(sdk.apps.createApp).toHaveBeenCalledWith(
      { attributes: { name: 'Sales', spaceId, description: 'Revenue', locale: undefined } },
      options,
    );
    expect(getHostConfig).toHaveBeenCalledWith(connection);
    expect(result).toMatchObject({
      appId,
      spaceId,
      sourceVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain('not-a-real-key');
  });

  it('resolves authoritative app space from Items instead of assuming personal space', async () => {
    const { provider, sdk } = setup();
    expect(await provider.inspect('app.update', { connection, appId })).toMatchObject({
      exists: true,
      appId,
      spaceId,
    });
    expect(sdk.items.getItems).toHaveBeenCalledWith(
      { resourceType: 'app', resourceId: appId, limit: 2, noActions: true },
      options,
    );
    sdk.items.getItems.mockImplementation(() => response({ data: [] }));
    await expect(provider.inspect('app.update', { connection, appId })).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
  });

  it.each([401, 403])('does not reinterpret permission failure %s as missing', async (status) => {
    const { provider, sdk } = setup();
    sdk.dataFiles.getDataFile.mockRejectedValueOnce({ status, data: 'sensitive-provider-text' });
    await expect(
      provider.inspect('datafile.delete', { connection, fileId: 'file-1' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('treats only an actual 404 as absent during inspection', async () => {
    const { provider, sdk } = setup();
    sdk.dataFiles.getDataFile.mockRejectedValueOnce({ status: 404 });
    await expect(
      provider.inspect('datafile.delete', { connection, fileId: 'file-1' }),
    ).resolves.toEqual({ exists: false });
    sdk.dataFiles.getDataFile.mockRejectedValueOnce({ status: 404 });
    await expect(
      provider.execute('datafile.get', { connection, fileId: 'file-1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not interpret a missing dependency as deletion of the inspected resource', async () => {
    const { provider, sdk } = setup();
    sdk.apps.getAppInfo.mockRejectedValueOnce({ status: 404 });
    await expect(
      provider.inspect('reload.get', { connection, reloadId: 'reload-1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    sdk.items.getItems.mockRejectedValueOnce({ status: 404 });
    await expect(provider.inspect('app.get', { connection, appId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reports pending when an acknowledged app update has not appeared in independent readback', async () => {
    const { provider, sdk } = setup();
    const input = { connection, appId, name: 'Renamed' };
    expect(await provider.verify('app.update', input, { appId })).toMatchObject({
      verified: false,
      verificationScope: 'resource-readback',
    });
    sdk.apps.getAppInfo.mockImplementation(() =>
      response({ ...appResponse, attributes: { ...appResponse.attributes, name: 'Renamed' } }),
    );
    expect(await provider.verify('app.update', input, { appId })).toMatchObject({ verified: true });
  });

  it.each(['app.duplicate', 'app.publish'])(
    'requires a distinct receipt app ID before verifying %s',
    async (action) => {
      const { provider, sdk } = setup();
      const input = { connection, appId, spaceId, name: 'Sales' };
      for (const result of [{}, { appId }, { appId: '' }, { appId: 'copy-1', resourceId: appId }]) {
        expect(await provider.verify(action, input, result)).toMatchObject({ verified: false });
      }
      expect(sdk.apps.getAppInfo).not.toHaveBeenCalled();
      expect(sdk.items.getItems).not.toHaveBeenCalled();
      sdk.items.getItems.mockImplementation(() =>
        response({ data: [{ resourceId: 'copy-1', spaceId }] }),
      );
      expect(await provider.verify(action, input, { appId: 'copy-1' })).toMatchObject({
        verified: false,
      });
      sdk.apps.getAppInfo.mockImplementation(() =>
        response({
          ...appResponse,
          attributes: {
            ...appResponse.attributes,
            id: 'copy-1',
            publishTime: '2026-09-15T12:00:00Z',
          },
        }),
      );
      expect(
        await provider.verify(action, input, { appId: 'copy-1', resourceId: 'copy-1' }),
      ).toMatchObject({
        verified: true,
        observed: { appId: 'copy-1', spaceId },
      });
      expect(sdk.apps.getAppInfo).toHaveBeenCalledWith('copy-1', options);
    },
  );

  it('verifies actual deletion by source 404, never by a delete acknowledgment alone', async () => {
    const { provider, sdk } = setup();
    expect(
      await provider.verify('datafile.delete', { connection, fileId: 'file-1' }, { deleted: true }),
    ).toMatchObject({ verified: false });
    sdk.dataFiles.getDataFile.mockRejectedValueOnce({ status: 404 });
    expect(
      await provider.verify('datafile.delete', { connection, fileId: 'file-1' }, { deleted: true }),
    ).toMatchObject({ verified: true });
  });

  it('checks intended upload name and byte count independently of acknowledged metadata', async () => {
    const { provider } = setup();
    expect(
      await provider.verify(
        'datafile.upload',
        { connection, spaceId, name: 'expected.csv', ...content() },
        { ...fileResponse, fileId: 'file-1' },
      ),
    ).toMatchObject({ verified: false });
    expect(
      await provider.verify(
        'datafile.upload',
        { connection, spaceId, name: 'data.csv', ...content('extra-bytes') },
        { ...fileResponse, fileId: 'file-1' },
      ),
    ).toMatchObject({ verified: false });
    expect(
      await provider.verify(
        'datafile.upload',
        { connection, spaceId, name: 'data.csv', ...content() },
        { ...fileResponse, fileId: 'file-1' },
      ),
    ).toMatchObject({ verified: true, verificationScope: 'metadata-and-size' });
  });

  it('rejects stale app deletion without submitting a write', async () => {
    const { provider, sdk } = setup();
    const expectedSourceVersion = await version(provider, 'app.delete', { appId });
    sdk.apps.getAppInfo.mockImplementation(() =>
      response({ attributes: { ...appResponse.attributes, name: 'Changed' } }),
    );
    await expect(
      provider.execute('app.delete', { connection, appId, expectedSourceVersion }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(sdk.apps.deleteApp).not.toHaveBeenCalled();
  });

  it('keeps update attributes, duplication destinations, and personal moves explicit', async () => {
    const { provider, sdk } = setup();
    const expectedSourceVersion = await version(provider, 'app.update', { appId });
    await provider.execute('app.update', {
      connection,
      appId,
      expectedSourceVersion,
      name: 'New name',
    });
    expect(sdk.apps.updateAppInfo).toHaveBeenCalledWith(
      appId,
      { attributes: { name: 'New name', description: undefined } },
      options,
    );
    expect(
      await provider.execute('app.duplicate', {
        connection,
        appId,
        expectedSourceVersion,
        name: 'Copy',
        spaceId: 'space-2',
      }),
    ).toMatchObject({ appId: 'copy-1', spaceId: 'space-2' });
    await provider.execute('app.move', { connection, appId, expectedSourceVersion, spaceId: null });
    expect(sdk.apps.removeAppFromSpace).toHaveBeenCalledWith(appId, options);
    expect(sdk.apps.moveAppToSpace).not.toHaveBeenCalled();
  });

  it('requires a managed publishing destination and reports the created app ID', async () => {
    const { provider, sdk } = setup();
    const expectedSourceVersion = await version(provider, 'app.publish', { appId });
    await expect(
      provider.execute('app.publish', { connection, appId, spaceId, expectedSourceVersion }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(sdk.apps.publishApp).not.toHaveBeenCalled();
    sdk.spaces.getSpace.mockImplementation(() => response({ ...spaceResponse, type: 'managed' }));
    expect(
      await provider.execute('app.publish', { connection, appId, spaceId, expectedSourceVersion }),
    ).toMatchObject({ appId: 'published-1' });
  });

  it('delivers exports to an artifact sink with no Blob or signed URL in results', async () => {
    const storeArtifact = vi.fn(async () => ({ artifactId: 'artifact-1' }));
    const { provider, sdk } = setup({ storeArtifact });
    const result = await provider.execute('app.export', { connection, appId, noData: true });
    expect(sdk.apps.exportApp).toHaveBeenCalledWith(appId, { NoData: true }, options);
    expect(storeArtifact).toHaveBeenCalledWith(expect.any(Blob), {
      connection,
      appId,
      kind: 'app-export',
      filename: 'app-1.qvf',
    });
    expect(result).toEqual({
      artifactId: 'artifact-1',
      kind: 'app-export',
      appId,
      filename: 'app-1.qvf',
      byteLength: 11,
      sha256: createHash('sha256').update('qvf-content').digest('hex'),
    });
  });

  it('downloads an actual SDK 201 export through tenant-bound temporary contents and checks bytes', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request | string | URL, init?: RequestInit) => {
        const outgoing = new Request(request, init);
        requests.push(outgoing);
        const pathname = new URL(outgoing.url).pathname;
        if (pathname === `/api/v1/apps/${appId}/export`)
          return new Response('', {
            status: 201,
            headers: {
              'content-type': 'application/json',
              location: '/api/v1/temp-contents/temporary-export',
            },
          });
        if (pathname === '/api/v1/temp-contents/temporary-export/details')
          return new Response(JSON.stringify({ ID: 'temporary-export', Size: '11' }), {
            headers: { 'content-type': 'application/json' },
          });
        if (pathname === '/api/v1/temp-contents/temporary-export')
          return new Response(new Blob(['qvf-content']), {
            headers: { 'content-type': 'application/octet-stream' },
          });
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }),
    );
    const storeArtifact = vi.fn(async (blob: Blob) => {
      expect(await blob.text()).toBe('qvf-content');
      return { artifactId: 'export-artifact' };
    });
    const provider = new CloudRestManagementProvider({
      getHostConfig: async () => ({ host: 'https://tenant.example', apiKey: 'test-placeholder' }),
      storeArtifact,
    });
    const result = await provider.execute('app.export', { connection, appId });
    expect(result).toEqual({
      artifactId: 'export-artifact',
      kind: 'app-export',
      appId,
      filename: 'app-1.qvf',
      byteLength: 11,
      sha256: createHash('sha256').update('qvf-content').digest('hex'),
    });
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(
      requests
        .filter((request) => new URL(request.url).pathname.startsWith('/api/v1/temp-contents'))
        .map((request) => [request.method, new URL(request.url).pathname]),
    ).toEqual([
      ['GET', '/api/v1/temp-contents/temporary-export/details'],
      ['GET', '/api/v1/temp-contents/temporary-export'],
    ]);
    expect(
      requests.every((request) => new URL(request.url).origin === 'https://tenant.example'),
    ).toBe(true);
  });

  it.each([
    'https://attacker.example/api/v1/temp-contents/temporary-export',
    '//attacker.example/api/v1/temp-contents/temporary-export',
    '/api/v1/temp-contents/../secrets',
    '/api/v1/temp-contents/%2e%2e',
    '/api/v1/temp-contents/temporary-export?token=secret',
    '/api/v1/temp-contents/temporary-export#fragment',
    '/api/v1/apps/app-1',
  ])(
    'rejects export Location outside the exact temporary-content ID path: %s',
    async (location) => {
      const { provider, sdk } = setup({ storeArtifact: async () => ({ artifactId: 'artifact' }) });
      sdk.apps.exportApp.mockImplementation(async () => ({
        data: '',
        status: 201,
        headers: new Headers({ location }),
      }));
      await expect(provider.execute('app.export', { connection, appId })).rejects.toMatchObject({
        code: 'TRANSIENT_UNAVAILABLE',
      });
      expect(sdk.tempContents.getTempFileDetails).not.toHaveBeenCalled();
      expect(sdk.tempContents.downloadTempFile).not.toHaveBeenCalled();
      expect(sdk.apps.exportApp).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds temporary export metadata before download and rejects partial or mismatched bytes', async () => {
    const storeArtifact = vi.fn(async () => ({ artifactId: 'artifact' }));
    const { provider, sdk } = setup({ storeArtifact, maxArtifactBytes: 100 });
    sdk.apps.exportApp.mockImplementation(async () => ({
      data: '',
      status: 201,
      headers: new Headers({ location: '/api/v1/temp-contents/temporary-export' }),
    }));
    sdk.tempContents.getTempFileDetails.mockImplementationOnce(() => response({ Size: '101' }));
    await expect(provider.execute('app.export', { connection, appId })).rejects.toMatchObject({
      code: 'CAPACITY_EXHAUSTED',
    });
    expect(sdk.tempContents.downloadTempFile).not.toHaveBeenCalled();
    sdk.tempContents.getTempFileDetails.mockImplementationOnce(() => response({ Size: 'unknown' }));
    await expect(provider.execute('app.export', { connection, appId })).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    expect(sdk.tempContents.downloadTempFile).not.toHaveBeenCalled();
    sdk.tempContents.downloadTempFile.mockImplementationOnce(async () => ({
      data: new Blob(['qvf-content']),
      status: 206,
      headers: new Headers(),
    }));
    await expect(provider.execute('app.export', { connection, appId })).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    sdk.tempContents.downloadTempFile.mockImplementationOnce(() =>
      response(new Blob(['truncated'])),
    );
    await expect(provider.execute('app.export', { connection, appId })).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    expect(storeArtifact).not.toHaveBeenCalled();
  });

  it('waits for the export receipt to be saved before reading temporary content metadata', async () => {
    const { provider, sdk } = setup({ storeArtifact: async () => ({ artifactId: 'artifact' }) });
    sdk.apps.exportApp.mockImplementation(async () => ({
      data: '',
      status: 201,
      headers: new Headers({ location: '/api/v1/temp-contents/temporary-export' }),
    }));
    let releaseReceipt!: () => void;
    const saved = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const onReceipt = vi.fn(async () => saved);
    const executing = provider.execute('app.export', { connection, appId }, onReceipt);
    await vi.waitFor(() =>
      expect(onReceipt).toHaveBeenCalledWith({ appId, exportId: 'temporary-export' }),
    );
    expect(sdk.tempContents.getTempFileDetails).not.toHaveBeenCalled();
    expect(sdk.tempContents.downloadTempFile).not.toHaveBeenCalled();
    releaseReceipt();
    await expect(executing).resolves.toMatchObject({ artifactId: 'artifact' });
    expect(onReceipt).toHaveBeenCalledTimes(1);
    expect(sdk.apps.exportApp).toHaveBeenCalledTimes(1);
  });

  it('stops after export creation if the durable receipt callback fails', async () => {
    const storeArtifact = vi.fn(async () => ({ artifactId: 'artifact' }));
    const { provider, sdk } = setup({ storeArtifact });
    sdk.apps.exportApp.mockImplementation(async () => ({
      data: '',
      status: 201,
      headers: new Headers({ location: '/api/v1/temp-contents/temporary-export' }),
    }));
    const onReceipt = vi.fn(async () => {
      throw new Error('Private storage failure');
    });
    await expect(
      provider.execute('app.export', { connection, appId }, onReceipt),
    ).rejects.toMatchObject({
      code: 'PARTIAL_APPLY',
      details: { outcome: 'uncertain' },
    });
    expect(onReceipt).toHaveBeenCalledWith({ appId, exportId: 'temporary-export' });
    expect(sdk.tempContents.getTempFileDetails).not.toHaveBeenCalled();
    expect(sdk.tempContents.downloadTempFile).not.toHaveBeenCalled();
    expect(storeArtifact).not.toHaveBeenCalled();
    expect(sdk.apps.exportApp).toHaveBeenCalledTimes(1);
  });

  it('resumes the exact saved temporary export after a failed download without another export call', async () => {
    const { provider, sdk } = setup({
      storeArtifact: async () => ({ artifactId: 'resumed-artifact' }),
    });
    sdk.apps.exportApp.mockImplementation(async () => ({
      data: '',
      status: 201,
      headers: new Headers({ location: '/api/v1/temp-contents/temporary-export' }),
    }));
    sdk.tempContents.downloadTempFile.mockRejectedValueOnce({ status: 503 });
    let receipt: { appId: string; exportId: string } | undefined;
    await expect(
      provider.execute('app.export', { connection, appId }, async (record) => {
        receipt = { appId: String(record.appId), exportId: String(record.exportId) };
      }),
    ).rejects.toMatchObject({ code: 'PARTIAL_APPLY' });
    expect(receipt).toEqual({ appId, exportId: 'temporary-export' });
    const resumed = await provider.resumeExport({ connection, appId }, receipt!);
    expect(resumed).toMatchObject({ artifactId: 'resumed-artifact', appId, byteLength: 11 });
    expect(resumed).not.toHaveProperty('exportId');
    expect(sdk.apps.exportApp).toHaveBeenCalledTimes(1);
    expect(sdk.tempContents.getTempFileDetails).toHaveBeenLastCalledWith(
      'temporary-export',
      options,
    );
    expect(sdk.tempContents.downloadTempFile).toHaveBeenLastCalledWith(
      'temporary-export',
      {},
      options,
    );
  });

  it('rejects a mismatched app or unsafe temporary ID before resuming an export', async () => {
    const { provider, sdk, apiFactory } = setup({
      storeArtifact: async () => ({ artifactId: 'artifact' }),
    });
    await expect(
      provider.resumeExport(
        { connection, appId },
        { appId: 'foreign-app', exportId: 'temporary-export' },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    for (const exportId of [
      '../temporary-export',
      'https://attacker.example/id',
      'temporary-export?token=secret',
    ])
      await expect(
        provider.resumeExport({ connection, appId }, { appId, exportId }),
      ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(apiFactory).not.toHaveBeenCalled();
    expect(sdk.apps.exportApp).not.toHaveBeenCalled();
    expect(sdk.tempContents.downloadTempFile).not.toHaveBeenCalled();
  });

  it('requires artifact storage and preserves size checks during export resumption', async () => {
    const missingStorage = setup();
    await expect(
      missingStorage.provider.resumeExport(
        { connection, appId },
        { appId, exportId: 'temporary-export' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(missingStorage.apiFactory).not.toHaveBeenCalled();
    const bounded = setup({
      storeArtifact: async () => ({ artifactId: 'artifact' }),
      maxArtifactBytes: 10,
    });
    await expect(
      bounded.provider.resumeExport({ connection, appId }, { appId, exportId: 'temporary-export' }),
    ).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
    expect(bounded.sdk.tempContents.downloadTempFile).not.toHaveBeenCalled();
    expect(bounded.sdk.apps.exportApp).not.toHaveBeenCalled();
  });

  it('fails before export if artifact storage is missing and rejects oversized results', async () => {
    const { provider, sdk } = setup();
    await expect(provider.execute('app.export', { connection, appId })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(sdk.apps.exportApp).not.toHaveBeenCalled();
    const bounded = setup({
      storeArtifact: async () => ({ artifactId: 'artifact' }),
      maxArtifactBytes: 2,
    });
    await expect(
      bounded.provider.execute('app.export', { connection, appId }),
    ).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
  });

  it('performs one bounded page and returns only the continuation cursor', async () => {
    const { provider, sdk } = setup();
    const result = await provider.execute('space.list', {
      connection,
      limit: 2,
      cursor: 'cursor-one',
    });
    expect(sdk.spaces.getSpaces).toHaveBeenCalledTimes(1);
    expect(sdk.spaces.getSpaces).toHaveBeenCalledWith(
      { limit: 2, next: 'cursor-one', name: undefined, type: undefined, sort: '+name' },
      options,
    );
    expect(result).toMatchObject({ count: 1, nextCursor: 'cursor-two' });
    expect(result).not.toHaveProperty('links');
    await expect(
      provider.execute('space.list', { connection, limit: 1_000 }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  it('maps memberships through space-scoped SDK methods and validates assignable roles', async () => {
    const { provider, sdk } = setup();
    await provider.execute('space.member.create', {
      connection,
      spaceId,
      assigneeId: 'user-1',
      roles: ['consumer'],
      type: 'user',
    });
    expect(sdk.spaces.createSpaceAssignment).toHaveBeenCalledWith(
      spaceId,
      { assigneeId: 'user-1', roles: ['consumer'], type: 'user' },
      options,
    );
    await expect(
      provider.execute('space.member.create', {
        connection,
        spaceId,
        assigneeId: 'user-1',
        roles: ['publisher'],
        type: 'user',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const expectedSourceVersion = await version(provider, 'space.member.delete', {
      spaceId,
      assignmentId: 'assignment-1',
    });
    await provider.execute('space.member.delete', {
      connection,
      spaceId,
      assignmentId: 'assignment-1',
      expectedSourceVersion,
    });
    expect(sdk.spaces.deleteSpaceAssignment).toHaveBeenCalledWith(spaceId, 'assignment-1', options);
  });

  it('prevents sharing an app from a different space and maps the typed patch representation', async () => {
    const { provider, sdk } = setup();
    await expect(
      provider.execute('space.share.create', {
        connection,
        spaceId: 'other-space',
        appId,
        assigneeId: 'user-1',
        roles: ['consumer'],
        type: 'user',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(sdk.spaces.createSpaceShare).not.toHaveBeenCalled();
    const expectedSourceVersion = await version(provider, 'space.share.update', {
      spaceId,
      shareId: 'share-1',
    });
    await provider.execute('space.share.update', {
      connection,
      spaceId,
      shareId: 'share-1',
      expectedSourceVersion,
      roles: ['consumer'],
      disabled: true,
    });
    expect(sdk.spaces.patchShare).toHaveBeenCalledWith(
      spaceId,
      'share-1',
      [
        { op: 'replace', path: '/roles', value: '["consumer"]' },
        { op: 'replace', path: '/disabled', value: 'true' },
      ],
      options,
    );
  });

  it('uploads checked bytes as multipart file content with the actual space DataFiles connection', async () => {
    const { provider, sdk } = setup();
    await provider.execute('datafile.upload', {
      connection,
      spaceId,
      name: 'data.csv',
      ...content(),
    });
    const body = (sdk.dataFiles.uploadDataFile.mock.calls as unknown[][])[0]?.[0] as {
      File: Blob;
      Json: Record<string, unknown>;
    };
    expect(await body.File.text()).toBe('a\n1\n');
    expect(body.Json).toMatchObject({
      connectionId: 'connection-1',
      name: 'data.csv',
      folder: false,
    });
  });

  it('rejects incorrect checksums, noncanonical base64, disallowed extensions and upload over quota', async () => {
    const { provider, sdk } = setup();
    await expect(
      provider.execute('datafile.upload', {
        connection,
        spaceId,
        name: 'data.csv',
        ...content(),
        contentSha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      provider.execute('datafile.upload', {
        connection,
        spaceId,
        name: 'data.csv',
        ...content(),
        contentBase64: '!!!!',
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    await expect(
      provider.execute('datafile.upload', { connection, spaceId, name: 'data.exe', ...content() }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    await expect(
      provider.execute('datafile.upload', {
        connection,
        spaceId,
        name: 'data.csv',
        ...content('a'.repeat(1_001)),
      }),
    ).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
    expect(sdk.dataFiles.uploadDataFile).not.toHaveBeenCalled();
  });

  it('supports a temporary content ID without pretending inline data was uploaded', async () => {
    const { provider, sdk } = setup();
    await provider.execute('datafile.upload', {
      connection,
      spaceId,
      name: 'data.csv',
      tempContentFileId: 'temporary-1',
    });
    expect(sdk.dataFiles.uploadDataFile).toHaveBeenCalledWith(
      {
        File: undefined,
        Json: {
          name: 'data.csv',
          connectionId: 'connection-1',
          tempContentFileId: 'temporary-1',
          folder: false,
          appId: undefined,
          folderId: undefined,
        },
      },
      options,
    );
  });

  it('preserves the existing space, folder, name and app scope during replacement', async () => {
    const { provider, sdk } = setup();
    const expectedSourceVersion = await version(provider, 'datafile.replace', { fileId: 'file-1' });
    await provider.execute('datafile.replace', {
      connection,
      fileId: 'file-1',
      expectedSourceVersion,
      ...content(),
    });
    expect(sdk.dataFiles.reuploadDataFile).toHaveBeenCalledWith(
      'file-1',
      {
        File: expect.any(Blob),
        Json: {
          name: 'data.csv',
          connectionId: 'connection-1',
          folderId: 'folder-1',
          appId,
          tempContentFileId: undefined,
        },
      },
      options,
    );
  });

  it('does not permit dataset deletion to recursively delete a folder', async () => {
    const { provider, sdk } = setup();
    sdk.dataFiles.getDataFile.mockImplementation(() => response({ ...fileResponse, folder: true }));
    const expectedSourceVersion = await version(provider, 'datafile.delete', { fileId: 'file-1' });
    await expect(
      provider.execute('datafile.delete', { connection, fileId: 'file-1', expectedSourceVersion }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(sdk.dataFiles.deleteDataFile).not.toHaveBeenCalled();
  });

  it('returns provider reload IDs/status while stripping log/error payloads', async () => {
    const { provider, sdk } = setup();
    const result = await provider.execute('reload.create', { connection, appId });
    expect(sdk.reloads.queueReload).toHaveBeenCalledWith({ appId, partial: false }, options);
    expect(result).toMatchObject({ reloadId: 'reload-1', status: 'QUEUED', terminal: false });
    expect(result).not.toHaveProperty('log');
    expect(result).not.toHaveProperty('errorMessage');
    expect(
      await provider.inspect('reload.cancel', { connection, reloadId: 'reload-1' }),
    ).toMatchObject({ appId, spaceId });
  });

  it('checks the reload app before retrieving a log artifact', async () => {
    const { provider, sdk } = setup({ storeArtifact: async () => ({ artifactId: 'artifact' }) });
    await expect(
      provider.execute('reload.log', { connection, appId: 'other-app', reloadId: 'reload-1' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(sdk.apps.getAppReloadLog).not.toHaveBeenCalled();
  });

  it('stores the installed SDK plain-text reload log response as a private UTF-8 artifact', async () => {
    const log = 'Reload failed: café — fixture only\npassword=secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request | string | URL, init?: RequestInit) => {
        const pathname = new URL(new Request(request, init).url).pathname;
        if (pathname === `/api/v1/apps/${appId}/reloads/logs/reload-1`)
          return new Response(log, { headers: { 'content-type': 'text/plain; charset=UTF-8' } });
        const data =
          pathname === '/api/v1/items'
            ? { data: [appItemResponse] }
            : pathname === '/api/v1/reloads/reload-1'
              ? reloadResponse
              : appResponse;
        return new Response(JSON.stringify(data), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const storeArtifact = vi.fn(async (blob: Blob) => {
      expect(await blob.text()).toBe(log);
      expect(blob.type).toBe('text/plain;charset=utf-8');
      return { artifactId: 'log-artifact' };
    });
    const provider = new CloudRestManagementProvider({
      getHostConfig: async () => ({ host: 'https://tenant.example', apiKey: 'test-placeholder' }),
      storeArtifact,
    });
    expect(
      await provider.execute('reload.log', { connection, appId, reloadId: 'reload-1' }),
    ).toEqual({
      artifactId: 'log-artifact',
      kind: 'reload-log',
      appId,
      filename: 'app-1-reload-1.log',
      byteLength: Buffer.byteLength(log, 'utf8'),
      sha256: createHash('sha256').update(log, 'utf8').digest('hex'),
    });
    expect(storeArtifact).toHaveBeenCalledTimes(1);
  });

  it('checks UTF-8 log bytes before storage and rejects unexpected structured responses', async () => {
    const storeArtifact = vi.fn(async () => ({ artifactId: 'log-artifact' }));
    const { provider, sdk } = setup({ storeArtifact, maxArtifactBytes: 3 });
    sdk.apps.getAppReloadLog.mockImplementation(() => response('éé'));
    await expect(
      provider.execute('reload.log', { connection, appId, reloadId: 'reload-1' }),
    ).rejects.toMatchObject({
      code: 'CAPACITY_EXHAUSTED',
    });
    sdk.apps.getAppReloadLog.mockImplementation(() => response({ message: 'password=secret' }));
    await expect(
      provider.execute('reload.log', { connection, appId, reloadId: 'reload-1' }),
    ).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    sdk.apps.getAppReloadLog.mockImplementation(async () => ({
      data: 'no',
      headers: new Headers({ 'content-type': 'text/html' }),
      status: 200,
    }));
    await expect(
      provider.execute('reload.log', { connection, appId, reloadId: 'reload-1' }),
    ).rejects.toMatchObject({
      code: 'TRANSIENT_UNAVAILABLE',
    });
    expect(storeArtifact).not.toHaveBeenCalled();
  });

  it('creates schedules using the modern Scheduling API with one explicit reload action', async () => {
    const { provider, sdk } = setup();
    const result = await provider.execute('schedule.create', {
      connection,
      appId,
      name: 'Daily',
      schedule: { recurrence: 'RRULE:FREQ=DAILY', timezone: 'UTC' },
    });
    expect(sdk.scheduling.tasks.createTaskWithoutQuery).toHaveBeenCalledWith(
      {
        name: 'Daily',
        specVersion: '0.8',
        version: '1.0.0',
        enabled: true,
        metadata: { spaceId, usage: 'ANALYTICS' },
        start: taskResponse.start,
        states: taskResponse.states,
      },
      options,
    );
    expect(result).toMatchObject({ taskId: 'task-1', appId, spaceId, enabled: true });
  });

  it('preserves schedule actions on update and detects out-of-band action changes', async () => {
    const { provider, sdk } = setup();
    const expectedSourceVersion = await version(provider, 'schedule.update', { taskId: 'task-1' });
    await provider.execute('schedule.update', {
      connection,
      taskId: 'task-1',
      expectedSourceVersion,
      enabled: false,
    });
    expect(sdk.scheduling.tasks.patchTask).toHaveBeenCalledWith(
      'task-1',
      [{ op: 'add', path: '/enabled', value: false }],
      options,
    );
    expect(sdk.scheduling.tasks.updateTask).not.toHaveBeenCalled();
    sdk.scheduling.tasks.getTask.mockImplementation(() =>
      response({ ...taskResponse, description: 'Changed' }),
    );
    await expect(
      provider.execute('schedule.delete', { connection, taskId: 'task-1', expectedSourceVersion }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(sdk.scheduling.tasks.deleteTask).not.toHaveBeenCalled();
  });

  it('uses the installed SDK schedule PATCH route and retains a stable receipt for an empty 204 response', async () => {
    let patched: Request | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request | string | URL, init?: RequestInit) => {
        const outgoing = new Request(request, init);
        const pathname = new URL(outgoing.url).pathname;
        if (outgoing.method === 'PATCH') {
          patched = outgoing;
          return new Response(null, { status: 204 });
        }
        const data =
          pathname === '/api/scheduling/tasks/task-1'
            ? taskResponse
            : pathname === '/api/v1/items'
              ? { data: [appItemResponse] }
              : appResponse;
        return new Response(JSON.stringify(data), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const provider = new CloudRestManagementProvider({
      getHostConfig: async () => ({ host: 'https://tenant.example', apiKey: 'test-placeholder' }),
    });
    const expectedSourceVersion = await version(provider, 'schedule.update', { taskId: 'task-1' });
    const schedule = { recurrence: 'RRULE:FREQ=WEEKLY', timezone: 'UTC' };
    const result = await provider.execute('schedule.update', {
      connection,
      taskId: 'task-1',
      expectedSourceVersion,
      name: 'Weekly',
      enabled: false,
      schedule,
    });
    expect(patched?.url).toBe('https://tenant.example/api/scheduling/tasks/task-1');
    expect(await patched?.json()).toEqual([
      { op: 'add', path: '/name', value: 'Weekly' },
      { op: 'add', path: '/enabled', value: false },
      { op: 'add', path: '/start/schedule', value: schedule },
    ]);
    expect(result).toMatchObject({
      taskId: 'task-1',
      appId,
      updated: true,
      name: 'Weekly',
      enabled: false,
    });
    expect(result).not.toHaveProperty('verified');
    expect(
      await provider.verify(
        'schedule.update',
        { connection, taskId: 'task-1', enabled: false },
        result,
      ),
    ).toMatchObject({ verified: false });
  });

  it('adds a schedule without inventing a starting state when the existing task has no start definition', async () => {
    const { provider, sdk } = setup();
    sdk.scheduling.tasks.getTask.mockImplementation(() =>
      response({ ...taskResponse, start: undefined }),
    );
    const expectedSourceVersion = await version(provider, 'schedule.update', { taskId: 'task-1' });
    const schedule = { recurrence: 'RRULE:FREQ=DAILY', timezone: 'UTC' };
    await provider.execute('schedule.update', {
      connection,
      taskId: 'task-1',
      expectedSourceVersion,
      schedule,
    });
    expect(sdk.scheduling.tasks.patchTask).toHaveBeenCalledWith(
      'task-1',
      [{ op: 'add', path: '/start', value: { schedule } }],
      options,
    );
    expect(sdk.scheduling.tasks.updateTask).not.toHaveBeenCalled();
  });

  it('marks only direct schedule validation rejection as rejected and preserves uncertain timeout outcomes', async () => {
    const { provider, sdk } = setup();
    const expectedSourceVersion = await version(provider, 'schedule.update', { taskId: 'task-1' });
    const input = { connection, taskId: 'task-1', expectedSourceVersion, enabled: false };
    sdk.scheduling.tasks.patchTask.mockRejectedValueOnce({
      status: 400,
      data: { message: 'private-provider-details' },
    });
    await expect(provider.execute('schedule.update', input)).rejects.toMatchObject({
      code: 'MALFORMED_REQUEST',
      details: { outcome: 'rejected', providerStatus: 400 },
    });
    sdk.scheduling.tasks.patchTask.mockRejectedValueOnce(new Error('private-provider-timeout'));
    await expect(provider.execute('schedule.update', input)).rejects.toMatchObject({
      code: 'PARTIAL_APPLY',
      details: { outcome: 'uncertain' },
    });
    expect(sdk.scheduling.tasks.patchTask).toHaveBeenCalledTimes(2);
    expect(sdk.scheduling.tasks.updateTask).not.toHaveBeenCalled();
  });

  it('honors bounded Retry-After and never replays a throttled write', async () => {
    const { provider, sdk } = setup();
    sdk.apps.createApp.mockRejectedValueOnce({
      status: 429,
      headers: new Headers({ 'retry-after': '120' }),
      data: 'secret',
    });
    await expect(
      provider.execute('app.create', { connection, name: 'Sales', spaceId }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 120 });
    expect(sdk.apps.createApp).toHaveBeenCalledTimes(1);
  });

  it('reports uncertain write outcome after provider timeout without leaking the raw error', async () => {
    const { provider, sdk } = setup();
    sdk.apps.createApp.mockRejectedValueOnce(new Error('request includes Bearer credential'));
    await expect(
      provider.execute('app.create', { connection, name: 'Sales', spaceId }),
    ).rejects.toMatchObject({
      code: 'PARTIAL_APPLY',
      details: { outcome: 'uncertain' },
      message: 'Qlik did not confirm the write outcome; reconcile the resource before retrying.',
    });
    expect(sdk.apps.createApp).toHaveBeenCalledTimes(1);
  });

  it('validates strict action schemas and never accepts a raw endpoint or injected extra property', () => {
    expect(
      REST_ACTION_SCHEMAS['app.create'].safeParse({
        connection,
        name: 'Sales',
        spaceId,
        endpoint: '/admin/delete',
      }).success,
    ).toBe(false);
    expect(
      REST_ACTION_SCHEMAS['schedule.create'].safeParse({
        connection,
        appId,
        name: 'Daily',
        schedule: { recurrence: 'RRULE:FREQ=DAILY', cron: '* * * * *', timezone: 'UTC' },
      }).success,
    ).toBe(false);
    expect(
      REST_ACTION_SCHEMAS['datafile.upload'].safeParse({
        connection,
        name: '../secret.csv',
        spaceId,
        ...content(),
      }).success,
    ).toBe(false);
  });
});
