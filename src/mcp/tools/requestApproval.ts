import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  appIdSchema,
  chartTypeIdSchema,
  compactDiffSchema,
  connectionSchema,
  riskClassSchema,
  sheetIdSchema,
} from '../schemas.js';
import { runTool } from '../toolHandler.js';
import type { OperationService } from '../../server/operationService.js';

const inputSchema = z
  .object({
    planHash: z.string().trim().min(1).max(200),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const outputSchema = z
  .object({
    requestId: z.string(),
    planHash: z.string(),
    requestingActor: z.string(),
    connection: connectionSchema,
    appId: appIdSchema,
    sheetId: sheetIdSchema,
    chartType: chartTypeIdSchema,
    title: z.string(),
    resolvedSummary: z
      .object({
        dimensions: z.array(z.string()),
        measures: z.array(z.string()),
        filters: z.array(
          z
            .object({
              field: z.string(),
              values: z.array(z.string()),
            })
            .strict(),
        ),
      })
      .strict(),
    riskClass: riskClassSchema,
    warnings: z.array(z.string()),
    diff: compactDiffSchema,
    note: z.string().optional(),
    createdAt: z.string(),
    expiresAt: z.string(),
    status: z.literal('pending'),
  })
  .strict();

export function registerRequestApproval(server: McpServer, service: OperationService): void {
  server.registerTool(
    'qlik_request_visualization_approval',
    {
      title: 'Request approval for a chart plan',
      description:
        'Creates a pending request bound to the plan and exact target. It never issues an approval token; an ' +
        'authorized actor must explicitly approve or reject the request.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(
        () => service.requestApproval(args.planHash, args.note),
        (result) => `Approval request ${result.requestId} is pending for plan ${result.planHash}.`,
      ),
  );
}
