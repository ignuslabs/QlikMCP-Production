import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createError } from '../../domain/errors.js';
import type { ManagementContext } from '../../management/context.js';
import { validateDatasetUpload } from '../../management/dataPreparation.js';
import { workflowStepsSchema } from '../../management/workflow.js';
import { runTool } from '../toolHandler.js';
import type { McpToolProfile } from '../server.js';

const outputSchema = z.record(z.string(), z.unknown());
const identifier = z.string().trim().min(1).max(256);
const artifactIdSchema = z.string().regex(/^artifact-[0-9a-f-]{36}$/);

export function registerManagement(
  server: McpServer,
  context: ManagementContext,
  profile: McpToolProfile,
): void {
  const workflow = context.workflow;
  if (profile === 'all' || profile === 'reviewer') {
    server.registerTool(
      'qlik_management_approve',
      {
        title: 'Approve an exact management workflow',
        description:
          'Separately authenticated reviewer only. Review the complete steps, including exact scripts and sharing/deletion targets; obtain explicit human approval before invoking. Input steps must match the immutable requester plan. Requesters cannot approve themselves.',
        inputSchema: z
          .object({ owner: identifier, planId: identifier, steps: workflowStepsSchema })
          .strict(),
        outputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) =>
        runTool(
          () => workflow.approve(input.owner, input.planId, input.steps),
          () => 'Management workflow approved.',
        ),
    );
  }
  if (profile !== 'all' && profile !== 'requester') return;
  server.registerTool(
    'qlik_management_catalog',
    {
      title: 'Discover management actions and input contracts',
      description:
        'Lists app, sheet, chart, dataset, load-script, reload, schedule, quality, sharing, publishing and export actions with exact schemas. Mutations use plan then execute; use prior-step references as {$ref:{step:0,field:"appId"}}. Policy may restrict listed actions.',
      inputSchema: z.object({}).strict(),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      runTool(
        async () => ({
          actions: Object.entries(workflow.actions).map(([action, definition]) => ({
            action,
            readOnly: definition.readOnly,
            inputSchema: z.toJSONSchema(definition.schema, { unrepresentable: 'any' }),
          })),
          uploadChunkBytes: 192 * 1024,
          maxUploadBytes: context.policy.policy.maxUploadBytes,
        }),
        (result) => `${result.actions.length} management actions are available.`,
      ),
  );
  server.registerTool(
    'qlik_management_read',
    {
      title: 'Inspect a Qlik management resource',
      description:
        'Runs a read-only action from qlik_management_catalog. Inspect exact targets and current version hashes before planning updates or deletes. Data profiles are bounded samples. Reload submission does not mean reload completion.',
      inputSchema: z
        .object({ action: identifier, input: z.record(z.string(), z.unknown()) })
        .strict(),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) =>
      runTool(
        () => workflow.read(input.action, input.input),
        () => 'Management inspection completed.',
      ),
  );
  server.registerTool(
    'qlik_management_plan',
    {
      title: 'Plan a complete Qlik management workflow',
      description:
        'Validates and binds up to 40 ordered actions to the authenticated actor and a 15-minute plan. Use exact schemas from the catalog. Prior-step references resolve from durable ID/version outputs. Uploaded datasets use a sealed artifactId. Returns approval requirement; nothing is written to Qlik.',
      inputSchema: z.object({ steps: workflowStepsSchema }).strict(),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) =>
      runTool(
        () => workflow.plan(input.steps),
        (result) => `Workflow ${result.planId} is ${result.status}.`,
      ),
  );
  server.registerTool(
    'qlik_management_execute',
    {
      title: 'Execute or resume a planned Qlik workflow',
      description:
        'Executes the identical approved plan with durable per-step claims. Reuse the plan ID and identical steps for retries; completed steps are not replayed. Unknown write outcomes stop for reconciliation. Completed means requested actions returned, not that a submitted reload has finished; inspect reload.get before claiming a loaded app.',
      inputSchema: z.object({ planId: identifier, steps: workflowStepsSchema }).strict(),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) =>
      runTool(
        () => workflow.execute(input.planId, input.steps),
        (result) => `Workflow status: ${result.status}.`,
      ),
  );
  server.registerTool(
    'qlik_management_status',
    {
      title: 'Read durable workflow progress',
      description:
        'Returns the owner-bound plan and per-step checkpoints. in-progress or uncertain steps must be reconciled before further writes.',
      inputSchema: z.object({ planId: identifier }).strict(),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(
        () => workflow.status(input.planId),
        () => 'Workflow progress retrieved.',
      ),
  );
  server.registerTool(
    'qlik_management_reconcile',
    {
      title: 'Reconcile a Qlik workflow through independent readback',
      description:
        'Rechecks an acknowledged or uncertain completed attempt without repeating its mutation. Supplies the original immutable steps and index. Only independently confirmed results release the target lock; unproven results remain blocked.',
      inputSchema: z
        .object({
          planId: identifier,
          steps: workflowStepsSchema,
          index: z.number().int().min(0).max(39),
        })
        .strict(),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) =>
      runTool(
        () => workflow.reconcile(input.planId, input.steps, input.index),
        (result) => `Reconciliation status: ${result.status}.`,
      ),
  );

  const authorizeArtifact = async (artifactId: string, connection: string, action: string) => {
    if (context.authorizeArtifact) {
      await context.authorizeArtifact(artifactId, connection, action);
      return;
    }
    const record = await context.artifacts.inspect(workflow.actor.actor, artifactId);
    if (record.data.connection !== connection) throw createError('PERMISSION_DENIED');
    const grant = context.policy.grant(workflow.actor, connection, action);
    context.policy.authorizeTarget(grant, {
      ...(typeof record.data.spaceId === 'string' ? { spaceId: record.data.spaceId } : {}),
      ...(typeof record.data.appId === 'string' ? { appId: record.data.appId } : {}),
      ...(!record.data.spaceId && !record.data.appId ? { personalSpace: true } : {}),
    });
    return record;
  };
  server.registerTool(
    'qlik_upload_begin',
    {
      title: 'Start a private dataset upload',
      description:
        'Creates a one-day owner-bound upload manifest. Send fixed-size chunks, then finish to verify the checksum and content. Does not upload to Qlik until datafile.upload is executed.',
      inputSchema: z
        .object({
          connection: identifier,
          spaceId: identifier.optional(),
          filename: z.string().min(1).max(255),
          mimeType: z.string().min(1).max(150),
          byteLength: z.number().int().min(1),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          csvDelimiter: z.enum([',', ';', '\t', '|']).optional(),
        })
        .strict(),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(
        async () => {
          const grant = context.policy.grant(workflow.actor, input.connection, 'datafile.upload');
          context.policy.authorizeTarget(
            grant,
            input.spaceId ? { spaceId: input.spaceId } : { personalSpace: true },
          );
          if (input.byteLength > context.policy.policy.maxUploadBytes)
            throw createError('CAPACITY_EXHAUSTED', {
              message: 'Dataset exceeds the configured upload limit.',
            });
          return context.artifacts.begin(workflow.actor.actor, { ...input, purpose: 'dataset' });
        },
        (result) => `Upload ${result.artifactId} is ready for chunks.`,
      ),
  );
  server.registerTool(
    'qlik_upload_chunk',
    {
      title: 'Send a dataset upload chunk',
      description:
        'Sends one canonical base64 chunk of at most 192 KiB decoded bytes. Exact chunk replay is safe; conflicting bytes are rejected.',
      inputSchema: z
        .object({
          connection: identifier,
          artifactId: artifactIdSchema,
          index: z.number().int().min(0),
          contentBase64: z.string().min(4).max(262144),
        })
        .strict(),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(
        async () => {
          await authorizeArtifact(input.artifactId, input.connection, 'datafile.upload');
          return context.artifacts.chunk(
            workflow.actor.actor,
            input.artifactId,
            input.index,
            input.contentBase64,
          );
        },
        () => 'Upload chunk accepted.',
      ),
  );
  server.registerTool(
    'qlik_upload_finish',
    {
      title: 'Verify and preview an uploaded dataset',
      description:
        'Checks all bytes against the manifest checksum, validates the dataset format, and returns a bounded preview where supported. QVD local inspection is metadata-level; actual values require loading and Engine preview.',
      inputSchema: z.object({ connection: identifier, artifactId: artifactIdSchema }).strict(),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(
        async () => {
          await authorizeArtifact(input.artifactId, input.connection, 'datafile.upload');
          let summary: Record<string, unknown> = {};
          const finished = await context.artifacts.finish(
            workflow.actor.actor,
            input.artifactId,
            async (bytes, metadata) => {
              const checked = await validateDatasetUpload({
                filename: metadata.filename,
                mimeType: metadata.mimeType,
                expectedSha256: metadata.sha256,
                contentBase64: bytes.toString('base64'),
                csvDelimiter: metadata.csvDelimiter,
              });
              const { bytes: _bytes, ...result } = checked;
              summary = result;
            },
          );
          return { ...finished, ...summary };
        },
        () => 'Dataset checksum and format validated.',
      ),
  );
  server.registerTool(
    'qlik_artifact_chunk',
    {
      title: 'Download a private export artifact chunk',
      description:
        'Returns an owner-bound chunk of an app backup, reload log or dataset artifact. Artifacts expire after one day; verify full checksum after downloading.',
      inputSchema: z
        .object({
          connection: identifier,
          artifactId: artifactIdSchema,
          index: z.number().int().min(0),
        })
        .strict(),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(
        async () => {
          await authorizeArtifact(input.artifactId, input.connection, 'artifact.read');
          return context.artifacts.downloadChunk(
            workflow.actor.actor,
            input.artifactId,
            input.index,
          );
        },
        () => 'Artifact chunk retrieved.',
      ),
  );
}
