import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  appIdSchema,
  connectionSchema,
  sheetIdSchema,
  sheetObjectSummarySchema,
} from '../schemas.js';
import { runTool } from '../toolHandler.js';
import type { OperationService } from '../../server/operationService.js';

const inputSchema = z
  .object({
    connection: connectionSchema,
    appId: appIdSchema,
    sheetId: sheetIdSchema,
    pageSize: z.number().int().min(1).max(50).optional(),
    pageToken: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const outputSchema = z
  .object({
    objects: z.array(sheetObjectSummarySchema),
    truncated: z.boolean(),
    nextPageToken: z.string().optional(),
  })
  .strict();

export function registerListSheetObjects(server: McpServer, service: OperationService): void {
  server.registerTool(
    'qlik_list_sheet_objects',
    {
      title: 'List existing native objects on a sheet',
      description:
        'Lists existing native Qlik objects on an authorized, policy-allowed sheet. Read-only.',
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
          service.listSheetObjects(args.connection, args.appId, args.sheetId, {
            pageSize: args.pageSize,
            pageToken: args.pageToken,
          }),
        (result) =>
          `Sheet "${args.sheetId}" has ${result.objects.length} existing native object(s).`,
      ),
  );
}
