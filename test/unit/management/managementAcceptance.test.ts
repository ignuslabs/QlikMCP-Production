import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptanceConfiguration,
  runManagementAcceptance,
  type AcceptanceClient,
} from '../../live/managementAcceptance.js';

const environment = {
  QLIK_MANAGEMENT_ACCEPTANCE: 'CREATE_SANDBOX_RESOURCES',
  QLIK_MANAGEMENT_ACCEPTANCE_ENDPOINT: 'https://mcp.example/mcp',
  QLIK_MANAGEMENT_ACCEPTANCE_BEARER: 'private-bearer',
  QLIK_MANAGEMENT_ACCEPTANCE_CONNECTION: 'cloud',
  QLIK_MANAGEMENT_ACCEPTANCE_SPACE_ID: 'sandbox',
};
const requiredActions = [
  'space.get',
  'app.create',
  'app.get',
  'datafile.upload',
  'datafile.get',
  'script.get',
  'script.apply',
  'reload.create',
  'reload.get',
  'model.inspect',
  'table.preview',
  'sheet.create',
  'sheet.get',
  'sheet.publish',
  'chart.create',
  'chart.get',
  'chart.export',
  'app.export',
];
const version = 'a'.repeat(64);

function fakeServer(
  settings: {
    wrongTotals?: boolean;
    uncertainCreate?: boolean;
    recoverable?: boolean;
    wrongPreviewHeaders?: boolean;
    reversedSort?: boolean;
    duplicateExportRow?: boolean;
    rejectedCreate?: boolean;
    rejectedReconciliation?: boolean;
  } = {},
) {
  const plans = new Map<string, { action: string; input: Record<string, unknown> }>();
  const writes: string[] = [];
  let appName = '';
  let filename = '';
  let fileSize = 0;
  let reloadReads = 0;
  let sheetPublished = false;
  const backup = Buffer.from('binary-app-backup'.repeat(600));
  const client: AcceptanceClient = {
    close: vi.fn(async () => undefined),
    call: vi.fn(async (name, input) => {
      if (name === 'qlik_management_catalog')
        return { actions: requiredActions.map((action) => ({ action })) };
      if (name === 'qlik_management_plan') {
        const step = (input.steps as { action: string; input: Record<string, unknown> }[])[0]!;
        const planId = `plan-${plans.size}`;
        plans.set(planId, step);
        return { planId, status: 'approved' };
      }
      if (name === 'qlik_management_execute') {
        const step = plans.get(String(input.planId))!;
        writes.push(step.action);
        let result: Record<string, unknown>;
        if (step.action === 'app.create') {
          if (settings.rejectedCreate) return { status: 'failed', errorCode: 'MALFORMED_REQUEST' };
          appName = String(step.input.name);
          result = { appId: 'created-app', sourceVersion: version };
          if (settings.uncertainCreate)
            return { status: 'needs-reconciliation', acknowledged: result };
        } else if (step.action === 'sheet.publish') {
          sheetPublished = true;
          result = { sheetId: step.input.sheetId, published: true, verified: true };
        } else if (step.action === 'datafile.upload')
          result = { fileId: 'created-file', sourceVersion: version };
        else if (step.action === 'reload.create')
          result = { reloadId: 'created-reload', status: 'QUEUED' };
        else if (step.action === 'app.export')
          result = {
            artifactId: 'backup',
            byteLength: backup.length,
            sha256: createHash('sha256').update(backup).digest('hex'),
          };
        else result = { verified: true };
        return { status: 'completed', steps: [result] };
      }
      if (name === 'qlik_management_status')
        return {
          steps: [
            { status: 'uncertain', result: { appId: 'created-app', sourceVersion: version } },
          ],
        };
      if (name === 'qlik_management_reconcile')
        return settings.rejectedReconciliation
          ? { status: 'failed', errorCode: 'MALFORMED_REQUEST' }
          : settings.recoverable
            ? { status: 'completed', result: { appId: 'created-app', sourceVersion: version } }
            : { status: 'needs-reconciliation' };
      if (name === 'qlik_management_read') {
        if (input.action === 'space.get') return { type: 'shared' };
        if (input.action === 'app.get')
          return {
            appId: 'created-app',
            name: appName,
            spaceId: 'sandbox',
            sourceVersion: version,
          };
        if (input.action === 'datafile.get')
          return {
            fileId: 'created-file',
            name: filename,
            size: fileSize,
            spaceId: 'sandbox',
            sourceVersion: version,
          };
        if (input.action === 'script.get' || input.action === 'sheet.get')
          return { expectedHash: `sha256:${version}`, published: sheetPublished };
        if (input.action === 'reload.get') {
          reloadReads++;
          return { status: reloadReads === 1 ? 'QUEUED' : 'SUCCEEDED', terminal: reloadReads > 1 };
        }
        if (input.action === 'model.inspect')
          return { tables: [{ name: 'AcceptanceData', rowCount: 3 }] };
        if (input.action === 'table.preview')
          return {
            columns: settings.wrongPreviewHeaders ? ['Category', 'Amount'] : ['Amount', 'Category'],
            rows: [
              [{ qNumber: 50 }, { qText: 'North' }],
              [{ qNumber: 100 }, { qText: 'South' }],
              [{ qNumber: 25 }, { qText: 'South' }],
            ],
          };
        if (input.action === 'chart.get') return { objectId: 'chart' };
        if (input.action === 'chart.export') {
          const rows = [
            [{ text: 'South' }, { number: settings.wrongTotals ? 999 : 125 }],
            [{ text: 'North' }, { number: 50 }],
          ];
          return {
            rows: settings.reversedSort
              ? [...rows].reverse()
              : settings.duplicateExportRow
                ? [...rows, rows[0]]
                : rows,
          };
        }
      }
      if (name === 'qlik_upload_begin') {
        filename = String(input.filename);
        fileSize = Number(input.byteLength);
        return { artifactId: 'staged', chunkBytes: 192 * 1024 };
      }
      if (name === 'qlik_upload_chunk' || name === 'qlik_upload_finish')
        return { status: 'sealed' };
      if (name === 'qlik_artifact_chunk')
        return {
          chunkCount: 1,
          contentBase64: backup.toString('base64'),
          sha256: createHash('sha256').update(backup).digest('hex'),
        };
      throw new Error('UNEXPECTED_FAKE_REQUEST');
    }),
  };
  return { client, writes };
}

describe('deployed management acceptance runner guardrails', () => {
  it('does not enable a live mutation run without its exact opt-in', () => {
    expect(() =>
      acceptanceConfiguration({ ...environment, QLIK_MANAGEMENT_ACCEPTANCE: undefined }),
    ).toThrow('EXPLICIT_SANDBOX_OPT_IN_REQUIRED');
    expect(() =>
      acceptanceConfiguration({
        ...environment,
        QLIK_MANAGEMENT_ACCEPTANCE_ENDPOINT: 'http://mcp.example/mcp',
      }),
    ).toThrow('HTTPS_ENDPOINT_REQUIRED');
    expect(() =>
      acceptanceConfiguration({ ...environment, QLIK_MANAGEMENT_ACCEPTANCE_SPACE_ID: '*' }),
    ).toThrow('EXACT_SANDBOX_TARGET_REQUIRED');
    expect(acceptanceConfiguration(environment).cleanup).toBe(false);
  });

  it('accepts only an explicitly configured separate reviewer for automated fixture review', () => {
    expect(() =>
      acceptanceConfiguration({
        ...environment,
        QLIK_MANAGEMENT_ACCEPTANCE_REVIEW: 'APPROVE_THIS_FIXTURE_RUN',
      }),
    ).toThrow('SEPARATE_REVIEWER_REQUIRED');
    expect(() =>
      acceptanceConfiguration({
        ...environment,
        QLIK_MANAGEMENT_ACCEPTANCE_ENDPOINT: 'https://mcp.example/mcp?token=secret',
      }),
    ).toThrow('ENDPOINT_QUERY_NOT_ALLOWED');
  });

  it('validates the full synthetic scenario offline and leaves all created targets retained by default', async () => {
    const { client, writes } = fakeServer();
    const snapshots: Record<string, unknown>[] = [];
    const report = await runManagementAcceptance(acceptanceConfiguration(environment), {
      connect: async () => client,
      sleep: async () => undefined,
      persist: async (value) => {
        snapshots.push(structuredClone(value));
      },
    });
    expect(report.status).toBe('passed');
    expect(report.evidence).toBe('offline-injected-client');
    expect(report.checks).toContain('app-backup-downloaded-and-checksum-verified');
    expect(report.checks).toContain('table-preview-headers-match-exact-fixture-rows');
    expect(report.checks).toContain('native-bar-measure-descending-export-order');
    expect(report.retained).toBe(true);
    expect(writes).not.toContain('app.delete');
    expect(writes).not.toContain('datafile.delete');
    expect(writes.filter((action) => action === 'app.create')).toHaveLength(1);
    expect(JSON.stringify(snapshots)).not.toContain('private-bearer');
    expect(client.close).toHaveBeenCalledOnce();
  });

  it.each([
    [{ wrongPreviewHeaders: true }, 'TABLE_PREVIEW_VALUES_MISMATCH'],
    [{ reversedSort: true }, 'CHART_SORT_MISMATCH'],
    [{ duplicateExportRow: true }, 'CHART_VALUES_MISMATCH'],
  ])('rejects incorrect preview bindings or chart order: %j', async (settings, errorCode) => {
    const { client, writes } = fakeServer(settings);
    const report = await runManagementAcceptance(acceptanceConfiguration(environment), {
      connect: async () => client,
      sleep: async () => undefined,
      persist: async () => undefined,
    });
    expect(report).toMatchObject({ status: 'failed-or-pending', errorCode });
    expect(writes).not.toContain('sheet.publish');
    expect(writes).not.toContain('app.export');
  });

  it.each([{ rejectedCreate: true }, { uncertainCreate: true, rejectedReconciliation: true }])(
    'reports definitive failure without repeated reconciliation: %j',
    async (settings) => {
      const { client } = fakeServer(settings);
      const report = await runManagementAcceptance(acceptanceConfiguration(environment), {
        connect: async () => client,
        sleep: async () => undefined,
        persist: async () => undefined,
      });
      expect(report).toMatchObject({ status: 'failed-or-pending', errorCode: 'WORKFLOW_FAILED' });
      expect(report.steps).toEqual([expect.objectContaining({ status: 'failed' })]);
      expect(
        vi.mocked(client.call).mock.calls.filter(([name]) => name === 'qlik_management_reconcile'),
      ).toHaveLength(settings.rejectedCreate ? 0 : 1);
    },
  );

  it('preserves an acknowledged app ID and stops without retrying an uncertain creation', async () => {
    const { client, writes } = fakeServer({ uncertainCreate: true });
    const report = await runManagementAcceptance(acceptanceConfiguration(environment), {
      connect: async () => client,
      persist: async () => undefined,
      sleep: async () => undefined,
    });
    expect(report.status).toBe('failed-or-pending');
    expect(report.errorCode).toBe('WORKFLOW_REQUIRES_RECONCILIATION');
    expect(report.resources).toMatchObject({ appId: 'created-app' });
    expect(writes).toEqual(['app.create']);
  });

  it('recovers delayed provider readback through the same plan without creating another app', async () => {
    const { client, writes } = fakeServer({ uncertainCreate: true, recoverable: true });
    const report = await runManagementAcceptance(acceptanceConfiguration(environment), {
      connect: async () => client,
      persist: async () => undefined,
      sleep: async () => undefined,
    });
    expect(report.status).toBe('passed');
    expect(writes.filter((action) => action === 'app.create')).toHaveLength(1);
    expect(client.call).toHaveBeenCalledWith(
      'qlik_management_reconcile',
      expect.objectContaining({ planId: 'plan-0', index: 0 }),
    );
    expect(report.steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'app.create', reconciled: true })]),
    );
  });

  it('fails acceptance when loaded chart values disagree with the synthetic dataset', async () => {
    const { client, writes } = fakeServer({ wrongTotals: true });
    const report = await runManagementAcceptance(acceptanceConfiguration(environment), {
      connect: async () => client,
      sleep: async () => undefined,
      persist: async () => undefined,
    });
    expect(report.errorCode).toBe('CHART_VALUES_MISMATCH');
    expect(writes).not.toContain('app.export');
    expect(report.status).toBe('failed-or-pending');
  });
});
