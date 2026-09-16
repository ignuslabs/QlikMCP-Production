/**
 * Explicit opt-in deployed MCP acceptance. Never runs as part of vitest.
 * Required: QLIK_MANAGEMENT_ACCEPTANCE=CREATE_SANDBOX_RESOURCES,
 * QLIK_MANAGEMENT_ACCEPTANCE_ENDPOINT, QLIK_MANAGEMENT_ACCEPTANCE_BEARER,
 * QLIK_MANAGEMENT_ACCEPTANCE_CONNECTION, QLIK_MANAGEMENT_ACCEPTANCE_SPACE_ID.
 * The exact space must have a currently approved management sandbox grant.
 * If approval is required: QLIK_MANAGEMENT_ACCEPTANCE_ACTOR and a separately
 * authenticated QLIK_MANAGEMENT_ACCEPTANCE_REVIEWER_BEARER, plus
 * QLIK_MANAGEMENT_ACCEPTANCE_REVIEW=APPROVE_THIS_FIXTURE_RUN.
 * Cleanup is off unless QLIK_MANAGEMENT_ACCEPTANCE_CLEANUP=DELETE_CREATED_RESOURCES.
 * Run via the bundled Node launcher and tsx. Tokens are never printed or saved.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

type Json = Record<string, unknown>;
type Step = { action: string; input: Json };
export interface AcceptanceConfiguration {
  readonly endpoint: URL;
  readonly bearer: string;
  readonly connection: string;
  readonly spaceId: string;
  readonly actor?: string;
  readonly reviewerBearer?: string;
  readonly allowReview: boolean;
  readonly cleanup: boolean;
  readonly reportPath: string;
  readonly runId: string;
}
export interface AcceptanceClient {
  call(name: string, input: Json): Promise<Json>;
  close(): Promise<void>;
}

function fail(code: string): never {
  throw new Error(code);
}
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_TOOL_RESPONSE');
  return value as Json;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2_048) fail('INVALID_TOOL_IDENTIFIER');
  return value;
}
function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) fail(`MISSING_${name}`);
  return value;
}
function bearer(value: string): string {
  if (value.length > 16_384 || /\s/.test(value)) fail('INVALID_BEARER');
  return value;
}

export function acceptanceConfiguration(environment: NodeJS.ProcessEnv): AcceptanceConfiguration {
  if (environment.QLIK_MANAGEMENT_ACCEPTANCE !== 'CREATE_SANDBOX_RESOURCES')
    fail('EXPLICIT_SANDBOX_OPT_IN_REQUIRED');
  const endpoint = new URL(required(environment, 'QLIK_MANAGEMENT_ACCEPTANCE_ENDPOINT'));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash)
    fail('HTTPS_ENDPOINT_REQUIRED');
  if (
    endpoint.search &&
    (!/^bedrock-agentcore\.[a-z0-9-]+\.amazonaws\.com$/.test(endpoint.hostname) ||
      [...endpoint.searchParams.keys()].some((key) => key !== 'qualifier') ||
      endpoint.searchParams.getAll('qualifier').length !== 1)
  )
    fail('ENDPOINT_QUERY_NOT_ALLOWED');
  const connection = required(environment, 'QLIK_MANAGEMENT_ACCEPTANCE_CONNECTION');
  const spaceId = required(environment, 'QLIK_MANAGEMENT_ACCEPTANCE_SPACE_ID');
  if (![connection, spaceId].every((value) => /^[A-Za-z0-9_.-]{1,128}$/.test(value)))
    fail('EXACT_SANDBOX_TARGET_REQUIRED');
  const reviewerBearer = environment.QLIK_MANAGEMENT_ACCEPTANCE_REVIEWER_BEARER?.trim();
  const actor = environment.QLIK_MANAGEMENT_ACCEPTANCE_ACTOR?.trim();
  const allowReview = environment.QLIK_MANAGEMENT_ACCEPTANCE_REVIEW === 'APPROVE_THIS_FIXTURE_RUN';
  if (allowReview && (!reviewerBearer || !actor)) fail('SEPARATE_REVIEWER_REQUIRED');
  const runId = randomUUID();
  return {
    endpoint,
    bearer: bearer(required(environment, 'QLIK_MANAGEMENT_ACCEPTANCE_BEARER')),
    connection,
    spaceId,
    ...(actor ? { actor } : {}),
    ...(reviewerBearer ? { reviewerBearer: bearer(reviewerBearer) } : {}),
    allowReview,
    cleanup: environment.QLIK_MANAGEMENT_ACCEPTANCE_CLEANUP === 'DELETE_CREATED_RESOURCES',
    reportPath: path.resolve(
      environment.QLIK_MANAGEMENT_ACCEPTANCE_REPORT ??
        path.join('.qlik-ai-harness', 'management-acceptance', `${runId}.json`),
    ),
    runId,
  };
}

export async function deployedClient(
  endpoint: URL,
  accessToken: string,
): Promise<AcceptanceClient> {
  const client = new Client(
    { name: 'qlik-management-acceptance', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== endpoint.href) fail('TRANSPORT_DESTINATION_CHANGED');
      const headers = new Headers(request.headers);
      headers.set('authorization', `Bearer ${accessToken}`);
      return fetch(request.url, {
        method: request.method,
        headers,
        ...(request.method === 'GET' || request.method === 'HEAD'
          ? {}
          : { body: await request.arrayBuffer() }),
        signal: request.signal,
        redirect: 'error',
      });
    },
  });
  await client.connect(transport);
  return {
    call: async (name, input) => {
      const response = await client.callTool({ name, arguments: input }, { timeout: 120_000 });
      if (response.isError) {
        const text = response.content.find((entry) => entry.type === 'text');
        let code = 'REMOTE_TOOL_REJECTED';
        try {
          const value = object(JSON.parse(text?.type === 'text' ? text.text : '{}'));
          if (typeof value.code === 'string' && /^[A-Z_]{1,80}$/.test(value.code))
            code = value.code;
        } catch {
          /* Only a safe error code crosses into the report. */
        }
        fail(code);
      }
      return object(response.structuredContent);
    },
    close: () => client.close(),
  };
}

const SAFE_RECEIPT_KEYS = new Set([
  'appId',
  'fileId',
  'sheetId',
  'objectId',
  'reloadId',
  'taskId',
  'artifactId',
  'sourceVersion',
  'expectedHash',
  'expectedSheetHash',
  'sha256',
  'byteLength',
  'status',
  'verified',
]);
function receipt(result: Json): Json {
  return Object.fromEntries(
    Object.entries(result).filter(
      ([key, value]) =>
        SAFE_RECEIPT_KEYS.has(key) && ['string', 'number', 'boolean'].includes(typeof value),
    ),
  );
}

export async function runManagementAcceptance(
  configuration: AcceptanceConfiguration,
  dependencies: {
    connect?: typeof deployedClient;
    sleep?: (milliseconds: number) => Promise<unknown>;
    persist?: (report: Json) => Promise<void>;
  } = {},
): Promise<Json> {
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
    const call = (name: string, input: Json) => client!.call(name, input);
    const read = (action: string, input: Json) =>
      call('qlik_management_read', {
        action,
        input: { connection: configuration.connection, ...input },
      });
    const execute = async (action: string, input: Json): Promise<Json> => {
      const workflowSteps: Step[] = [
        { action, input: { connection: configuration.connection, ...input } },
      ];
      const plan = await call('qlik_management_plan', { steps: workflowSteps });
      const planId = string(plan.planId);
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
          steps: workflowSteps,
        });
      }
      // Dispatch once. A missing response never justifies making a second creation request.
      let result = await call('qlik_management_execute', { planId, steps: workflowSteps });
      entry.status = result.status;
      let acknowledged = result.acknowledged
        ? object(result.acknowledged)
        : Array.isArray(result.steps) && result.steps.length
          ? object(result.steps[0])
          : {};
      entry.result = receipt(acknowledged);
      Object.assign(resources, receipt(acknowledged));
      await persist(report);
      if (result.status === 'failed') fail('WORKFLOW_FAILED');
      // Readback can lag creation. Reconcile the same receipt without reissuing the mutation.
      if (result.status !== 'completed') {
        const status = await call('qlik_management_status', { planId });
        const persisted = Array.isArray(status.steps) ? object(status.steps[0]).result : undefined;
        if (persisted) acknowledged = object(persisted);
        entry.result = receipt(acknowledged);
        Object.assign(resources, receipt(acknowledged));
        await persist(report);
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt) await sleep(2_000);
          const reconciled = await call('qlik_management_reconcile', {
            planId,
            steps: workflowSteps,
            index: 0,
          });
          if (reconciled.status === 'failed') {
            entry.status = 'failed';
            fail('WORKFLOW_FAILED');
          }
          if (reconciled.status === 'completed') {
            acknowledged = object(reconciled.result);
            result = { status: 'completed' };
            entry.status = 'completed';
            entry.reconciled = true;
            entry.result = receipt(acknowledged);
            Object.assign(resources, receipt(acknowledged));
            await persist(report);
            break;
          }
        }
      }
      if (result.status !== 'completed') fail('WORKFLOW_REQUIRES_RECONCILIATION');
      return acknowledged;
    };

    const catalog = await call('qlik_management_catalog', {});
    const available = new Set(
      (Array.isArray(catalog.actions) ? catalog.actions : []).map((entry) => object(entry).action),
    );
    for (const action of [
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
      ...(configuration.cleanup ? ['app.delete', 'datafile.delete'] : []),
    ])
      if (!available.has(action)) fail('DEPLOYED_ACTION_MISSING');
    checks.push('deployed-action-catalog');
    const sandbox = await read('space.get', { spaceId: configuration.spaceId });
    if (sandbox.type !== 'shared') fail('SHARED_SANDBOX_SPACE_REQUIRED');
    const name = `Harness acceptance ${configuration.runId}`;
    const created = await execute('app.create', {
      name,
      spaceId: configuration.spaceId,
      description:
        'Synthetic acceptance fixture; created by the opt-in management acceptance runner.',
    });
    const appId = string(created.appId);
    resources.appId = appId;
    const app = await read('app.get', { appId });
    if (app.name !== name || app.spaceId !== configuration.spaceId) fail('APP_READBACK_MISMATCH');
    checks.push('app-created-and-read-back');

    const bytes = Buffer.from('Category,Amount\nNorth,50\nSouth,100\nSouth,25\n');
    const filename = `acceptance-${configuration.runId}.csv`;
    const upload = await call('qlik_upload_begin', {
      connection: configuration.connection,
      spaceId: configuration.spaceId,
      filename,
      mimeType: 'text/csv',
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const artifactId = string(upload.artifactId);
    const chunkBytes = Number(upload.chunkBytes);
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 192 * 1024)
      fail('UPLOAD_CHUNK_BOUND_INVALID');
    for (let offset = 0, index = 0; offset < bytes.length; offset += chunkBytes, index++)
      await call('qlik_upload_chunk', {
        connection: configuration.connection,
        artifactId,
        index,
        contentBase64: bytes.subarray(offset, offset + chunkBytes).toString('base64'),
      });
    await call('qlik_upload_finish', { connection: configuration.connection, artifactId });
    const uploaded = await execute('datafile.upload', {
      artifactId,
      spaceId: configuration.spaceId,
    });
    const fileId = string(uploaded.fileId);
    resources.fileId = fileId;
    const file = await read('datafile.get', { fileId });
    if (
      file.name !== filename ||
      file.size !== bytes.length ||
      file.spaceId !== configuration.spaceId
    )
      fail('DATAFILE_READBACK_MISMATCH');
    checks.push('multipart-dataset-upload-and-readback');

    const manifest = {
      version: 1,
      tables: [
        {
          name: 'AcceptanceData',
          source: { format: 'csv', dataFileId: fileId, delimiter: ',' },
          fields: [
            { source: 'Category', type: { kind: 'text' } },
            {
              source: 'Amount',
              type: {
                kind: 'number',
                format: '0.##############',
                decimalSeparator: '.',
                thousandSeparator: '',
              },
            },
          ],
        },
      ],
    };
    const script = await read('script.get', { appId });
    await execute('script.apply', {
      appId,
      expectedHash: string(script.expectedHash),
      manifest,
      fileVersions: { [fileId]: string(file.sourceVersion) },
    });
    checks.push('version-bound-data-load-script');
    const reload = await execute('reload.create', { appId, partial: false });
    const reloadId = string(reload.reloadId);
    resources.reloadId = reloadId;
    let succeeded = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const observed = await read('reload.get', { reloadId });
      if (observed.status === 'SUCCEEDED') {
        succeeded = true;
        break;
      }
      if (observed.terminal) fail('LIVE_RELOAD_FAILED');
      await sleep(5_000);
    }
    if (!succeeded) fail('LIVE_RELOAD_STILL_PENDING');
    checks.push('reload-reached-succeeded');
    const model = await read('model.inspect', { appId });
    if (
      !Array.isArray(model.tables) ||
      !model.tables.some(
        (table) => object(table).name === 'AcceptanceData' && object(table).rowCount === 3,
      )
    )
      fail('LOADED_MODEL_MISMATCH');
    checks.push('loaded-model-three-fixture-rows');

    const preview = await read('table.preview', {
      appId,
      tableName: 'AcceptanceData',
      offset: 0,
      limit: 10,
    });
    const previewColumns = Array.isArray(preview.columns) ? preview.columns : [];
    if (
      previewColumns.length !== 2 ||
      !previewColumns.includes('Category') ||
      !previewColumns.includes('Amount') ||
      !Array.isArray(preview.rows) ||
      preview.rows.length !== 3
    )
      fail('TABLE_PREVIEW_SHAPE_MISMATCH');
    const previewRows = preview.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== previewColumns.length)
        fail('TABLE_PREVIEW_SHAPE_MISMATCH');
      return JSON.stringify([
        object(row[previewColumns.indexOf('Category')]).qText,
        object(row[previewColumns.indexOf('Amount')]).qNumber,
      ]);
    });
    const expectedRows = [
      ['North', 50],
      ['South', 100],
      ['South', 25],
    ].map((row) => JSON.stringify(row));
    if (JSON.stringify(previewRows.sort()) !== JSON.stringify(expectedRows.sort()))
      fail('TABLE_PREVIEW_VALUES_MISMATCH');
    checks.push('table-preview-headers-match-exact-fixture-rows');

    const sheetId = `acceptance-sheet-${configuration.runId}`;
    const objectId = `acceptance-chart-${configuration.runId}`;
    await execute('sheet.create', { appId, sheetId, title: 'Acceptance dashboard' });
    const sheet = await read('sheet.get', { appId, sheetId });
    await execute('chart.create', {
      appId,
      sheetId,
      objectId,
      expectedSheetHash: string(sheet.expectedHash),
      placement: { col: 0, row: 0, colspan: 12, rowspan: 6 },
      intent: {
        analysis: { dimensions: ['Category'], measures: ['Sum(Amount)'] },
        presentation: {
          preferredChartType: 'bar',
          title: 'Fixture totals',
          sort: 'measure-descending',
        },
        mode: 'apply',
      },
    });
    await read('chart.get', { appId, sheetId, objectId });
    const exported = await read('chart.export', { appId, sheetId, objectId, offset: 0, limit: 10 });
    const totals = new Map(
      (Array.isArray(exported.rows) ? exported.rows : []).map((row) => {
        if (!Array.isArray(row) || row.length !== 2) fail('CHART_EXPORT_SHAPE_MISMATCH');
        return [object(row[0]).text, object(row[1]).number] as const;
      }),
    );
    if (
      !Array.isArray(exported.rows) ||
      exported.rows.length !== 2 ||
      totals.size !== 2 ||
      totals.get('North') !== 50 ||
      totals.get('South') !== 125
    )
      fail('CHART_VALUES_MISMATCH');
    checks.push('native-sheet-chart-and-exact-aggregated-values');
    if (
      object(exported.rows[0][0]).text !== 'South' ||
      object(exported.rows[1][0]).text !== 'North'
    )
      fail('CHART_SORT_MISMATCH');
    checks.push('native-bar-measure-descending-export-order');

    // Newly created sheets are private to the OAuth principal until explicitly published.
    const privateSheet = await read('sheet.get', { appId, sheetId });
    await execute('sheet.publish', {
      appId,
      sheetId,
      expectedHash: string(privateSheet.expectedHash),
    });
    if ((await read('sheet.get', { appId, sheetId })).published !== true)
      fail('SHEET_PUBLICATION_READBACK_MISMATCH');
    checks.push('sheet-made-public-for-shared-space-viewers');

    const backup = await execute('app.export', { appId, noData: false });
    const backupId = string(backup.artifactId);
    const digest = createHash('sha256');
    let downloadedBytes = 0;
    for (let index = 0, count = 1; index < count; index++) {
      const chunk = await call('qlik_artifact_chunk', {
        connection: configuration.connection,
        artifactId: backupId,
        index,
      });
      count = Number(chunk.chunkCount);
      if (!Number.isSafeInteger(count) || count < 1 || count > 300)
        fail('EXPORT_CHUNK_BOUND_INVALID');
      if (typeof chunk.contentBase64 !== 'string' || chunk.contentBase64.length > 262_144)
        fail('EXPORT_CHUNK_BOUND_INVALID');
      const encoded = chunk.contentBase64;
      const part = Buffer.from(encoded, 'base64');
      if (
        part.toString('base64') !== encoded ||
        createHash('sha256').update(part).digest('hex') !== chunk.sha256
      )
        fail('EXPORT_CHUNK_CHECKSUM_MISMATCH');
      downloadedBytes += part.length;
      digest.update(part);
    }
    if (downloadedBytes !== backup.byteLength || digest.digest('hex') !== backup.sha256)
      fail('EXPORT_FULL_CHECKSUM_MISMATCH');
    checks.push('app-backup-downloaded-and-checksum-verified');
    await persist(report);

    if (configuration.cleanup) {
      const latestFile = await read('datafile.get', { fileId });
      if (latestFile.name !== filename || latestFile.spaceId !== configuration.spaceId)
        fail('CLEANUP_FILE_TARGET_CHANGED');
      await execute('datafile.delete', {
        fileId,
        expectedSourceVersion: string(latestFile.sourceVersion),
      });
      const latestApp = await read('app.get', { appId });
      if (latestApp.name !== name || latestApp.spaceId !== configuration.spaceId)
        fail('CLEANUP_APP_TARGET_CHANGED');
      await execute('app.delete', {
        appId,
        expectedSourceVersion: string(latestApp.sourceVersion),
      });
      checks.push('exact-created-resources-deleted-and-verified');
    }
    report.status = 'passed';
    report.retained = !configuration.cleanup;
  } catch (error) {
    report.status = 'failed-or-pending';
    report.errorCode =
      error instanceof Error && /^[A-Z_]{1,100}$/.test(error.message)
        ? error.message
        : 'ACCEPTANCE_OPERATION_FAILED';
    report.retained = true;
  } finally {
    report.finishedAt = new Date().toISOString();
    await persist(report);
    await Promise.allSettled([client?.close(), reviewer?.close()]);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const configuration = acceptanceConfiguration(process.env);
    const report = await runManagementAcceptance(configuration);
    process.stdout.write(
      `${JSON.stringify({ status: report.status, report: configuration.reportPath, runId: configuration.runId })}\n`,
    );
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^[A-Z_]{1,100}$/.test(error.message) ? error.message : 'ACCEPTANCE_CONFIGURATION_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
