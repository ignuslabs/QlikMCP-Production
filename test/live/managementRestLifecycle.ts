/** Optional live REST acceptance. Creates only uniquely named fixtures in one approved shared space. */
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  acceptanceConfiguration,
  deployedClient,
  type AcceptanceClient,
  type AcceptanceConfiguration,
} from './managementAcceptance.js';

type Json = Record<string, unknown>;
type Step = { action: string; input: Json };
const OPT_IN = 'CREATE_AND_DELETE_REST_FIXTURES';
const VERSION = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.-]{1,256}$/;
const SAFE_RECEIPT_KEYS = new Set([
  'appId',
  'fileId',
  'taskId',
  'artifactId',
  'sourceVersion',
  'sha256',
  'byteLength',
  'status',
  'verified',
  'deleted',
]);
export const REST_LIFECYCLE_ACTIONS = [
  'space.get',
  'app.create',
  'app.get',
  'app.update',
  'app.duplicate',
  'app.delete',
  'datafile.upload',
  'datafile.get',
  'datafile.replace',
  'datafile.delete',
  'schedule.create',
  'schedule.get',
  'schedule.update',
  'schedule.delete',
] as const;

export interface RestLifecycleConfiguration extends AcceptanceConfiguration {
  readonly lifecycle: typeof OPT_IN;
}

function fail(code: string): never {
  throw new Error(code);
}
function record(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_TOOL_RESPONSE');
  return value as Json;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_RESOURCE_IDENTIFIER');
  return value;
}
function version(value: unknown): string {
  if (typeof value !== 'string' || !VERSION.test(value)) fail('INVALID_RESOURCE_VERSION');
  return value;
}
function receipt(value: Json): Json {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) =>
        SAFE_RECEIPT_KEYS.has(key) &&
        ((typeof item === 'string' && item.length <= 512) ||
          typeof item === 'boolean' ||
          typeof item === 'number'),
    ),
  );
}

export function restLifecycleConfiguration(
  environment: NodeJS.ProcessEnv,
): RestLifecycleConfiguration {
  if (environment.QLIK_MANAGEMENT_REST_ACCEPTANCE !== OPT_IN)
    fail('EXPLICIT_REST_FIXTURE_OPT_IN_REQUIRED');
  const base = acceptanceConfiguration({
    ...environment,
    QLIK_MANAGEMENT_ACCEPTANCE: 'CREATE_SANDBOX_RESOURCES',
  });
  return {
    ...base,
    lifecycle: OPT_IN,
    reportPath: environment.QLIK_MANAGEMENT_ACCEPTANCE_REPORT
      ? base.reportPath
      : path.resolve('.qlik-ai-harness', 'management-rest-lifecycle', `${base.runId}.json`),
  };
}

export async function runManagementRestLifecycle(
  configuration: RestLifecycleConfiguration,
  dependencies: {
    connect?: typeof deployedClient;
    sleep?: (milliseconds: number) => Promise<unknown>;
    persist?: (report: Json) => Promise<void>;
  } = {},
): Promise<Json> {
  if (configuration.lifecycle !== OPT_IN) fail('EXPLICIT_REST_FIXTURE_OPT_IN_REQUIRED');
  const connect = dependencies.connect ?? deployedClient;
  const sleep = dependencies.sleep ?? delay;
  const report: Json = {
    runId: configuration.runId,
    evidence: dependencies.connect ? 'offline-injected-client' : 'deployed-mcp-and-live-qlik',
    startedAt: new Date().toISOString(),
    status: 'in-progress',
    connection: configuration.connection,
    sandboxSpaceId: configuration.spaceId,
    cleanupRequested: configuration.cleanup,
    retained: true,
    resources: {},
    steps: [],
    checks: [],
  };
  const resources = report.resources as Json;
  const steps = report.steps as Json[];
  const checks = report.checks as string[];
  const persist =
    dependencies.persist ??
    (async (value: Json) => {
      await mkdir(path.dirname(configuration.reportPath), { recursive: true, mode: 0o700 });
      const temporary = `${configuration.reportPath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, configuration.reportPath);
    });
  let client: AcceptanceClient | undefined;
  let reviewer: AcceptanceClient | undefined;
  await persist(report);
  try {
    client = await connect(configuration.endpoint, configuration.bearer);
    const read = (action: string, input: Json) =>
      client!.call('qlik_management_read', {
        action,
        input: { connection: configuration.connection, ...input },
      });
    const execute = async (action: string, input: Json): Promise<Json> => {
      const original: Step[] = [
        { action, input: { connection: configuration.connection, ...input } },
      ];
      const plan = await client!.call('qlik_management_plan', { steps: original });
      const planId = identifier(plan.planId);
      const entry: Json = { action, planId, status: plan.status };
      steps.push(entry);
      await persist(report);
      if (plan.status === 'awaiting-approval') {
        if (!configuration.allowReview || !configuration.reviewerBearer || !configuration.actor)
          fail('SEPARATE_REVIEWER_APPROVAL_REQUIRED');
        reviewer ??= await connect(configuration.endpoint, configuration.reviewerBearer);
        await reviewer.call('qlik_management_approve', {
          owner: configuration.actor,
          planId,
          steps: original,
        });
      }
      // One dispatch only. Reconciliation reads the same attempt; it never repeats a write.
      const result = await client!.call('qlik_management_execute', { planId, steps: original });
      let acknowledged = result.acknowledged
        ? record(result.acknowledged)
        : Array.isArray(result.steps) && result.steps.length
          ? record(result.steps[0])
          : {};
      entry.status = result.status;
      entry.result = receipt(acknowledged);
      await persist(report);
      if (result.status === 'completed') return acknowledged;
      const status = await client!.call('qlik_management_status', { planId });
      const persisted =
        Array.isArray(status.steps) && status.steps[0] ? record(status.steps[0]).result : undefined;
      if (persisted) acknowledged = record(persisted);
      entry.result = receipt(acknowledged);
      await persist(report);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep(2_000);
        const reconciled = await client!.call('qlik_management_reconcile', {
          planId,
          steps: original,
          index: 0,
        });
        entry.status = reconciled.status;
        if (reconciled.status === 'completed') {
          acknowledged = record(reconciled.result);
          entry.result = receipt(acknowledged);
          await persist(report);
          return acknowledged;
        }
        await persist(report);
      }
      fail('WORKFLOW_REQUIRES_RECONCILIATION');
    };
    const catalog = await client.call('qlik_management_catalog', {});
    const available = new Set(
      (Array.isArray(catalog.actions) ? catalog.actions : []).map((value) => record(value).action),
    );
    if (REST_LIFECYCLE_ACTIONS.some((action) => !available.has(action)))
      fail('REQUIRED_ACTION_UNAVAILABLE');
    const space = await read('space.get', { spaceId: configuration.spaceId });
    if (space.spaceId !== configuration.spaceId || space.type !== 'shared')
      fail('EXACT_SHARED_SANDBOX_REQUIRED');

    const originalName = `REST acceptance ${configuration.runId}`;
    const renamedName = `${originalName} renamed`;
    const copyName = `${originalName} duplicate`;
    const filename = `rest-acceptance-${configuration.runId}.csv`;
    const created = await execute('app.create', {
      name: originalName,
      spaceId: configuration.spaceId,
    });
    const appId = identifier(created.appId);
    resources.appId = appId;
    const appReadback = async (id: string, name: string) => {
      const app = await read('app.get', { appId: id });
      if (app.appId !== id || app.name !== name || app.spaceId !== configuration.spaceId)
        fail('APP_FIXTURE_READBACK_MISMATCH');
      version(app.sourceVersion);
      return app;
    };
    let app = await appReadback(appId, originalName);
    await execute('app.update', {
      appId,
      name: renamedName,
      expectedSourceVersion: version(app.sourceVersion),
    });
    app = await appReadback(appId, renamedName);
    checks.push('fresh-app-created-and-version-bound-rename-readback');
    const duplicated = await execute('app.duplicate', {
      appId,
      name: copyName,
      spaceId: configuration.spaceId,
      expectedSourceVersion: version(app.sourceVersion),
    });
    const duplicateAppId = identifier(duplicated.appId);
    if (duplicateAppId === appId) fail('DUPLICATE_DESTINATION_NOT_DISTINCT');
    resources.duplicateAppId = duplicateAppId;
    const duplicate = await appReadback(duplicateAppId, copyName);
    const deletedDuplicate = await execute('app.delete', {
      appId: duplicateAppId,
      expectedSourceVersion: version(duplicate.sourceVersion),
    });
    if (deletedDuplicate.deleted !== true) fail('DUPLICATE_DELETION_UNVERIFIED');
    resources.duplicateDeleted = true;
    checks.push('duplicate-distinct-app-readback-and-verified-delete');

    const stage = async (bytes: Buffer): Promise<string> => {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const upload = await client!.call('qlik_upload_begin', {
        connection: configuration.connection,
        spaceId: configuration.spaceId,
        filename,
        mimeType: 'text/csv',
        byteLength: bytes.length,
        sha256,
      });
      const artifactId = identifier(upload.artifactId);
      if (upload.chunkBytes !== 192 * 1024) fail('UPLOAD_CHUNK_BOUND_INVALID');
      await client!.call('qlik_upload_chunk', {
        connection: configuration.connection,
        artifactId,
        index: 0,
        contentBase64: bytes.toString('base64'),
      });
      const sealed = await client!.call('qlik_upload_finish', {
        connection: configuration.connection,
        artifactId,
      });
      if (sealed.sha256 !== sha256 || sealed.byteLength !== bytes.length)
        fail('UPLOAD_CHECKSUM_MISMATCH');
      return artifactId;
    };
    const initial = Buffer.from('Category,Amount\nFixture,1\n');
    const replacement = Buffer.from('Category,Amount\nFixture,1000\nAdditional,2000\n');
    const uploaded = await execute('datafile.upload', {
      artifactId: await stage(initial),
      spaceId: configuration.spaceId,
    });
    const fileId = identifier(uploaded.fileId);
    resources.fileId = fileId;
    const fileReadback = async (byteLength: number) => {
      const file = await read('datafile.get', { fileId });
      if (
        file.fileId !== fileId ||
        file.name !== filename ||
        file.spaceId !== configuration.spaceId ||
        file.size !== byteLength
      )
        fail('DATAFILE_FIXTURE_READBACK_MISMATCH');
      version(file.sourceVersion);
      return file;
    };
    const originalFile = await fileReadback(initial.length);
    await execute('datafile.replace', {
      artifactId: await stage(replacement),
      fileId,
      expectedSourceVersion: version(originalFile.sourceVersion),
    });
    const replacedFile = await fileReadback(replacement.length);
    if (replacedFile.sourceVersion === originalFile.sourceVersion)
      fail('REPLACEMENT_VERSION_UNCHANGED');
    checks.push('fresh-fixture-dataset-version-bound-replacement-and-size-readback');

    const scheduleName = `Disabled REST fixture ${configuration.runId}`;
    const scheduleChangedName = `${scheduleName} revised`;
    const firstSchedule = {
      recurrence: 'RRULE:FREQ=DAILY;BYHOUR=3;BYMINUTE=0;BYSECOND=0',
      timezone: 'Etc/UTC',
    };
    const changedSchedule = {
      ...firstSchedule,
      recurrence: 'RRULE:FREQ=DAILY;BYHOUR=4;BYMINUTE=0;BYSECOND=0',
    };
    const scheduled = await execute('schedule.create', {
      appId,
      name: scheduleName,
      enabled: false,
      partial: false,
      schedule: firstSchedule,
    });
    const taskId = identifier(scheduled.taskId);
    resources.taskId = taskId;
    const scheduleReadback = async (name: string, intended: typeof firstSchedule) => {
      const task = await read('schedule.get', { taskId });
      const schedule = record(task.schedule);
      if (
        task.taskId !== taskId ||
        task.appId !== appId ||
        task.name !== name ||
        task.enabled !== false ||
        schedule.recurrence !== intended.recurrence ||
        schedule.timezone !== intended.timezone
      )
        fail('DISABLED_SCHEDULE_READBACK_MISMATCH');
      version(task.sourceVersion);
      return task;
    };
    let task = await scheduleReadback(scheduleName, firstSchedule);
    await execute('schedule.update', {
      taskId,
      name: scheduleChangedName,
      enabled: false,
      schedule: changedSchedule,
      expectedSourceVersion: version(task.sourceVersion),
    });
    task = await scheduleReadback(scheduleChangedName, changedSchedule);
    const deletedTask = await execute('schedule.delete', {
      taskId,
      expectedSourceVersion: version(task.sourceVersion),
    });
    if (deletedTask.deleted !== true) fail('SCHEDULE_DELETION_UNVERIFIED');
    resources.scheduleDeleted = true;
    checks.push('disabled-modern-schedule-create-update-readback-and-verified-delete');

    if (configuration.cleanup) {
      const file = await fileReadback(replacement.length);
      const deletedFile = await execute('datafile.delete', {
        fileId,
        expectedSourceVersion: version(file.sourceVersion),
      });
      if (deletedFile.deleted !== true) fail('DATAFILE_DELETION_UNVERIFIED');
      resources.fileDeleted = true;
      app = await appReadback(appId, renamedName);
      const deletedApp = await execute('app.delete', {
        appId,
        expectedSourceVersion: version(app.sourceVersion),
      });
      if (deletedApp.deleted !== true) fail('APP_DELETION_UNVERIFIED');
      resources.appDeleted = true;
      checks.push('exact-base-fixtures-deleted-and-verified');
    }
    report.status = 'passed';
    report.retained = !configuration.cleanup;
  } catch (error) {
    report.status = 'failed-or-pending';
    report.errorCode =
      error instanceof Error && /^[A-Z_]{1,100}$/.test(error.message)
        ? error.message
        : 'REST_LIFECYCLE_OPERATION_FAILED';
  } finally {
    report.finishedAt = new Date().toISOString();
    await persist(report);
    await Promise.allSettled([client?.close(), reviewer?.close()]);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runManagementRestLifecycle(restLifecycleConfiguration(process.env));
    process.stdout.write(`${JSON.stringify({ status: report.status, runId: report.runId })}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^[A-Z_]{1,100}$/.test(error.message) ? error.message : 'REST_LIFECYCLE_CONFIGURATION_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
