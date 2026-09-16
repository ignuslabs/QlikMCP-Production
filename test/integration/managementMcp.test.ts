import { createHash } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createError } from '../../src/domain/errors.js';
import { buildMcpServer, type McpToolProfile } from '../../src/mcp/server.js';
import { ArtifactService, ARTIFACT_CHUNK_BYTES } from '../../src/management/artifacts.js';
import type { ManagementContext } from '../../src/management/context.js';
import { validateDatasetUpload } from '../../src/management/dataPreparation.js';
import {
  ManagementPolicyEngine,
  managementPolicySchema,
  type ManagementActor,
} from '../../src/management/policy.js';
import { MemoryManagementStore } from '../../src/management/state.js';
import {
  ManagementWorkflow,
  type ActionRegistry,
  type WorkflowStep,
} from '../../src/management/workflow.js';
import { buildTestService } from '../helpers/testContext.js';

const ALICE: ManagementActor = { actor: 'alice', hostClientId: 'requester-app' };
const BOB: ManagementActor = { actor: 'bob', hostClientId: 'requester-app' };
const REVIEWER: ManagementActor = { actor: 'reviewer', hostClientId: 'review-app' };
const CONNECTION = 'cloud-dev';
const SPACE = 'space-authorized';
const MUTATION_STEPS: WorkflowStep[] = [
  { action: 'app.create', input: { connection: CONNECTION, spaceId: SPACE, name: 'Sales' } },
  {
    action: 'sheet.create',
    input: {
      connection: CONNECTION,
      appId: { $ref: { step: 0, field: 'appId' } },
      title: 'Overview',
    },
  },
];

function fixture(options: { requireApproval?: boolean; pendingReload?: boolean } = {}) {
  const store = new MemoryManagementStore();
  const puts = vi.spyOn(store, 'put');
  let reloadChecks = 0;
  const executed = vi.fn(async (action: string, input: Record<string, unknown>) => {
    if (action === 'app.get') return { appId: input.appId, name: 'Sales', spaceId: SPACE };
    if (action === 'app.create') return { appId: 'app-created', spaceId: SPACE, created: true };
    if (action === 'sheet.create')
      return { appId: input.appId, sheetId: 'sheet-created', created: true };
    if (action === 'reload.start')
      return { appId: input.appId, reloadId: 'reload-created', status: 'QUEUED' };
    if (action === 'reload.wait') {
      reloadChecks += 1;
      const pending = options.pendingReload && reloadChecks === 1;
      return {
        reloadId: input.reloadId,
        status: pending ? 'RUNNING' : 'SUCCEEDED',
        workflowPending: !!pending,
      };
    }
    return { verified: true };
  });
  const grants = [ALICE, BOB].map((actor) => ({
    actor: actor.actor,
    clientId: actor.hostClientId,
    connection: CONNECTION,
    actions: [
      'app.get',
      'app.create',
      'sheet.create',
      'reload.start',
      'reload.wait',
      'datafile.upload',
      'artifact.read',
    ],
    appIds: ['app-existing'],
    spaceIds: [SPACE],
    allowPersonalSpace: false,
    requireApproval: options.requireApproval ?? true,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }));
  const policy = new ManagementPolicyEngine(
    managementPolicySchema.parse({
      version: 1,
      enabled: true,
      environment: 'test',
      grants,
      reviewers: [{ actor: REVIEWER.actor, clientId: REVIEWER.hostClientId }],
      maxUploadBytes: 2 * 1024 * 1024,
    }),
  );
  const artifacts = new ArtifactService(store, policy.policy.maxUploadBytes);
  const actions: ActionRegistry = {
    'app.get': {
      schema: z.object({ connection: z.string(), appId: z.string() }).strict(),
      readOnly: true,
      inspect: async (input) => ({ appId: String(input.appId) }),
      execute: (input) => executed('app.get', input),
    },
    'app.create': {
      schema: z.object({ connection: z.string(), spaceId: z.string(), name: z.string() }).strict(),
      readOnly: false,
      inspect: async (input) => ({ targetSpaceId: String(input.spaceId) }),
      execute: (input) => executed('app.create', input),
    },
    'sheet.create': {
      schema: z.object({ connection: z.string(), appId: z.string(), title: z.string() }).strict(),
      readOnly: false,
      inspect: async (input) => ({ appId: String(input.appId), spaceId: SPACE }),
      execute: (input) => executed('sheet.create', input),
    },
    'reload.start': {
      schema: z.object({ connection: z.string(), appId: z.string() }).strict(),
      readOnly: false,
      inspect: async (input) => ({ appId: String(input.appId), spaceId: SPACE }),
      execute: (input) => executed('reload.start', input),
    },
    'reload.wait': {
      schema: z.object({ connection: z.string(), reloadId: z.string() }).strict(),
      readOnly: true,
      inspect: async () => ({ spaceId: SPACE }),
      execute: (input) => executed('reload.wait', input),
    },
    'datafile.upload': {
      schema: z
        .object({ connection: z.string(), artifactId: z.string(), spaceId: z.string() })
        .strict(),
      readOnly: false,
      inspect: async (input) => ({ targetSpaceId: String(input.spaceId) }),
      execute: async (input) => {
        const artifact = await artifacts.read(ALICE.actor, String(input.artifactId));
        const checked = await validateDatasetUpload({
          filename: artifact.metadata.filename,
          mimeType: artifact.metadata.mimeType,
          contentBase64: artifact.bytes.toString('base64'),
          expectedSha256: artifact.metadata.sha256,
        });
        await executed('datafile.upload', {
          connection: input.connection,
          byteLength: checked.byteLength,
        });
        return { fileId: 'file-created', spaceId: SPACE, sha256: checked.sha256, created: true };
      },
    },
  };
  const context = (actor: ManagementActor): ManagementContext => ({
    workflow: new ManagementWorkflow(actor, policy, store, actions),
    artifacts,
    policy,
  });
  return { store, puts, executed, context, artifacts };
}

async function connect(context: ManagementContext | undefined, profile: McpToolProfile = 'all') {
  const server = buildMcpServer(buildTestService().service, profile, context);
  const client = new Client({ name: `management-${profile}`, version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

async function call(client: Client, name: string, input: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: input });
}

function payload(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

describe('management MCP integration with injected mock providers', () => {
  it('rejects invalid fields and malformed references before persisting or executing any workflow', async () => {
    const contexts = fixture({ requireApproval: false });
    const session = await connect(contexts.context(ALICE), 'requester');
    try {
      const second = MUTATION_STEPS[1]!;
      for (const input of [
        { ...second.input, title: undefined },
        { ...second.input, title: 123 },
        { ...second.input, extra: 'private-source-text' },
        { ...second.input, appId: { $ref: { step: 1, field: 'appId' } } },
        { ...second.input, appId: { $ref: { step: 0, field: 'unapprovedOutput' } } },
        { ...second.input, appId: { $ref: { step: 0, field: 'appId' }, extra: true } },
      ]) {
        const result = await call(session.client, 'qlik_management_plan', {
          steps: [MUTATION_STEPS[0], { ...second, input }],
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain('private-source-text');
      }
      expect(contexts.puts).not.toHaveBeenCalled();
      expect(contexts.executed).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('resumes the same live reload wait and does not replay creation or proceed to sheets while pending', async () => {
    const contexts = fixture({ requireApproval: false, pendingReload: true });
    const session = await connect(contexts.context(ALICE), 'requester');
    const steps = [
      MUTATION_STEPS[0]!,
      {
        action: 'reload.start',
        input: { connection: CONNECTION, appId: { $ref: { step: 0, field: 'appId' } } },
      },
      {
        action: 'reload.wait',
        input: { connection: CONNECTION, reloadId: { $ref: { step: 1, field: 'reloadId' } } },
      },
      MUTATION_STEPS[1]!,
    ];
    try {
      const planned = payload(await call(session.client, 'qlik_management_plan', { steps }));
      const first = payload(
        await call(session.client, 'qlik_management_execute', { planId: planned.planId, steps }),
      );
      expect(first).toMatchObject({
        status: 'waiting',
        stoppedAt: 2,
        pending: { reloadId: 'reload-created', status: 'RUNNING' },
      });
      expect(contexts.executed.mock.calls.map(([action]) => action)).toEqual([
        'app.create',
        'reload.start',
        'reload.wait',
      ]);
      const status = payload(
        await call(session.client, 'qlik_management_status', { planId: planned.planId }),
      );
      expect(status.steps).toMatchObject([
        { status: 'completed' },
        { status: 'completed' },
        { status: 'waiting' },
        { status: 'pending' },
      ]);
      const resumed = payload(
        await call(session.client, 'qlik_management_execute', { planId: planned.planId, steps }),
      );
      expect(resumed.status).toBe('completed');
      expect(contexts.executed.mock.calls.map(([action]) => action)).toEqual([
        'app.create',
        'reload.start',
        'reload.wait',
        'reload.wait',
        'sheet.create',
      ]);
      expect(
        contexts.executed.mock.calls
          .filter(([action]) => action === 'reload.wait')
          .map(([, input]) => input.reloadId),
      ).toEqual(['reload-created', 'reload-created']);
    } finally {
      await session.close();
    }
  });

  it('leaves invalid CSV uploads unsealed and carries a declared delimiter into the finished preview', async () => {
    const contexts = fixture({ requireApproval: false });
    const session = await connect(contexts.context(ALICE), 'requester');
    try {
      for (const [content, valid] of [
        ['ID;Name\n1;Alice', true],
        ['ID;Name\n1', false],
      ] as const) {
        const bytes = Buffer.from(content);
        const begin = payload(
          await call(session.client, 'qlik_upload_begin', {
            connection: CONNECTION,
            spaceId: SPACE,
            filename: 'dataset.csv',
            mimeType: 'text/csv',
            csvDelimiter: ';',
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }),
        );
        payload(
          await call(session.client, 'qlik_upload_chunk', {
            connection: CONNECTION,
            artifactId: begin.artifactId,
            index: 0,
            contentBase64: bytes.toString('base64'),
          }),
        );
        const result = await call(session.client, 'qlik_upload_finish', {
          connection: CONNECTION,
          artifactId: begin.artifactId,
        });
        if (valid) {
          expect(payload(result).preview).toMatchObject({
            tables: [{ columns: ['ID', 'Name'], rows: [['1', 'Alice']] }],
          });
        } else {
          expect(result.isError).toBe(true);
          const stored = await contexts.store.get(ALICE.actor, String(begin.artifactId));
          expect(stored?.data.status).toBe('uploading');
          expect(
            (
              await call(session.client, 'qlik_artifact_chunk', {
                connection: CONNECTION,
                artifactId: begin.artifactId,
                index: 0,
              })
            ).isError,
          ).toBe(true);
        }
      }
    } finally {
      await session.close();
    }
  });

  it('requires current personal-space permission for artifacts created under an earlier grant', async () => {
    const contexts = fixture();
    const session = await connect(contexts.context(ALICE), 'requester');
    try {
      const bytes = Buffer.from('ID\n1');
      const metadata = {
        connection: CONNECTION,
        filename: 'personal.csv',
        mimeType: 'text/csv',
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        purpose: 'dataset' as const,
      };
      // Seed an artifact retained from an earlier personal-space grant. The
      // current policy permits only the explicitly named shared space.
      const old = await contexts.artifacts.begin(ALICE.actor, metadata);
      const artifactId = old.artifactId;
      expect(
        (
          await call(session.client, 'qlik_upload_chunk', {
            connection: CONNECTION,
            artifactId,
            index: 0,
            contentBase64: bytes.toString('base64'),
          })
        ).isError,
      ).toBe(true);
      expect(
        (await call(session.client, 'qlik_upload_finish', { connection: CONNECTION, artifactId }))
          .isError,
      ).toBe(true);
      const sealed = await contexts.artifacts.save(ALICE.actor, bytes, {
        connection: CONNECTION,
        filename: 'personal.csv',
        mimeType: 'text/csv',
        purpose: 'dataset',
      });
      expect(
        (
          await call(session.client, 'qlik_artifact_chunk', {
            connection: CONNECTION,
            artifactId: sealed.artifactId,
            index: 0,
          })
        ).isError,
      ).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('consults current resource authorization before releasing an app artifact from an old allowed space', async () => {
    const contexts = fixture();
    const artifact = await contexts.artifacts.save(ALICE.actor, Buffer.from('synthetic backup'), {
      connection: CONNECTION,
      appId: 'app-existing',
      spaceId: SPACE,
      filename: 'app.qvf',
      mimeType: 'application/octet-stream',
      purpose: 'app-export',
    });
    const authorizeCurrentResource = vi.fn(async () => {
      throw createError('PERMISSION_DENIED');
    });
    const session = await connect(
      { ...contexts.context(ALICE), authorizeArtifact: authorizeCurrentResource },
      'requester',
    );
    try {
      const result = await call(session.client, 'qlik_artifact_chunk', {
        connection: CONNECTION,
        artifactId: artifact.artifactId,
        index: 0,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(authorizeCurrentResource).toHaveBeenCalledWith(
        artifact.artifactId,
        CONNECTION,
        'artifact.read',
      );
      expect(JSON.stringify(result)).not.toContain('synthetic backup');
    } finally {
      await session.close();
    }
  });

  it('keeps optional management tools isolated from default, requester, reviewer, and verifier profiles', async () => {
    const contexts = fixture();
    const noManagement = await connect(undefined);
    const requester = await connect(contexts.context(ALICE), 'requester');
    const reviewer = await connect(contexts.context(REVIEWER), 'reviewer');
    const verifier = await connect(contexts.context(ALICE), 'verifier');
    const all = await connect(contexts.context(ALICE));
    try {
      expect((await noManagement.client.listTools()).tools).toHaveLength(16);
      const requesterTools = (await requester.client.listTools()).tools;
      const requesterNames = requesterTools.map((tool) => tool.name);
      expect(requesterNames).toContain('qlik_management_execute');
      expect(requesterNames).toContain('qlik_upload_finish');
      expect(requesterNames).not.toContain('qlik_management_approve');
      const reviewerNames = (await reviewer.client.listTools()).tools.map((tool) => tool.name);
      expect(reviewerNames).toContain('qlik_management_approve');
      expect(reviewerNames).not.toContain('qlik_management_execute');
      expect(reviewerNames).not.toContain('qlik_upload_begin');
      expect((await verifier.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'qlik_get_visualization_approval',
      ]);
      const allNames = (await all.client.listTools()).tools.map((tool) => tool.name);
      expect(allNames).toContain('qlik_management_approve');
      expect(allNames).toContain('qlik_management_execute');
      for (const tool of requesterTools.filter(
        (tool) =>
          tool.name.startsWith('qlik_management_') ||
          tool.name.startsWith('qlik_upload_') ||
          tool.name === 'qlik_artifact_chunk',
      )) {
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.outputSchema).toBeDefined();
      }
      expect(
        requesterTools.find((tool) => tool.name === 'qlik_management_read')?.annotations
          ?.readOnlyHint,
      ).toBe(true);
      expect(
        requesterTools.find((tool) => tool.name === 'qlik_management_execute')?.annotations
          ?.destructiveHint,
      ).toBe(true);
    } finally {
      await Promise.all([
        noManagement.close(),
        requester.close(),
        reviewer.close(),
        verifier.close(),
        all.close(),
      ]);
    }
  });

  it('lists strict action contracts and allows only authorized read-only operations through the read tool', async () => {
    const contexts = fixture();
    const session = await connect(contexts.context(ALICE), 'requester');
    try {
      const catalog = payload(await call(session.client, 'qlik_management_catalog'));
      expect(catalog.maxUploadBytes).toBe(2 * 1024 * 1024);
      const actions = catalog.actions as {
        action: string;
        readOnly: boolean;
        inputSchema: Record<string, unknown>;
      }[];
      expect(
        actions.find((action) => action.action === 'app.create')?.inputSchema.additionalProperties,
      ).toBe(false);
      expect(
        payload(
          await call(session.client, 'qlik_management_read', {
            action: 'app.get',
            input: { connection: CONNECTION, appId: 'app-existing' },
          }),
        ),
      ).toMatchObject({ appId: 'app-existing', name: 'Sales' });
      for (const input of [
        { action: 'app.create', input: MUTATION_STEPS[0]!.input },
        { action: 'app.get', input: { connection: CONNECTION, appId: 'ungranted-app' } },
        { action: 'app.get', input: { connection: 'other-connection', appId: 'app-existing' } },
        {
          action: 'app.get',
          input: {
            connection: CONNECTION,
            appId: 'app-existing',
            rawScript: 'private-source-text',
          },
        },
      ]) {
        const result = await call(session.client, 'qlik_management_read', input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain('private-source-text');
      }
      expect((await call(session.client, 'qlik_management_catalog', { extra: true })).isError).toBe(
        true,
      );
      expect(contexts.executed).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  });

  it('binds plans and approvals to actors and exact input and resumes completed mutations without replay', async () => {
    const contexts = fixture();
    const alice = await connect(contexts.context(ALICE));
    const bob = await connect(contexts.context(BOB), 'requester');
    const reviewer = await connect(contexts.context(REVIEWER), 'reviewer');
    const differentClient = await connect(
      contexts.context({ ...ALICE, hostClientId: 'different-client' }),
      'requester',
    );
    try {
      const planned = payload(
        await call(alice.client, 'qlik_management_plan', { steps: MUTATION_STEPS }),
      );
      const planId = planned.planId;
      expect(planned.status).toBe('awaiting-approval');
      expect(contexts.executed).not.toHaveBeenCalled();
      expect(
        (await call(alice.client, 'qlik_management_execute', { planId, steps: MUTATION_STEPS }))
          .isError,
      ).toBe(true);
      expect(
        (
          await call(alice.client, 'qlik_management_approve', {
            owner: ALICE.actor,
            planId,
            steps: MUTATION_STEPS,
          })
        ).isError,
      ).toBe(true);
      expect((await call(bob.client, 'qlik_management_status', { planId })).isError).toBe(true);
      expect(
        (await call(differentClient.client, 'qlik_management_status', { planId })).isError,
      ).toBe(true);
      const changed = [
        { ...MUTATION_STEPS[0]!, input: { ...MUTATION_STEPS[0]!.input, name: 'Changed' } },
        MUTATION_STEPS[1]!,
      ];
      expect(
        (
          await call(reviewer.client, 'qlik_management_approve', {
            owner: ALICE.actor,
            planId,
            steps: changed,
          })
        ).isError,
      ).toBe(true);
      expect(
        payload(
          await call(reviewer.client, 'qlik_management_approve', {
            owner: ALICE.actor,
            planId,
            steps: MUTATION_STEPS,
          }),
        ).status,
      ).toBe('approved');
      expect(
        (await call(bob.client, 'qlik_management_execute', { planId, steps: MUTATION_STEPS }))
          .isError,
      ).toBe(true);
      expect(
        (await call(alice.client, 'qlik_management_execute', { planId, steps: changed })).isError,
      ).toBe(true);
      expect(
        payload(
          await call(alice.client, 'qlik_management_execute', { planId, steps: MUTATION_STEPS }),
        ),
      ).toMatchObject({
        status: 'completed',
        steps: [{ appId: 'app-created' }, { appId: 'app-created', sheetId: 'sheet-created' }],
      });
      expect(contexts.executed).toHaveBeenNthCalledWith(2, 'sheet.create', {
        connection: CONNECTION,
        appId: 'app-created',
        title: 'Overview',
      });
      expect(
        payload(
          await call(alice.client, 'qlik_management_execute', { planId, steps: MUTATION_STEPS }),
        ).status,
      ).toBe('completed');
      expect(contexts.executed).toHaveBeenCalledTimes(2);
      const status = payload(await call(alice.client, 'qlik_management_status', { planId }));
      expect(status.steps).toMatchObject([{ status: 'completed' }, { status: 'completed' }]);
      const auditRecords = contexts.puts.mock.calls
        .map(([record]) => record)
        .filter((record) => record.kind === 'plan' || record.kind === 'execution');
      expect(auditRecords.length).toBeGreaterThan(0);
      expect(JSON.stringify(auditRecords)).not.toContain('Overview');
      expect(JSON.stringify(auditRecords)).not.toContain('Sales');
    } finally {
      await Promise.all([alice.close(), bob.close(), reviewer.close(), differentClient.close()]);
    }
  });

  it('roundtrips multi-chunk CSV privately and returns a bounded preview without raw Buffer or base64', async () => {
    const contexts = fixture({ requireApproval: false });
    const alice = await connect(contexts.context(ALICE), 'requester');
    const bob = await connect(contexts.context(BOB), 'requester');
    try {
      const bytes = Buffer.from(`ID,Name,Amount\n${'001,Alice,10\n'.repeat(20_000)}`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const begun = payload(
        await call(alice.client, 'qlik_upload_begin', {
          connection: CONNECTION,
          spaceId: SPACE,
          filename: 'sales.csv',
          mimeType: 'text/csv',
          byteLength: bytes.length,
          sha256,
        }),
      );
      expect(begun.chunkBytes).toBe(ARTIFACT_CHUNK_BYTES);
      const artifactId = begun.artifactId;
      expect(
        (await call(alice.client, 'qlik_upload_finish', { connection: CONNECTION, artifactId }))
          .isError,
      ).toBe(true);
      const first = bytes.subarray(0, ARTIFACT_CHUNK_BYTES).toString('base64');
      expect(
        (
          await call(bob.client, 'qlik_upload_chunk', {
            connection: CONNECTION,
            artifactId,
            index: 0,
            contentBase64: first,
          })
        ).isError,
      ).toBe(true);
      for (
        let offset = 0, index = 0;
        offset < bytes.length;
        offset += ARTIFACT_CHUNK_BYTES, index += 1
      ) {
        const contentBase64 = bytes
          .subarray(offset, offset + ARTIFACT_CHUNK_BYTES)
          .toString('base64');
        expect(
          payload(
            await call(alice.client, 'qlik_upload_chunk', {
              connection: CONNECTION,
              artifactId,
              index,
              contentBase64,
            }),
          ).accepted,
        ).toBe(true);
      }
      expect(
        payload(
          await call(alice.client, 'qlik_upload_chunk', {
            connection: CONNECTION,
            artifactId,
            index: 0,
            contentBase64: first,
          }),
        ).replayed,
      ).toBe(true);
      const finished = payload(
        await call(alice.client, 'qlik_upload_finish', { connection: CONNECTION, artifactId }),
      );
      expect(finished).toMatchObject({
        status: 'sealed',
        sha256,
        byteLength: bytes.length,
        inspection: { level: 'parsed-csv' },
      });
      const preview = finished.preview as {
        available: boolean;
        tables: { rows: unknown[]; totalRowCount: number }[];
      };
      expect(preview.available).toBe(true);
      expect(preview.tables[0]?.rows).toHaveLength(50);
      expect(preview.tables[0]?.totalRowCount).toBe(20_000);
      expect(finished).not.toHaveProperty('bytes');
      expect(JSON.stringify(finished)).not.toContain('contentBase64');
      expect(contexts.executed).not.toHaveBeenCalled();
      expect(
        payload(
          await call(alice.client, 'qlik_upload_finish', { connection: CONNECTION, artifactId }),
        ).sha256,
      ).toBe(sha256);
      expect(
        (await call(bob.client, 'qlik_upload_finish', { connection: CONNECTION, artifactId }))
          .isError,
      ).toBe(true);
      expect(
        (
          await call(bob.client, 'qlik_artifact_chunk', {
            connection: CONNECTION,
            artifactId,
            index: 0,
          })
        ).isError,
      ).toBe(true);
      const firstDownload = payload(
        await call(alice.client, 'qlik_artifact_chunk', {
          connection: CONNECTION,
          artifactId,
          index: 0,
        }),
      );
      expect(firstDownload.contentBase64).toBe(first);
      const steps = [
        {
          action: 'datafile.upload',
          input: { connection: CONNECTION, artifactId, spaceId: SPACE },
        },
      ];
      const plan = payload(await call(alice.client, 'qlik_management_plan', { steps }));
      expect(
        payload(await call(alice.client, 'qlik_management_execute', { planId: plan.planId, steps }))
          .status,
      ).toBe('completed');
      expect(contexts.executed).toHaveBeenCalledTimes(1);
      const auditRecords = contexts.puts.mock.calls
        .map(([record]) => record)
        .filter((record) => record.kind === 'plan' || record.kind === 'execution');
      expect(JSON.stringify(auditRecords)).not.toContain('001,Alice,10');
      expect(JSON.stringify(auditRecords)).not.toContain('contentBase64');
    } finally {
      await Promise.all([alice.close(), bob.close()]);
    }
  });
});
