import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AcceptanceClient } from '../../live/managementAcceptance.js';
import {
  REST_LIFECYCLE_ACTIONS,
  restLifecycleConfiguration,
  runManagementRestLifecycle,
} from '../../live/managementRestLifecycle.js';

type Json = Record<string, unknown>;
type Step = { action: string; input: Json };
const environment = {
  QLIK_MANAGEMENT_REST_ACCEPTANCE: 'CREATE_AND_DELETE_REST_FIXTURES',
  QLIK_MANAGEMENT_ACCEPTANCE_ENDPOINT: 'https://mcp.example/mcp',
  QLIK_MANAGEMENT_ACCEPTANCE_BEARER: 'private-operator-bearer',
  QLIK_MANAGEMENT_ACCEPTANCE_CONNECTION: 'cloud',
  QLIK_MANAGEMENT_ACCEPTANCE_SPACE_ID: 'sandbox',
};

function fakeServer(
  options: {
    approval?: boolean;
    uncertainCreate?: boolean;
    recoverableCreate?: boolean;
    foreignFile?: boolean;
    unchangedFileVersion?: boolean;
    enabledSchedule?: boolean;
  } = {},
) {
  const plans = new Map<string, Step>();
  const writes: Step[] = [];
  const reads: Step[] = [];
  const approvals: Json[] = [];
  const apps = new Map<string, Json>();
  const uploads = new Map<string, Json>();
  let file: Json | undefined;
  let task: Json | undefined;
  let sequence = 0;
  const nextVersion = () => createHash('sha256').update(String(sequence++)).digest('hex');
  let initialVersion = '';
  const client: AcceptanceClient = {
    close: vi.fn(async () => undefined),
    call: vi.fn(async (name, input) => {
      if (name === 'qlik_management_catalog')
        return { actions: REST_LIFECYCLE_ACTIONS.map((action) => ({ action })) };
      if (name === 'qlik_management_plan') {
        const planId = `plan-${plans.size}`;
        plans.set(planId, structuredClone((input.steps as Step[])[0]!));
        return { planId, status: options.approval ? 'awaiting-approval' : 'approved' };
      }
      if (name === 'qlik_management_approve') {
        approvals.push(structuredClone(input));
        expect(input.steps).toEqual([plans.get(String(input.planId))]);
        return { status: 'approved' };
      }
      if (name === 'qlik_management_execute') {
        const step = plans.get(String(input.planId))!;
        expect(input.steps).toEqual([step]);
        writes.push(step);
        const value = step.input;
        let result: Json;
        switch (step.action) {
          case 'app.create': {
            const app = {
              appId: 'fixture-app',
              name: value.name,
              spaceId: value.spaceId,
              sourceVersion: nextVersion(),
            };
            apps.set('fixture-app', app);
            result = { ...app, verified: true };
            if (options.uncertainCreate)
              return {
                status: 'needs-reconciliation',
                acknowledged: { ...result, providerBody: 'private-unsafe-provider-body' },
              };
            break;
          }
          case 'app.update': {
            const app = apps.get(String(value.appId))!;
            expect(value.expectedSourceVersion).toBe(app.sourceVersion);
            app.name = value.name;
            app.sourceVersion = nextVersion();
            result = { ...app, verified: true };
            break;
          }
          case 'app.duplicate': {
            expect(value.expectedSourceVersion).toBe(apps.get(String(value.appId))!.sourceVersion);
            const app = {
              appId: 'fixture-copy',
              name: value.name,
              spaceId: value.spaceId,
              sourceVersion: nextVersion(),
            };
            apps.set('fixture-copy', app);
            result = { ...app, verified: true };
            break;
          }
          case 'app.delete':
            expect(value.expectedSourceVersion).toBe(apps.get(String(value.appId))!.sourceVersion);
            apps.delete(String(value.appId));
            result = { appId: value.appId, deleted: true };
            break;
          case 'datafile.upload': {
            const upload = uploads.get(String(value.artifactId))!;
            initialVersion = nextVersion();
            file = {
              fileId: 'fixture-file',
              name: upload.filename,
              size: upload.byteLength,
              spaceId: value.spaceId,
              sourceVersion: initialVersion,
            };
            result = { ...file, verified: true };
            break;
          }
          case 'datafile.replace': {
            expect(value.fileId).toBe('fixture-file');
            expect(value.expectedSourceVersion).toBe(file!.sourceVersion);
            const upload = uploads.get(String(value.artifactId))!;
            file = {
              ...file!,
              size: upload.byteLength,
              sourceVersion: options.unchangedFileVersion ? initialVersion : nextVersion(),
            };
            result = { ...file, verified: true };
            break;
          }
          case 'datafile.delete':
            expect(value.expectedSourceVersion).toBe(file!.sourceVersion);
            file = undefined;
            result = { fileId: value.fileId, deleted: true };
            break;
          case 'schedule.create':
            expect(value.enabled).toBe(false);
            task = {
              taskId: 'fixture-task',
              appId: value.appId,
              name: value.name,
              enabled: false,
              schedule: value.schedule,
              sourceVersion: nextVersion(),
            };
            result = { ...task, verified: true };
            break;
          case 'schedule.update':
            expect(value.enabled).toBe(false);
            expect(value.expectedSourceVersion).toBe(task!.sourceVersion);
            task = {
              ...task!,
              name: value.name,
              enabled: value.enabled,
              schedule: value.schedule,
              sourceVersion: nextVersion(),
            };
            result = { ...task, verified: true };
            break;
          case 'schedule.delete':
            expect(value.expectedSourceVersion).toBe(task!.sourceVersion);
            task = undefined;
            result = { taskId: value.taskId, deleted: true };
            break;
          default:
            throw new Error('Unexpected fixture mutation.');
        }
        return { status: 'completed', steps: [structuredClone(result)] };
      }
      if (name === 'qlik_management_status')
        return { steps: [{ status: 'uncertain', result: { appId: 'fixture-app' } }] };
      if (name === 'qlik_management_reconcile')
        return options.recoverableCreate
          ? { status: 'completed', result: { appId: 'fixture-app', verified: true } }
          : { status: 'needs-reconciliation' };
      if (name === 'qlik_management_read') {
        const action = String(input.action);
        const value = input.input as Json;
        reads.push({ action, input: value });
        if (action === 'space.get') return { spaceId: 'sandbox', type: 'shared' };
        if (action === 'app.get') return structuredClone(apps.get(String(value.appId))!);
        if (action === 'datafile.get')
          return { ...file!, ...(options.foreignFile ? { spaceId: 'foreign-space' } : {}) };
        if (action === 'schedule.get')
          return structuredClone({
            ...task!,
            ...(options.enabledSchedule ? { enabled: true } : {}),
          });
        throw new Error('Unexpected fixture read.');
      }
      if (name === 'qlik_upload_begin') {
        const artifactId = `artifact-00000000-0000-4000-8000-${String(uploads.size).padStart(12, '0')}`;
        uploads.set(artifactId, input);
        return { artifactId, chunkBytes: 192 * 1024 };
      }
      if (name === 'qlik_upload_chunk') {
        const upload = uploads.get(String(input.artifactId))!;
        const bytes = Buffer.from(String(input.contentBase64), 'base64');
        expect(bytes.length).toBe(upload.byteLength);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(upload.sha256);
        return { accepted: true };
      }
      if (name === 'qlik_upload_finish') return { ...uploads.get(String(input.artifactId))! };
      throw new Error('Unexpected fixture tool.');
    }),
  };
  return {
    client,
    writes,
    reads,
    approvals,
    apps,
    uploads,
    hasFile: () => !!file,
    hasTask: () => !!task,
  };
}

async function run(options: Parameters<typeof fakeServer>[0] = {}, extra: NodeJS.ProcessEnv = {}) {
  const fixture = fakeServer(options);
  const reports: Json[] = [];
  const connect = vi.fn(async () => fixture.client);
  const report = await runManagementRestLifecycle(
    restLifecycleConfiguration({ ...environment, ...extra }),
    {
      connect,
      sleep: async () => undefined,
      persist: async (value) => {
        reports.push(structuredClone(value));
      },
    },
  );
  return { ...fixture, reports, report, connect };
}

describe('optional REST lifecycle acceptance with injected clients', () => {
  it('requires its own explicit fixture creation/deletion opt-in and exact HTTPS scope', () => {
    expect(() =>
      restLifecycleConfiguration({ ...environment, QLIK_MANAGEMENT_REST_ACCEPTANCE: undefined }),
    ).toThrow('EXPLICIT_REST_FIXTURE_OPT_IN_REQUIRED');
    expect(() =>
      restLifecycleConfiguration({
        ...environment,
        QLIK_MANAGEMENT_ACCEPTANCE_ENDPOINT: 'http://mcp.example/mcp',
      }),
    ).toThrow('HTTPS');
    expect(() =>
      restLifecycleConfiguration({ ...environment, QLIK_MANAGEMENT_ACCEPTANCE_SPACE_ID: '*' }),
    ).toThrow('EXACT_SANDBOX_TARGET_REQUIRED');
    expect(restLifecycleConfiguration(environment).cleanup).toBe(false);
  });

  it('renames and duplicates only a fresh app, replaces only its own dataset, and tests a disabled schedule', async () => {
    const result = await run(
      {},
      { QLIK_MANAGEMENT_ACCEPTANCE_CLEANUP: 'DELETE_CREATED_RESOURCES' },
    );
    expect(result.report).toMatchObject({
      status: 'passed',
      retained: false,
      evidence: 'offline-injected-client',
    });
    expect(result.writes.map((step) => step.action)).toEqual([
      'app.create',
      'app.update',
      'app.duplicate',
      'app.delete',
      'datafile.upload',
      'datafile.replace',
      'schedule.create',
      'schedule.update',
      'schedule.delete',
      'datafile.delete',
      'app.delete',
    ]);
    expect(result.apps.size).toBe(0);
    expect(result.hasFile()).toBe(false);
    expect(result.hasTask()).toBe(false);
    expect(result.uploads.size).toBe(2);
    expect(result.report.checks).toHaveLength(5);
    const persisted = JSON.stringify(result.reports);
    expect(persisted).not.toContain(environment.QLIK_MANAGEMENT_ACCEPTANCE_BEARER);
    expect(persisted).not.toContain('Category,Amount');
    expect(persisted).not.toContain('contentBase64');
  });

  it('retains the base fixtures by default but always removes the test duplicate and disabled schedule', async () => {
    const result = await run();
    expect(result.report).toMatchObject({
      status: 'passed',
      retained: true,
      resources: { duplicateDeleted: true, scheduleDeleted: true },
    });
    expect([...result.apps.keys()]).toEqual(['fixture-app']);
    expect(result.hasFile()).toBe(true);
    expect(result.hasTask()).toBe(false);
    expect(result.writes.some((step) => step.action === 'datafile.delete')).toBe(false);
  });

  it('requires separate approval before dispatch and binds approved inputs to the original plan', async () => {
    const denied = await run({ approval: true });
    expect(denied.report.errorCode).toBe('SEPARATE_REVIEWER_APPROVAL_REQUIRED');
    expect(denied.writes).toEqual([]);
    const approved = await run(
      { approval: true },
      {
        QLIK_MANAGEMENT_ACCEPTANCE_ACTOR: 'fixture-owner',
        QLIK_MANAGEMENT_ACCEPTANCE_REVIEWER_BEARER: 'private-reviewer-bearer',
        QLIK_MANAGEMENT_ACCEPTANCE_REVIEW: 'APPROVE_THIS_FIXTURE_RUN',
      },
    );
    expect(approved.report.status).toBe('passed');
    expect(approved.approvals).toHaveLength(approved.writes.length);
    expect(approved.connect).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(approved.reports)).not.toContain('private-reviewer-bearer');
  });

  it('bounds readback reconciliation without replaying an uncertain create or leaking its provider body', async () => {
    const result = await run({ uncertainCreate: true });
    expect(result.report).toMatchObject({
      status: 'failed-or-pending',
      errorCode: 'WORKFLOW_REQUIRES_RECONCILIATION',
      retained: true,
    });
    expect(result.writes.map((step) => step.action)).toEqual(['app.create']);
    const calls = vi.mocked(result.client.call).mock.calls;
    expect(calls.filter(([name]) => name === 'qlik_management_reconcile')).toHaveLength(3);
    expect(JSON.stringify(result.reports)).not.toContain('private-unsafe-provider-body');
  });

  it('refuses replacement when fixture file readback moves outside the exact approved space', async () => {
    const result = await run({ foreignFile: true });
    expect(result.report.errorCode).toBe('DATAFILE_FIXTURE_READBACK_MISMATCH');
    expect(result.writes.some((step) => step.action === 'datafile.replace')).toBe(false);
    expect(result.writes.some((step) => step.action === 'schedule.create')).toBe(false);
  });

  it('continues from a reconciled creation receipt while dispatching app.create exactly once', async () => {
    const result = await run({ uncertainCreate: true, recoverableCreate: true });
    expect(result.report.status).toBe('passed');
    expect(result.writes.filter((step) => step.action === 'app.create')).toHaveLength(1);
    expect(
      vi
        .mocked(result.client.call)
        .mock.calls.filter(([name]) => name === 'qlik_management_reconcile'),
    ).toHaveLength(1);
  });

  it('does not certify replacement from byte count alone if the source version did not change', async () => {
    const result = await run({ unchangedFileVersion: true });
    expect(result.report.errorCode).toBe('REPLACEMENT_VERSION_UNCHANGED');
    expect(result.writes.some((step) => step.action === 'schedule.create')).toBe(false);
  });

  it('fails if an explicitly disabled schedule reads back enabled and records its ID for recovery', async () => {
    const result = await run({ enabledSchedule: true });
    expect(result.report).toMatchObject({
      errorCode: 'DISABLED_SCHEDULE_READBACK_MISMATCH',
      retained: true,
      resources: { taskId: 'fixture-task' },
    });
    expect(result.writes.some((step) => step.action === 'schedule.update')).toBe(false);
    expect(result.writes.some((step) => step.action === 'schedule.delete')).toBe(false);
  });
});
