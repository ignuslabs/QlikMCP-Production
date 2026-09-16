import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { chartIntentSchema } from '../../compiler/chartIntentSchema.js';
import {
  appIdSchema,
  chartTypeIdSchema,
  compactDiffSchema,
  connectionSchema,
  nativeChartTypeSchema,
  platformSchema,
  resolvedFieldRefSchema,
  resolvedFilterRefSchema,
  resolvedMeasureRefSchema,
  riskClassSchema,
  sheetIdSchema,
} from '../schemas.js';
import { runTool } from '../toolHandler.js';
import type { OperationService } from '../../server/operationService.js';

const inputSchema = z
  .object({
    connection: connectionSchema,
    appId: appIdSchema,
    sheetId: sheetIdSchema.optional(),
    intent: chartIntentSchema,
  })
  .strict();

const outputSchema = z
  .object({
    operationId: z.string(),
    planHash: z.string(),
    compilerVersion: z.string(),
    target: z
      .object({ connection: connectionSchema, appId: appIdSchema, sheetId: sheetIdSchema })
      .strict(),
    platform: platformSchema,
    chartType: chartTypeIdSchema,
    nativeChartType: nativeChartTypeSchema,
    resolved: z
      .object({
        dimensions: z.array(resolvedFieldRefSchema),
        measures: z.array(resolvedMeasureRefSchema),
        filters: z.array(resolvedFilterRefSchema),
      })
      .strict(),
    title: z.string(),
    riskClass: riskClassSchema,
    warnings: z.array(z.string()),
    diff: compactDiffSchema,
    previewEligible: z.boolean(),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .strict();

export function registerPlanVisualization(server: McpServer, service: OperationService): void {
  server.registerTool(
    'qlik_plan_visualization',
    {
      title: 'Plan a native Qlik visualization',
      description:
        'Resolves a constrained ChartIntent deterministically into a reviewable, server-stored chart plan ' +
        '(plan hash, resolved references, risk, warnings, compact diff). Creates no Qlik object. Read-only.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(
        () => service.planVisualization(args.connection, args.appId, args.sheetId, args.intent),
        (result) =>
          `Plan ${result.planHash} ready: ${result.chartType} chart "${result.title}" (risk: ${result.riskClass}).`,
      ),
  );
}
