import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { appSummarySchema, connectionSchema } from '../schemas.js';
import { runTool } from '../toolHandler.js';
import type { OperationService } from '../../server/operationService.js';

const inputSchema = z
  .object({
    connection: connectionSchema,
    pageSize: z.number().int().min(1).max(50).optional(),
    pageToken: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const outputSchema = z
  .object({
    apps: z.array(appSummarySchema),
    truncated: z.boolean(),
    nextPageToken: z.string().optional(),
  })
  .strict();

export function registerListApps(server: McpServer, service: OperationService): void {
  server.registerTool(
    'qlik_list_apps',
    {
      title: 'List accessible Qlik apps',
      description:
        'Lists policy-allowed, caller-authorized Qlik apps for a named non-production connection alias. Read-only.',
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
        () =>
          service.listApps(args.connection, { pageSize: args.pageSize, pageToken: args.pageToken }),
        (result) =>
          `Found ${result.apps.length} accessible app(s) for connection "${args.connection}".`,
      ),
  );
}
