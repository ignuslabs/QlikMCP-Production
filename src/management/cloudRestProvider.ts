import { createHash } from 'node:crypto';
import { createQlikApi } from '@qlik/api';
import type { HostConfig } from '@qlik/api/auth';
import type { NxApp } from '@qlik/api/apps';
import type { DataFileUploadResponse } from '@qlik/api/data-files';
import type { ItemResultResponseBody } from '@qlik/api/items';
import type { Reload } from '@qlik/api/reloads';
import type { Assignment, Share, Space } from '@qlik/api/spaces';
import type { Task } from '@qlik/api/scheduling/tasks';
import { createError, isHarnessError } from '../domain/errors.js';
import {
  isRestManagementAction,
  REST_ACTION_SCHEMAS,
  REST_READ_ACTIONS,
  type RestManagementAction,
} from './restContracts.js';

type QlikApi = ReturnType<typeof createQlikApi>;
type ApiCallOptions = NonNullable<Parameters<QlikApi['apps']['getAppInfo']>[1]>;
/** Kept narrow to support transport-level SDK tests without untyped dispatch. */
export type CloudRestApi = Pick<
  QlikApi,
  'apps' | 'items' | 'spaces' | 'dataFiles' | 'reloads' | 'scheduling' | 'tempContents'
>;
export interface CloudRestManagementOptions {
  getHostConfig(connection: string): Promise<HostConfig>;
  apiFactory?: (options: { hostConfig: HostConfig }) => CloudRestApi;
  storeArtifact?: (
    blob: Blob,
    metadata: {
      connection: string;
      appId: string;
      kind: 'app-export' | 'reload-log';
      filename: string;
    },
  ) => Promise<{ artifactId: string }>;
  timeoutMs?: number;
  maxUploadBytes?: number;
  maxArtifactBytes?: number;
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function identifier(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(value)) {
    throw createError('MALFORMED_REQUEST', { message: `A valid ${field} is required.` });
  }
  return value;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}

function withVersion(data: Record<string, unknown>): Record<string, unknown> {
  return {
    ...data,
    sourceVersion: createHash('sha256')
      .update(JSON.stringify(stable(data)))
      .digest('hex'),
  };
}

function matchesReadback(actual: unknown, expected: unknown, field?: string): boolean {
  if (field === 'roles' && Array.isArray(actual) && Array.isArray(expected))
    return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  if (expected && typeof expected === 'object' && !Array.isArray(expected))
    return Object.entries(record(expected)).every(([key, value]) =>
      matchesReadback(record(actual)[key], value, key),
    );
  return JSON.stringify(stable(actual)) === JSON.stringify(stable(expected));
}

function select(data: object, fields: readonly string[]): Record<string, unknown> {
  const source = record(data);
  return Object.fromEntries(
    fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]),
  );
}

function appMetadata(
  value: NxApp,
  appId?: string,
  spaceId?: string | null,
): Record<string, unknown> {
  const id = value.attributes?.id ?? appId;
  if (!id)
    throw createError('PARTIAL_APPLY', {
      message: 'Qlik did not return the app identifier; reconcile before retrying.',
      details: { outcome: 'uncertain' },
    });
  return withVersion({
    resourceType: 'app',
    resourceId: id,
    appId: id,
    ...select(value.attributes ?? {}, [
      'name',
      'description',
      'modifiedDate',
      'createdDate',
      'lastReloadTime',
      'publishTime',
      'originAppId',
      'ownerId',
      'hasSectionAccess',
      'usage',
    ]),
    ...(spaceId !== undefined ? { spaceId } : {}),
    privileges: value.privileges ?? [],
  });
}

function appCatalogMetadata(value: ItemResultResponseBody): Record<string, unknown> {
  if (value.resourceType !== 'app' || !value.resourceId)
    throw createError('TRANSIENT_UNAVAILABLE', {
      message: 'Qlik returned an app catalog entry without an app identifier.',
    });
  // Catalog IDs identify Items, not apps. Partial catalog metadata cannot provide a write version.
  return {
    resourceType: 'app',
    resourceId: value.resourceId,
    appId: value.resourceId,
    ...select(value, ['name', 'description']),
    spaceId: value.spaceId || null,
    createdDate: value.resourceCreatedAt,
    modifiedDate: value.resourceUpdatedAt,
  };
}

function fileMetadata(value: DataFileUploadResponse): Record<string, unknown> {
  return withVersion({
    resourceType: 'datafile',
    resourceId: value.id,
    fileId: value.id,
    ...select(value, [
      'name',
      'size',
      'folder',
      'folderId',
      'folderPath',
      'createdDate',
      'modifiedDate',
      'contentUpdatedDate',
      'ownerId',
      'appId',
      'actions',
    ]),
    spaceId: value.spaceId ?? null,
  });
}

function spaceMetadata(value: Space): Record<string, unknown> {
  return withVersion({
    resourceType: 'space',
    resourceId: value.id,
    spaceId: value.id,
    ...select(value, ['name', 'description', 'type', 'ownerId', 'createdAt', 'updatedAt']),
    roles: value.meta?.roles ?? [],
    actions: value.meta?.actions ?? [],
    assignableRoles: value.meta?.assignableRoles ?? [],
  });
}

function memberMetadata(value: Assignment): Record<string, unknown> {
  return withVersion({
    resourceType: 'space-member',
    resourceId: value.id,
    assignmentId: value.id,
    ...select(value, ['spaceId', 'assigneeId', 'roles', 'type', 'createdAt', 'updatedAt']),
  });
}

function shareMetadata(value: Share): Record<string, unknown> {
  return withVersion({
    resourceType: 'space-share',
    resourceId: value.id,
    shareId: value.id,
    appId: value.resourceId,
    ...select(value, [
      'spaceId',
      'assigneeId',
      'roles',
      'type',
      'disabled',
      'createdAt',
      'updatedAt',
    ]),
  });
}

function reloadMetadata(value: Reload): Record<string, unknown> {
  // Logs and provider errorMessage can contain script text, credentials, and data values.
  return withVersion({
    resourceType: 'reload',
    resourceId: value.id,
    reloadId: value.id,
    ...select(value, [
      'appId',
      'status',
      'partial',
      'creationTime',
      'startTime',
      'endTime',
      'engineTime',
      'errorCode',
    ]),
    terminal: ['SUCCEEDED', 'FAILED', 'CANCELED', 'EXCEEDED_LIMIT'].includes(value.status),
  });
}

function taskAppId(task: Task): string {
  const ids = new Set<string>();
  for (const state of task.states ?? [])
    for (const event of state.onEvents ?? [])
      for (const action of event.actions ?? []) {
        const ref = action.functionRef;
        if (typeof ref !== 'object' || ref.refName !== 'app.reload')
          throw createError('MALFORMED_REQUEST', {
            message: 'Only tasks with an explicit app.reload action are supported.',
          });
        ids.add(identifier(record(ref.arguments), 'appId'));
      }
  if (ids.size !== 1)
    throw createError('MALFORMED_REQUEST', {
      message: 'A managed reload task must target exactly one app.',
    });
  const appId = [...ids][0]!;
  if (task.resourceId && task.resourceId !== appId)
    throw createError('IDEMPOTENCY_CONFLICT', {
      message: 'The schedule resource and reload action target disagree.',
    });
  return appId;
}

function taskMetadata(value: Task): Record<string, unknown> {
  if (!value.id)
    throw createError('PARTIAL_APPLY', {
      message: 'Qlik did not return the task identifier; reconcile before retrying.',
      details: { outcome: 'uncertain' },
    });
  const safe = {
    resourceType: 'schedule',
    resourceId: value.id,
    taskId: value.id,
    appId: taskAppId(value),
    ...select(value, ['name', 'enabled', 'description', 'version', 'specVersion']),
    schedule: value.start?.schedule,
    ...select(value.metadata ?? {}, ['createdAt', 'updatedAt', 'disabledCode']),
    spaceId: value.metadata?.spaceId || null,
  };
  // Include the complete definition in the digest to catch edits to actions/events without exposing it.
  const sourceVersion = createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
  return { ...safe, sourceVersion };
}

function nextCursor(
  href: string | null | undefined,
  parameter: 'next' | 'page',
): string | undefined {
  if (!href) return undefined;
  try {
    const value = new URL(href, 'https://qlik.invalid').searchParams.get(parameter);
    if (!value || value.length > 2_048) throw new Error('Invalid cursor');
    return value;
  } catch {
    throw createError('TRANSIENT_UNAVAILABLE', {
      message: 'Qlik returned an invalid continuation cursor.',
    });
  }
}

function pageResult(
  items: Record<string, unknown>[],
  href: string | null | undefined,
  parameter: 'next' | 'page',
  limit: number,
): Record<string, unknown> {
  if (items.length > limit)
    throw createError('TRANSIENT_UNAVAILABLE', {
      message: 'Qlik returned more items than the bounded page limit.',
    });
  const cursor = nextCursor(href, parameter);
  return { items, count: items.length, ...(cursor ? { nextCursor: cursor } : {}) };
}

/** Real Qlik Cloud REST operations. SDK/API responses are not claims of end-to-end verification. */
export class CloudRestManagementProvider {
  private readonly callOptions: ApiCallOptions;
  constructor(private readonly options: CloudRestManagementOptions) {
    this.callOptions = {
      noCache: true,
      timeoutMs: Math.min(Math.max(options.timeoutMs ?? 30_000, 1_000), 120_000),
    };
  }

  private async api(connection: string): Promise<CloudRestApi> {
    return (this.options.apiFactory ?? createQlikApi)({
      hostConfig: await this.options.getHostConfig(connection),
    });
  }

  private failure(error: unknown, mutation: boolean): never {
    if (isHarnessError(error)) throw error;
    const status = record(error).status;
    if (status === 401 || status === 403) throw createError('PERMISSION_DENIED');
    if (status === 404) throw createError('NOT_FOUND');
    if (status === 400 || status === 422)
      throw createError('MALFORMED_REQUEST', {
        message: 'Qlik rejected the validated operation parameters.',
      });
    if (status === 409 || status === 412 || status === 423)
      throw createError('IDEMPOTENCY_CONFLICT', {
        message: 'The Qlik resource changed, conflicts, or is locked; inspect it before retrying.',
      });
    if (status === 413)
      throw createError('CAPACITY_EXHAUSTED', {
        message: 'The upload exceeds the Qlik capacity limit.',
      });
    if (status === 429) {
      const headers = record(error).headers;
      const retryAfter = headers instanceof Headers ? headers.get('retry-after') : undefined;
      const numeric = retryAfter ? Number(retryAfter) : NaN;
      const seconds = Number.isFinite(numeric)
        ? numeric
        : retryAfter
          ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1_000)
          : 15;
      throw createError('RATE_LIMITED', {
        retryAfterSeconds: Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 3_600) : 15,
      });
    }
    if (mutation)
      throw createError('PARTIAL_APPLY', {
        message: 'Qlik did not confirm the write outcome; reconcile the resource before retrying.',
        details: { outcome: 'uncertain' },
      });
    throw createError('TRANSIENT_UNAVAILABLE', {
      message: 'The Qlik management service could not complete the read.',
    });
  }

  private async readApp(api: CloudRestApi, appId: string): Promise<Record<string, unknown>> {
    const [app, catalog] = await Promise.all([
      api.apps.getAppInfo(appId, this.callOptions),
      api.items
        .getItems(
          { resourceType: 'app', resourceId: appId, limit: 2, noActions: true },
          this.callOptions,
        )
        .catch((error: unknown) => this.failure(error, false)),
    ]);
    const items = catalog.data.data.filter((item) => item.resourceId === appId);
    // NxAttributes does not declare spaceId. Derive authorization context from Items, never guess personal space.
    if (items.length !== 1)
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'The app space could not be resolved uniquely from the Qlik catalog.',
      });
    return appMetadata(app.data, appId, items[0]!.spaceId || null);
  }

  private async source<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (record(error).status === 404)
        throw createError('NOT_FOUND', { details: { missingInspectedResource: true } });
      throw error;
    }
  }

  private async fileConnection(api: CloudRestApi, spaceId: string | null): Promise<string> {
    const response = await api.dataFiles.getDataFilesConnections(
      { limit: 2, ...(spaceId ? { spaceId } : { personal: true }) },
      this.callOptions,
    );
    const matches = response.data.data.filter((entry) => (entry.spaceId || null) === spaceId);
    if (matches.length !== 1 || response.data.links.next?.href)
      throw createError('NOT_CONFIGURED', {
        message: 'The target space does not have one unambiguous DataFiles connection.',
      });
    return matches[0]!.id;
  }

  private async inspectInternal(
    api: CloudRestApi,
    action: RestManagementAction,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let result: Record<string, unknown>;
    if (action.startsWith('space.member.') && input.assignmentId)
      result = memberMetadata(
        (
          await this.source(() =>
            api.spaces.getSpaceAssignment(
              identifier(input, 'spaceId'),
              identifier(input, 'assignmentId'),
              this.callOptions,
            ),
          )
        ).data,
      );
    else if (action.startsWith('space.share.') && input.shareId)
      result = shareMetadata(
        (
          await this.source(() =>
            api.spaces.getSpaceShare(
              identifier(input, 'spaceId'),
              identifier(input, 'shareId'),
              this.callOptions,
            ),
          )
        ).data,
      );
    else if (action.startsWith('datafile.') && input.fileId)
      result = fileMetadata(
        (
          await this.source(() =>
            api.dataFiles.getDataFile(identifier(input, 'fileId'), this.callOptions),
          )
        ).data,
      );
    else if (action.startsWith('reload.') && input.reloadId) {
      result = reloadMetadata(
        (
          await this.source(() =>
            api.reloads.getReload(identifier(input, 'reloadId'), this.callOptions),
          )
        ).data,
      );
      if (input.appId && result.appId !== input.appId)
        throw createError('PERMISSION_DENIED', {
          message: 'The reload belongs to a different app.',
        });
      const app = await this.readApp(api, identifier(result, 'appId'));
      result = { ...result, spaceId: app.spaceId };
    } else if (action.startsWith('schedule.') && input.taskId) {
      result = taskMetadata(
        (
          await this.source(() =>
            api.scheduling.tasks.getTask(identifier(input, 'taskId'), this.callOptions),
          )
        ).data,
      );
      const app = await this.readApp(api, identifier(result, 'appId'));
      result = { ...result, spaceId: app.spaceId };
    } else if (input.appId)
      result = await this.source(() => this.readApp(api, identifier(input, 'appId')));
    else if (typeof input.spaceId === 'string')
      result = spaceMetadata(
        (
          await this.source(() =>
            api.spaces.getSpace(identifier(input, 'spaceId'), this.callOptions),
          )
        ).data,
      );
    else
      result = {
        resourceType: 'connection',
        resourceId: identifier(input, 'connection'),
        ...(input.spaceId === null ? { spaceId: null } : {}),
      };
    return {
      ...result,
      exists: true,
      ...(Object.hasOwn(input, 'spaceId') ? { targetSpaceId: input.spaceId } : {}),
    };
  }

  /** Read-only source discovery for authorization and approval; missing means HTTP 404 only. */
  async inspect(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!isRestManagementAction(action))
      throw createError('MALFORMED_REQUEST', { message: 'Unsupported Qlik management action.' });
    try {
      return await this.inspectInternal(
        await this.api(identifier(input, 'connection')),
        action,
        input,
      );
    } catch (error) {
      if (isHarnessError(error) && error.details?.missingInspectedResource === true)
        return { exists: false };
      this.failure(error, false);
    }
  }

  /** Independent readback. Retain the acknowledged result IDs if this fails or returns pending. */
  async verify(
    action: string,
    input: Record<string, unknown>,
    result: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!isRestManagementAction(action))
      throw createError('MALFORMED_REQUEST', { message: 'Unsupported Qlik management action.' });
    if (action === 'app.export' || action === 'reload.log')
      return {
        verified: false,
        verificationScope: 'artifact-storage',
        reason: 'Artifact retrieval must be verified by the owning storage service.',
      };
    if (REST_READ_ACTIONS.has(action))
      return { verified: true, verificationScope: 'provider-read' };
    if (
      (action === 'app.duplicate' || action === 'app.publish') &&
      (typeof result.appId !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,256}$/.test(result.appId) ||
        result.appId === input.appId ||
        (result.resourceId !== undefined && result.resourceId !== result.appId))
    )
      return {
        verified: false,
        verificationScope: 'resource-readback',
        reason: 'A distinct destination app identifier is required in the Qlik write receipt.',
      };
    const probe: Record<string, unknown> = { connection: identifier(input, 'connection') };
    const deleted = action.endsWith('.delete');
    const expected: Record<string, unknown> =
      action === 'app.duplicate' || action === 'app.publish' ? { appId: result.appId } : {};
    for (const key of [
      'appId',
      'spaceId',
      'fileId',
      'assignmentId',
      'shareId',
      'reloadId',
      'taskId',
    ]) {
      const value = result[key] ?? input[key];
      if (value !== undefined) probe[key] = value;
    }
    const comparable: Record<string, readonly string[]> = {
      'app.create': ['name', 'description', 'spaceId'],
      'app.update': ['name', 'description'],
      'app.duplicate': ['name', 'description', 'spaceId'],
      'app.move': ['spaceId'],
      'app.publish': ['name', 'description', 'spaceId'],
      'space.create': ['name', 'description', 'type'],
      'space.update': ['name', 'description'],
      'space.member.create': ['assigneeId', 'roles', 'type'],
      'space.member.update': ['roles'],
      'space.share.create': ['appId', 'assigneeId', 'roles', 'type'],
      'space.share.update': ['roles', 'disabled'],
      'datafile.upload': ['name', 'spaceId', 'appId', 'folderId'],
      'datafile.replace': ['name'],
      'reload.create': ['appId', 'partial'],
      'schedule.create': ['name', 'appId', 'enabled', 'schedule'],
      'schedule.update': ['name', 'enabled', 'schedule'],
    };
    for (const key of comparable[action] ?? []) {
      if (input[key] !== undefined) expected[key] = input[key];
    }
    if (action.startsWith('datafile.') && !deleted) {
      for (const key of ['name', 'spaceId', 'appId', 'folderId', 'size']) {
        if (input[key] === undefined && result[key] !== undefined) expected[key] = result[key];
      }
      if (typeof input.contentBase64 === 'string')
        expected.size = Buffer.byteLength(input.contentBase64, 'base64');
    }
    const observed = await this.inspect(action, probe);
    const matches = deleted
      ? observed.exists === false
      : observed.exists === true &&
        Object.entries(expected).every(([key, value]) =>
          matchesReadback(observed[key], value, key),
        );
    const published =
      action !== 'app.publish' ||
      (typeof observed.publishTime === 'string' && observed.publishTime.length > 0);
    const cancelled =
      action !== 'reload.cancel' ||
      observed.status === 'CANCELING' ||
      observed.status === 'CANCELED';
    return {
      verified: matches && published && cancelled,
      verificationScope:
        action === 'reload.create'
          ? 'reload-job'
          : action === 'reload.cancel'
            ? 'cancellation-request'
            : action.startsWith('datafile.') && !deleted
              ? 'metadata-and-size'
              : 'resource-readback',
      observed,
      ...(!matches || !published || !cancelled
        ? { reason: 'Qlik readback has not confirmed all requested changes.' }
        : {}),
    };
  }

  private content(input: {
    contentBase64?: string;
    contentSha256?: string;
    tempContentFileId?: string;
  }): Blob | undefined {
    if (input.tempContentFileId) return undefined;
    const encoded = input.contentBase64!;
    if (
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      throw createError('MALFORMED_REQUEST', {
        message: 'Dataset content is not canonical base64.',
      });
    const data = Buffer.from(encoded, 'base64');
    if (
      data.length === 0 ||
      data.length > Math.min(this.options.maxUploadBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES)
    )
      throw createError('CAPACITY_EXHAUSTED', {
        message: 'Dataset content is empty or exceeds the bounded direct upload size.',
      });
    if (createHash('sha256').update(data).digest('hex') !== input.contentSha256)
      throw createError('IDEMPOTENCY_CONFLICT', {
        message: 'The dataset content checksum does not match the approved upload.',
      });
    return new Blob([data]);
  }

  private async uploadQuota(
    api: CloudRestApi,
    name: string,
    content: Blob | undefined,
  ): Promise<void> {
    const quota = (await api.dataFiles.getDataFilesQuotas(this.callOptions)).data;
    const extension = name.split('.').pop()?.toLowerCase();
    if (
      !extension ||
      !quota.allowedExtensions
        .map((item) => item.replace(/^\./, '').toLowerCase())
        .includes(extension)
    )
      throw createError('MALFORMED_REQUEST', {
        message: 'The file extension is not permitted by this Qlik tenant.',
      });
    if (content && content.size > quota.maxFileSize)
      throw createError('CAPACITY_EXHAUSTED', {
        message:
          'The dataset exceeds the tenant direct upload limit; use Qlik temporary content staging.',
      });
  }

  private async exportContent(
    api: CloudRestApi,
    response: { data: unknown; headers: Headers; status: number },
    appId: string,
    onReceipt?: (record: Record<string, unknown>) => Promise<void>,
  ): Promise<Blob> {
    if (response.status === 200 && response.data instanceof Blob) return response.data;
    // The installed declaration only describes 200/Blob; Cloud also returns 201 with a temporary path.
    const temporaryId = response.headers
      .get('location')
      ?.match(/^\/api\/v1\/temp-contents\/([A-Za-z0-9_-]{1,256})$/)?.[1];
    if (response.status !== 201 || !temporaryId)
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'Qlik did not return a supported app export or temporary-content path.',
      });
    // Persist the provider receipt before any fallible follow-up read or artifact download.
    await onReceipt?.({ appId, exportId: temporaryId });
    return this.downloadExportContent(api, temporaryId);
  }

  private async downloadExportContent(api: CloudRestApi, temporaryId: string): Promise<Blob> {
    // Never fetch a provider-supplied URL: only pass the validated ID to the tenant-bound SDK.
    const details = await api.tempContents.getTempFileDetails(temporaryId, this.callOptions);
    if (details.status !== 200 || (details.data.ID && details.data.ID !== temporaryId))
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'The temporary app export metadata is not ready or does not match its receipt.',
      });
    const rawSize: unknown = details.data.Size;
    const byteLength =
      typeof rawSize === 'string' && /^\d+$/.test(rawSize)
        ? Number(rawSize)
        : typeof rawSize === 'number'
          ? rawSize
          : NaN;
    if (!Number.isSafeInteger(byteLength) || byteLength < 1)
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'The temporary app export does not have a valid byte length.',
      });
    if (byteLength > (this.options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES))
      throw createError('CAPACITY_EXHAUSTED', {
        message: 'The returned artifact exceeds the configured storage limit.',
      });
    const downloaded = await api.tempContents.downloadTempFile(temporaryId, {}, this.callOptions);
    if (
      downloaded.status !== 200 ||
      !(downloaded.data instanceof Blob) ||
      downloaded.data.size !== byteLength
    )
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'Qlik has not returned the complete app export matching its declared byte length.',
      });
    return downloaded.data;
  }

  /** Resume only an authenticated, owner-bound receipt after the caller reauthorizes the app. */
  async resumeExport(
    input: { connection: string; appId: string },
    receipt: { appId: string; exportId: string },
  ): Promise<Record<string, unknown>> {
    const connection = identifier(input, 'connection');
    const appId = identifier(input, 'appId');
    if (receipt.appId !== appId)
      throw createError('PERMISSION_DENIED', {
        message: 'The export receipt belongs to a different app.',
      });
    if (typeof receipt.exportId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(receipt.exportId))
      throw createError('MALFORMED_REQUEST', {
        message: 'The export receipt does not contain a valid temporary-content identifier.',
      });
    if (!this.options.storeArtifact)
      throw createError('NOT_CONFIGURED', {
        message: 'Secure artifact storage is required for downloads.',
      });
    try {
      const content = await this.downloadExportContent(
        await this.api(connection),
        receipt.exportId,
      );
      return await this.artifact(content, {
        connection,
        appId,
        kind: 'app-export',
        filename: `${appId}.qvf`,
      });
    } catch (error) {
      this.failure(error, false);
    }
  }

  private reloadLogContent(value: unknown, headers: Headers): Blob {
    if (value instanceof Blob) return value;
    const mediaType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (typeof value !== 'string' || (mediaType && mediaType !== 'text/plain'))
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'Qlik did not return a plain text reload log.',
      });
    // The SDK declares DownloadableBlob but decodes the documented text/plain response as a string.
    if (Buffer.byteLength(value, 'utf8') > (this.options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES))
      throw createError('CAPACITY_EXHAUSTED', {
        message: 'The returned artifact exceeds the configured storage limit.',
      });
    return new Blob([value], { type: 'text/plain;charset=utf-8' });
  }

  private async artifact(
    blob: Blob,
    metadata: Parameters<NonNullable<CloudRestManagementOptions['storeArtifact']>>[1],
  ): Promise<Record<string, unknown>> {
    if (!(blob instanceof Blob))
      throw createError('TRANSIENT_UNAVAILABLE', {
        message: 'Qlik did not return downloadable binary content.',
      });
    if (blob.size > (this.options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES))
      throw createError('CAPACITY_EXHAUSTED', {
        message: 'The returned artifact exceeds the configured storage limit.',
      });
    const result = await this.options.storeArtifact!(blob, metadata);
    const digest = createHash('sha256');
    for await (const chunk of blob.stream()) digest.update(chunk);
    return {
      artifactId: result.artifactId,
      kind: metadata.kind,
      appId: metadata.appId,
      filename: metadata.filename,
      byteLength: blob.size,
      sha256: digest.digest('hex'),
    };
  }

  async execute(
    action: string,
    input: Record<string, unknown>,
    onReceipt?: (record: Record<string, unknown>) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    if (!isRestManagementAction(action))
      throw createError('MALFORMED_REQUEST', { message: 'Unsupported Qlik management action.' });
    const parsed = REST_ACTION_SCHEMAS[action].safeParse(input);
    if (!parsed.success)
      throw createError('MALFORMED_REQUEST', {
        message: 'The management action input does not match its exact schema.',
      });
    const value = parsed.data;
    if ((action === 'app.export' || action === 'reload.log') && !this.options.storeArtifact)
      throw createError('NOT_CONFIGURED', {
        message: 'Secure artifact storage is required for downloads.',
      });
    let dispatchedWrite = false;
    try {
      const api = await this.api(identifier(value, 'connection'));
      if ('expectedSourceVersion' in value) {
        const current = await this.inspectInternal(api, action, value);
        if (current.sourceVersion !== value.expectedSourceVersion)
          throw createError('IDEMPOTENCY_CONFLICT', {
            message: 'The Qlik source changed after it was inspected; create a fresh plan.',
          });
      }
      // No automatic retries: a timed-out write may already have committed at Qlik.
      dispatchedWrite = !REST_READ_ACTIONS.has(action);
      switch (action) {
        case 'app.list': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const r = await api.items.getItems(
            {
              resourceType: 'app',
              limit: p.limit,
              next: p.cursor,
              name: p.name,
              spaceId: p.spaceId === null ? 'personal' : p.spaceId,
              sort: '+name',
              noActions: true,
            },
            this.callOptions,
          );
          return pageResult(
            r.data.data.map(appCatalogMetadata),
            r.data.links?.next?.href,
            'next',
            p.limit,
          );
        }
        case 'app.create': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          return appMetadata(
            (
              await api.apps.createApp(
                {
                  attributes: {
                    name: p.name,
                    description: p.description,
                    locale: p.locale,
                    ...(p.spaceId ? { spaceId: p.spaceId } : {}),
                  },
                },
                this.callOptions,
              )
            ).data,
            undefined,
            p.spaceId,
          );
        }
        case 'app.get':
          return await this.readApp(api, identifier(value, 'appId'));
        case 'app.update': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          return appMetadata(
            (
              await api.apps.updateAppInfo(
                p.appId,
                { attributes: { name: p.name, description: p.description } },
                this.callOptions,
              )
            ).data,
            p.appId,
          );
        }
        case 'app.duplicate': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          return appMetadata(
            (
              await api.apps.copyApp(
                p.appId,
                {
                  attributes: {
                    name: p.name,
                    description: p.description,
                    ...(p.spaceId ? { spaceId: p.spaceId } : {}),
                  },
                },
                this.callOptions,
              )
            ).data,
            undefined,
            p.spaceId,
          );
        }
        case 'app.move': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const response =
            p.spaceId === null
              ? await api.apps.removeAppFromSpace(p.appId, this.callOptions)
              : await api.apps.moveAppToSpace(p.appId, { spaceId: p.spaceId }, this.callOptions);
          return appMetadata(response.data, p.appId, p.spaceId);
        }
        case 'app.delete': {
          const appId = identifier(value, 'appId');
          await api.apps.deleteApp(appId, this.callOptions);
          return { appId, resourceId: appId, deleted: true };
        }
        case 'app.publish': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const target = (await api.spaces.getSpace(p.spaceId, this.callOptions)).data;
          if (target.type !== 'managed')
            throw createError('MALFORMED_REQUEST', {
              message: 'Publishing requires a managed destination space.',
            });
          return appMetadata(
            (
              await api.apps.publishApp(
                p.appId,
                {
                  spaceId: p.spaceId,
                  data: p.data,
                  attributes: { name: p.name, description: p.description },
                },
                this.callOptions,
              )
            ).data,
            undefined,
            p.spaceId,
          );
        }
        case 'app.export': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const response = await api.apps.exportApp(
            p.appId,
            { NoData: p.noData },
            this.callOptions,
          );
          return await this.artifact(await this.exportContent(api, response, p.appId, onReceipt), {
            connection: p.connection,
            appId: p.appId,
            kind: 'app-export',
            filename: `${p.appId}.qvf`,
          });
        }
        case 'space.list': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const r = await api.spaces.getSpaces(
            { limit: p.limit, next: p.cursor, name: p.name, type: p.type, sort: '+name' },
            this.callOptions,
          );
          return pageResult(
            (r.data.data ?? []).map(spaceMetadata),
            r.data.links?.next?.href,
            'next',
            p.limit,
          );
        }
        case 'space.get':
          return spaceMetadata(
            (await api.spaces.getSpace(identifier(value, 'spaceId'), this.callOptions)).data,
          );
        case 'space.create': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          return spaceMetadata(
            (
              await api.spaces.createSpace(
                { name: p.name, description: p.description, type: p.type },
                this.callOptions,
              )
            ).data,
          );
        }
        case 'space.update': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          return spaceMetadata(
            (
              await api.spaces.updateSpace(
                p.spaceId,
                { name: p.name, description: p.description },
                this.callOptions,
              )
            ).data,
          );
        }
        case 'space.delete': {
          const spaceId = identifier(value, 'spaceId');
          await api.spaces.deleteSpace(spaceId, this.callOptions);
          return { spaceId, resourceId: spaceId, deleted: true };
        }
        case 'space.member.list': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const r = await api.spaces.getSpaceAssignments(
            p.spaceId,
            { limit: p.limit, next: p.cursor },
            this.callOptions,
          );
          return pageResult(
            (r.data.data ?? []).map(memberMetadata),
            r.data.links?.next?.href,
            'next',
            p.limit,
          );
        }
        case 'space.member.get':
          return memberMetadata(
            (
              await api.spaces.getSpaceAssignment(
                identifier(value, 'spaceId'),
                identifier(value, 'assignmentId'),
                this.callOptions,
              )
            ).data,
          );
        case 'space.member.create': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const target = (await api.spaces.getSpace(p.spaceId, this.callOptions)).data;
          if (!p.roles.every((role) => target.meta?.assignableRoles.includes(role)))
            throw createError('PERMISSION_DENIED', {
              message: 'The requested roles are not assignable in this space.',
            });
          return memberMetadata(
            (
              await api.spaces.createSpaceAssignment(
                p.spaceId,
                { assigneeId: p.assigneeId, roles: p.roles, type: p.type },
                this.callOptions,
              )
            ).data,
          );
        }
        case 'space.member.update': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const target = (await api.spaces.getSpace(p.spaceId, this.callOptions)).data;
          if (!p.roles.every((role) => target.meta?.assignableRoles.includes(role)))
            throw createError('PERMISSION_DENIED', {
              message: 'The requested roles are not assignable in this space.',
            });
          return memberMetadata(
            (
              await api.spaces.updateSpaceAssignment(
                p.spaceId,
                p.assignmentId,
                { roles: p.roles },
                this.callOptions,
              )
            ).data,
          );
        }
        case 'space.member.delete': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          await api.spaces.deleteSpaceAssignment(p.spaceId, p.assignmentId, this.callOptions);
          return {
            spaceId: p.spaceId,
            assignmentId: p.assignmentId,
            resourceId: p.assignmentId,
            deleted: true,
          };
        }
        case 'space.share.list': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const r = await api.spaces.getSpaceShares(
            p.spaceId,
            { limit: p.limit, next: p.cursor, resourceId: p.appId, resourceType: 'app' },
            this.callOptions,
          );
          return pageResult(
            (r.data.data ?? []).map(shareMetadata),
            r.data.links?.next?.href,
            'next',
            p.limit,
          );
        }
        case 'space.share.get':
          return shareMetadata(
            (
              await api.spaces.getSpaceShare(
                identifier(value, 'spaceId'),
                identifier(value, 'shareId'),
                this.callOptions,
              )
            ).data,
          );
        case 'space.share.create': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const target = await this.readApp(api, p.appId);
          if (target.spaceId !== p.spaceId)
            throw createError('PERMISSION_DENIED', {
              message: 'The app is not in the specified sharing space.',
            });
          return shareMetadata(
            (
              await api.spaces.createSpaceShare(
                p.spaceId,
                {
                  assigneeId: p.assigneeId,
                  resourceId: p.appId,
                  resourceType: 'app',
                  roles: p.roles,
                  type: p.type,
                },
                this.callOptions,
              )
            ).data,
          );
        }
        case 'space.share.update': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const patch: Parameters<CloudRestApi['spaces']['patchShare']>[2] = [];
          if (p.roles)
            patch.push({ op: 'replace', path: '/roles', value: JSON.stringify(p.roles) });
          if (p.disabled !== undefined)
            patch.push({ op: 'replace', path: '/disabled', value: JSON.stringify(p.disabled) });
          await api.spaces.patchShare(p.spaceId, p.shareId, patch, this.callOptions);
          return { spaceId: p.spaceId, shareId: p.shareId, resourceId: p.shareId, updated: true };
        }
        case 'space.share.delete': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          await api.spaces.deleteSpaceShare(p.spaceId, p.shareId, this.callOptions);
          return { spaceId: p.spaceId, shareId: p.shareId, resourceId: p.shareId, deleted: true };
        }
        case 'datafile.list': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const r = await api.dataFiles.getDataFiles(
            {
              connectionId: await this.fileConnection(api, p.spaceId),
              limit: p.limit,
              page: p.cursor,
              name: p.name,
              folderId: p.folderId,
              appId: p.appId,
              includeFolders: false,
              sort: '+name',
            },
            this.callOptions,
          );
          return pageResult(
            r.data.data.map(fileMetadata),
            r.data.links.next?.href,
            'page',
            p.limit,
          );
        }
        case 'datafile.get':
          return fileMetadata(
            (await api.dataFiles.getDataFile(identifier(value, 'fileId'), this.callOptions)).data,
          );
        case 'datafile.upload': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const content = this.content(p);
          await this.uploadQuota(api, p.name, content);
          const connectionId = await this.fileConnection(api, p.spaceId);
          return fileMetadata(
            (
              await api.dataFiles.uploadDataFile(
                {
                  File: content,
                  Json: {
                    name: p.name,
                    connectionId,
                    appId: p.appId,
                    folderId: p.folderId,
                    tempContentFileId: p.tempContentFileId,
                    folder: false,
                  },
                },
                this.callOptions,
              )
            ).data,
          );
        }
        case 'datafile.replace': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const source = (await api.dataFiles.getDataFile(p.fileId, this.callOptions)).data;
          if (source.folder)
            throw createError('MALFORMED_REQUEST', {
              message: 'Dataset replacement cannot replace a folder.',
            });
          if (fileMetadata(source).sourceVersion !== p.expectedSourceVersion)
            throw createError('IDEMPOTENCY_CONFLICT', {
              message: 'The dataset changed before replacement.',
            });
          const content = this.content(p);
          await this.uploadQuota(api, p.name ?? source.name, content);
          // Omitting connectionId would silently move a shared file into personal space.
          const connectionId = await this.fileConnection(api, source.spaceId ?? null);
          return fileMetadata(
            (
              await api.dataFiles.reuploadDataFile(
                p.fileId,
                {
                  File: content,
                  Json: {
                    name: p.name ?? source.name,
                    connectionId,
                    folderId: source.folderId,
                    appId: source.appId,
                    tempContentFileId: p.tempContentFileId,
                  },
                },
                this.callOptions,
              )
            ).data,
          );
        }
        case 'datafile.delete': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const fileId = p.fileId;
          const source = (await api.dataFiles.getDataFile(fileId, this.callOptions)).data;
          if (source.folder)
            throw createError('MALFORMED_REQUEST', {
              message: 'Dataset deletion cannot recursively delete a folder.',
            });
          if (fileMetadata(source).sourceVersion !== p.expectedSourceVersion)
            throw createError('IDEMPOTENCY_CONFLICT', {
              message: 'The dataset changed before deletion.',
            });
          await api.dataFiles.deleteDataFile(fileId, this.callOptions);
          return { fileId, resourceId: fileId, deleted: true };
        }
        case 'datafile.quotas':
          return select((await api.dataFiles.getDataFilesQuotas(this.callOptions)).data, [
            'allowedExtensions',
            'maxFileSize',
            'maxLargeFileSize',
            'maxSize',
            'size',
          ]);
        case 'reload.list': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const r = await api.reloads.getReloads(
            { appId: p.appId, limit: p.limit, next: p.cursor, log: false, sort: '-creationTime' },
            this.callOptions,
          );
          return pageResult(
            r.data.data.map(reloadMetadata),
            r.data.links.next?.href,
            'next',
            p.limit,
          );
        }
        case 'reload.create': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          return reloadMetadata(
            (
              await api.reloads.queueReload(
                { appId: p.appId, partial: p.partial },
                this.callOptions,
              )
            ).data,
          );
        }
        case 'reload.get':
          return reloadMetadata(
            (await api.reloads.getReload(identifier(value, 'reloadId'), this.callOptions)).data,
          );
        case 'reload.cancel': {
          const reloadId = identifier(value, 'reloadId');
          await api.reloads.cancelReload(reloadId, this.callOptions);
          return { reloadId, resourceId: reloadId, cancellationRequested: true };
        }
        case 'reload.log': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          await this.inspectInternal(api, action, p);
          const r = await api.apps.getAppReloadLog(p.appId, p.reloadId, this.callOptions);
          return await this.artifact(this.reloadLogContent(r.data, r.headers), {
            connection: p.connection,
            appId: p.appId,
            kind: 'reload-log',
            filename: `${p.appId}-${p.reloadId}.log`,
          });
        }
        case 'schedule.list': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const r = await api.scheduling.tasks.getTasks(
            { resourceId: p.appId, limit: p.limit, page: p.cursor, sort: '+name' },
            this.callOptions,
          );
          return pageResult(
            (r.data.data ?? []).map(taskMetadata),
            r.data.links?.next?.href,
            'page',
            p.limit,
          );
        }
        case 'schedule.get':
          return taskMetadata(
            (await api.scheduling.tasks.getTask(identifier(value, 'taskId'), this.callOptions))
              .data,
          );
        case 'schedule.create': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const target = await this.readApp(api, p.appId);
          const task: Task = {
            name: p.name,
            specVersion: '0.8',
            version: '1.0.0',
            enabled: p.enabled,
            metadata: {
              usage: 'ANALYTICS',
              ...(typeof target.spaceId === 'string' ? { spaceId: target.spaceId } : {}),
            },
            start: { stateName: 'reload', schedule: p.schedule },
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
                        functionRef: {
                          refName: 'app.reload',
                          arguments: { appId: p.appId, partial: p.partial },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          };
          return taskMetadata(
            (await api.scheduling.tasks.createTaskWithoutQuery(task, this.callOptions)).data,
          );
        }
        case 'schedule.update': {
          const p = REST_ACTION_SCHEMAS[action].parse(value);
          const source = (await api.scheduling.tasks.getTask(p.taskId, this.callOptions)).data;
          if (taskMetadata(source).sourceVersion !== p.expectedSourceVersion)
            throw createError('IDEMPOTENCY_CONFLICT', {
              message: 'The schedule changed before update.',
            });
          // PUT resets omitted fields. Patch only approved fields and retain provider-owned metadata and actions.
          const patch: Parameters<CloudRestApi['scheduling']['tasks']['patchTask']>[1] = [];
          if (p.name !== undefined) patch.push({ op: 'add', path: '/name', value: p.name });
          if (p.enabled !== undefined)
            patch.push({ op: 'add', path: '/enabled', value: p.enabled });
          if (p.schedule !== undefined)
            patch.push(
              source.start
                ? { op: 'add', path: '/start/schedule', value: p.schedule }
                : { op: 'add', path: '/start', value: { schedule: p.schedule } },
            );
          try {
            await api.scheduling.tasks.patchTask(p.taskId, patch, this.callOptions);
          } catch (error) {
            const status = record(error).status;
            // This marker applies only to the mutation's direct validation response, never a later readback.
            if (status === 400 || status === 422)
              throw createError('MALFORMED_REQUEST', {
                message: 'Qlik rejected the schedule update parameters before applying the patch.',
                details: { outcome: 'rejected', providerStatus: status },
              });
            throw error;
          }
          // PATCH can return 204. Its stable ID is the receipt; verification independently reads the task.
          return {
            taskId: p.taskId,
            resourceId: p.taskId,
            appId: taskAppId(source),
            updated: true,
            ...(p.name !== undefined ? { name: p.name } : {}),
            ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
            ...(p.schedule !== undefined ? { schedule: p.schedule } : {}),
          };
        }
        case 'schedule.delete': {
          const taskId = identifier(value, 'taskId');
          await api.scheduling.tasks.deleteTask(taskId, this.callOptions);
          return { taskId, resourceId: taskId, deleted: true };
        }
      }
    } catch (error) {
      this.failure(error, dispatchedWrite);
    }
  }
}
