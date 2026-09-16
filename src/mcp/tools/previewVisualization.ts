import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { renderDescriptorSchema } from '../schemas.js';
import { runTool } from '../toolHandler.js';
import type { OperationService } from '../../server/operationService.js';

const inputSchema = z
  .object({
    planHash: z.string().trim().min(1).max(200),
  })
  .strict();

const outputSchema = z
  .object({
    operationId: z.string(),
    planHash: z.string(),
    status: z.literal('previewed'),
    preview: z
      .object({
        dimensionLabels: z.array(z.string()),
        measureLabels: z.array(z.string()),
        rows: z.array(z.array(z.union([z.string(), z.number()]))),
        returnedRows: z.number().int().min(0),
        maxRows: z.number().int().min(1),
        truncated: z.boolean(),
        continuation: z.string().optional(),
      })
      .strict(),
    render: renderDescriptorSchema,
    warnings: z.array(z.string()),
  })
  .strict();

export function registerPreviewVisualization(server: McpServer, service: OperationService): void {
  server.registerTool(
    'qlik_preview_visualization',
    {
      title: 'Preview a native Qlik visualization',
      description:
        'Creates a disposable native session object for a stored plan, evaluates a bounded layout/data sample, ' +
        'and disposes the session object even on error. Creates no persistent Qlik object.',
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
        () => service.previewVisualization(args.planHash),
        (result) =>
          `Preview ready: ${result.preview.returnedRows} row(s) (truncated: ${result.preview.truncated}).`,
      ),
  );
}
