import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { OperationService } from '../../server/operationService.js';
import { sheetIntentSchema } from '../../server/sheetService.js';
import { chartTypeIdSchema, connectionSchema, appIdSchema, sheetIdSchema } from '../schemas.js';
import { runTool } from '../toolHandler.js';

const planHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const lookupSchema = z.object({ planHash: planHashSchema }).strict();
const positionSchema = z
  .object({
    col: z.number().int().min(0).max(23),
    row: z.number().int().min(0).max(11),
    colspan: z.number().int().min(1).max(24),
    rowspan: z.number().int().min(1).max(12),
  })
  .strict();
const planOutput = z
  .object({
    version: z.literal(1),
    compilerVersion: z.string(),
    catalogHash: planHashSchema,
    operationId: z.string(),
    planHash: planHashSchema,
    status: z.literal('planned'),
    executionMode: z.literal('scoped-autonomous'),
    title: z.string(),
    target: z
      .object({ connection: connectionSchema, appId: appIdSchema, sheetId: sheetIdSchema })
      .strict(),
    platform: z.enum(['cloud', 'windows', 'fixture']),
    sourceSheetId: sheetIdSchema,
    charts: z
      .array(
        z
          .object({
            planHash: planHashSchema,
            objectId: z.string(),
            title: z.string(),
            chartType: chartTypeIdSchema,
            position: positionSchema,
          })
          .strict(),
      )
      .min(1)
      .max(12),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .strict();
const previewOutput = z
  .object({
    operationId: z.string(),
    planHash: planHashSchema,
    status: z.literal('previewed'),
    charts: z
      .array(
        z
          .object({
            objectId: z.string(),
            returnedRows: z.number().int().min(0),
            truncated: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    verifiedAt: z.string(),
  })
  .strict();
const executionOutput = z
  .object({
    operationId: z.string(),
    planHash: planHashSchema,
    sheetId: sheetIdSchema,
    status: z.enum(['verified', 'partial']),
    verified: z.boolean(),
    charts: z.array(z.object({ objectId: z.string(), verified: z.boolean() }).strict()).max(12),
    verifiedAt: z.string(),
    attempt: z.number().int().min(0).max(20),
    nextAttempt: z.number().int().min(1).max(20).optional(),
    errorCode: z.string().optional(),
    durationMilliseconds: z.number().min(0),
  })
  .strict();

export function registerSheetWorkflow(server: McpServer, service: OperationService): void {
  server.registerTool(
    'qlik_plan_sheet',
    {
      title: 'Plan a new native Qlik sheet',
      description:
        'Compile 1-12 constrained charts using one catalog read into a deterministic new sheet and non-overlapping layout. Requires an explicit server-side actor/app/chart/count grant. Creates no Qlik objects; returns a reviewable manifest and stable IDs.',
      inputSchema: sheetIntentSchema,
      outputSchema: planOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(
        () => service.planSheet(args),
        (result) =>
          `Planned ${result.charts.length} charts in new sheet "${result.title}". Preview this plan before applying it.`,
      ),
  );

  server.registerTool(
    'qlik_preview_sheet',
    {
      title: 'Preview and validate every planned chart',
      description:
        'Create bounded temporary chart sessions, verify expected chart shape and dispose each session. Stores actor-bound preview evidence required by qlik_apply_sheet. A preview does not create or verify a persistent sheet.',
      inputSchema: lookupSchema,
      outputSchema: previewOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) =>
      runTool(
        () => service.previewSheet(args.planHash, extra.mcpReq.signal),
        (result) => `Preview passed for ${result.charts.length} charts.`,
      ),
  );

  server.registerTool(
    'qlik_apply_sheet',
    {
      title: 'Create and verify a scoped autonomous sheet',
      description:
        'Apply only a fresh previewed plan under an explicit server-side new-sheet policy. Rechecks actor/app/chart scope and readiness; creates stable sheet/chart IDs, attaches the planned layout and verifies persisted results. Supply a stable idempotencyKey; for partial results reuse it with the returned nextAttempt. An in-progress or uncertain attempt is blocked: inspect qlik_verify_sheet. Never treats partial work as success.',
      inputSchema: z
        .object({
          planHash: planHashSchema,
          idempotencyKey: z.string().trim().min(1).max(200),
          attempt: z.number().int().min(0).max(20).optional().default(0),
        })
        .strict(),
      outputSchema: executionOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) =>
      runTool(
        () =>
          service.applySheet(args.planHash, args.idempotencyKey, args.attempt, extra.mcpReq.signal),
        (result) =>
          result.verified
            ? `Created and verified sheet ${result.sheetId} with ${result.charts.length} charts.`
            : `Sheet creation is partial (${result.errorCode ?? 'verification incomplete'}). Resume only with returned nextAttempt or inspect qlik_verify_sheet.`,
      ),
  );

  server.registerTool(
    'qlik_verify_sheet',
    {
      title: 'Read back and verify a generated sheet',
      description:
        'Independently read persisted sheet title, exact object membership, chart properties and planned positions. Returns evidence for every chart and a verified/partial result; remains available after plan expiry. Creates no Qlik objects.',
      inputSchema: lookupSchema,
      outputSchema: executionOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(
        () => service.verifySheet(args.planHash),
        (result) =>
          `Sheet ${result.sheetId}: ${result.verified ? 'verified' : 'verification incomplete'}.`,
      ),
  );
}
