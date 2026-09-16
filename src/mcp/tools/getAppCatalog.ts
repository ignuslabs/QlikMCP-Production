import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  appIdSchema,
  catalogFieldSchema,
  chartSupportSchema,
  connectionSchema,
  masterItemSchema,
  sheetSummarySchema,
} from '../schemas.js';
import { runTool } from '../toolHandler.js';
import type { OperationService } from '../../server/operationService.js';

const inputSchema = z
  .object({
    connection: connectionSchema,
    appId: appIdSchema,
    catalogVariant: z.enum(['default', 'empty']).optional(),
    pageSize: z.number().int().min(1).max(50).optional(),
    pageToken: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const outputSchema = z
  .object({
    appId: appIdSchema,
    connection: connectionSchema,
    catalogId: z.string(),
    dimensions: z.array(catalogFieldSchema),
    measures: z.array(catalogFieldSchema),
    masterItems: z.array(masterItemSchema),
    sheets: z.array(sheetSummarySchema),
    chartTypes: z.array(chartSupportSchema),
    truncated: z.boolean(),
    nextPageToken: z.string().optional(),
  })
  .strict();

export function registerGetAppCatalog(server: McpServer, service: OperationService): void {
  server.registerTool(
    'qlik_get_app_catalog',
    {
      title: 'Get bounded Qlik app catalog',
      description:
        'Returns bounded, policy-visible fields, master items, sheets, and supported native chart types for an app. ' +
        'Excludes load scripts, data connections, security rules, and sensitive/hidden metadata. Read-only.',
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
          service.getAppCatalog(args.connection, args.appId, args.catalogVariant ?? 'default', {
            pageSize: args.pageSize,
            pageToken: args.pageToken,
          }),
        (result) =>
          `Catalog "${result.catalogId}" for app "${result.appId}": ${result.dimensions.length} dimension(s), ` +
          `${result.measures.length} measure(s), ${result.masterItems.length} master item(s), ${result.sheets.length} sheet(s).`,
      ),
  );
}
