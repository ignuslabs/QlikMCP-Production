import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { appIdSchema, connectionSchema, platformSchema, sheetIdSchema } from '../schemas.js';
import { runTool } from '../toolHandler.js';
import type { OperationService } from '../../server/operationService.js';

const inputSchema = z
  .object({
    operationId: z.string().trim().min(1).max(200),
  })
  .strict();

const OPERATION_PHASES = [
  'discovered',
  'planned',
  'previewed',
  'approval-requested',
  'approved',
  'applying',
  'verified',
  'failed',
  'cleanup-required',
  'expired',
  'replayed',
] as const;

const typedOutcomeSchema = z
  .object({
    status: z.enum(OPERATION_PHASES),
    category: z.string().optional(),
    code: z.string().optional(),
    retryable: z.boolean().optional(),
    retryAfterSeconds: z.number().optional(),
    cleanupRequired: z.boolean().optional(),
    originalOperationId: z.string().optional(),
    originalObjectId: z.string().optional(),
  })
  .strict();

const outputSchema = z
  .object({
    recordVersion: z.literal('1.0.0'),
    recordType: z.literal('sanitized-operation-audit'),
    operationId: z.string(),
    timestamp: z.string(),
    correlationId: z.string(),
    requestingPrincipal: z.string(),
    hostClientId: z.string(),
    connectionAlias: connectionSchema,
    platform: platformSchema,
    target: z.object({ appId: appIdSchema, sheetId: sheetIdSchema.optional() }).strict(),
    effectiveQlikIdentityClass: z.string(),
    intentVersion: z.string(),
    compilerVersion: z.string(),
    planHash: z.string().optional(),
    policyResult: z.string(),
    approvalState: z.string(),
    typedOutcome: typedOutcomeSchema,
    retryCount: z.number().int().min(0),
    durationMilliseconds: z.number().min(0),
    cleanupAttempted: z.boolean(),
    cleanupOutcome: z.string(),
    createdObjectId: z.string().nullable(),
    sheetAttachmentId: z.string().nullable().optional(),
    traceReference: z.string(),
    redaction: z
      .object({
        rawPayloadsRemoved: z.literal(true),
        sensitiveValuesRemoved: z.literal(true),
        credentialMaterialPresent: z.literal(false),
      })
      .strict(),
  })
  .strict();

export function registerGetOperation(server: McpServer, service: OperationService): void {
  server.registerTool(
    'qlik_get_operation',
    {
      title: 'Get sanitized operation status',
      description:
        'Returns the sanitized operation/audit record for an operation ID, visible only to the actor that ' +
        'created it. Never includes secrets, tokens, certificates, headers, QIX handles, or full layouts.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(
        () => service.getOperation(args.operationId),
        (result) => `Operation ${result.operationId}: ${result.typedOutcome.status}.`,
      ),
  );
}
