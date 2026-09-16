import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { renderDescriptorSchema } from '../schemas.js';
import { runTool } from '../toolHandler.js';
import type { OperationService } from '../../server/operationService.js';

const inputSchema = z
  .object({
    planHash: z.string().trim().min(1).max(200),
    approvalToken: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

const outputSchema = z
  .object({
    operationId: z.string(),
    planHash: z.string(),
    status: z.literal('verified'),
    objectId: z.string(),
    sheetAttachmentId: z.string(),
    verified: z.literal(true),
    render: renderDescriptorSchema,
    warnings: z.array(z.string()),
  })
  .strict();

export function registerApplyVisualization(server: McpServer, service: OperationService): void {
  server.registerTool(
    'qlik_apply_visualization',
    {
      title: 'Apply an approved chart plan',
      description:
        'Persists an approved chart plan to its permitted app/sheet after rechecking policy, target state, and ' +
        'write permission, then verifies the result. Requires a valid, unconsumed approval token and an ' +
        'idempotency key; a matching completed replay returns the original result without a new mutation, and a ' +
        'conflicting reuse of the same key fails without invoking the adapter.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(
        () => service.applyVisualization(args.planHash, args.approvalToken, args.idempotencyKey),
        (result) =>
          `Applied and verified: object ${result.objectId} attached as ${result.sheetAttachmentId}.`,
      ),
  );
}
