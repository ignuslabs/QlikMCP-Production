import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Suggested approved workflow prompts (see docs/08-mcp-server-contract.md).
 * Prompts guide a host/model through the safe tool sequence; they never
 * authorize a mutation themselves. Single-chart writes require independent
 * approval; autonomous new sheets require the configured actor/app grant.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'create_verified_sheet',
    {
      title: 'Create and verify a complete Qlik sheet',
      description:
        'Guides the complete scoped sheet workflow, including catalog discovery, temporary previews, persistent creation, fresh verification and partial-result recovery.',
      argsSchema: z.object({ analysisGoal: z.string().trim().min(1).max(500) }),
    },
    ({ analysisGoal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Sheet analysis goal: ${analysisGoal}\n\n` +
              '1. Call qlik_get_readiness, qlik_list_apps and qlik_get_app_catalog. Use the intended app and returned field labels, master items and supported chart types.\n' +
              '2. Call qlik_plan_sheet with the connection, appId, a clear title and 1-12 constrained ChartIntent objects. Inspect the returned manifest, titles, layout, plan hash and expiry. A server-side actor/app/chart/count grant is required; stop if it is absent.\n' +
              '3. Call qlik_preview_sheet with that plan hash. Confirm every chart passed its bounded data and shape checks and temporary objects were disposed.\n' +
              '4. Call qlik_apply_sheet with the unchanged plan hash, a stable idempotencyKey and attempt 0. The configured grant permits this autonomous path; the server rechecks scope, readiness and preview evidence.\n' +
              '5. Call qlik_verify_sheet for fresh readback, then qlik_list_sheet_objects on the returned sheet and qlik_get_operation for its audit details. Report creation as verified only if every chart and the sheet passed; browser appearance and live performance need separate evidence.\n' +
              '6. For a known partial result, retain the same plan hash and key and use only the returned nextAttempt. If the outcome is uncertain or in progress, inspect verification and stop for reconciliation. Never invent a retry attempt or replace an existing user sheet.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'design_native_chart',
    {
      title: 'Design a native Qlik chart',
      description:
        'Guides discovery, catalog lookup, and deterministic planning for a new native Qlik chart.',
      argsSchema: z.object({ analysisGoal: z.string().trim().min(1).max(500) }),
    },
    ({ analysisGoal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Analysis goal: ${analysisGoal}\n\n` +
              '1. Call qlik_list_apps to find an authorized, non-production app.\n' +
              '2. Call qlik_get_app_catalog to see permitted fields, master items, sheets, and chart types.\n' +
              '3. Call qlik_plan_visualization with a ChartIntent built only from labels present in that catalog.\n' +
              '4. Review the returned plan hash, resolved references, risk, and warnings before doing anything else.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'review_chart_plan',
    {
      title: 'Review a chart plan before approval',
      description:
        'Guides preview and human review of a stored chart plan prior to requesting approval.',
      argsSchema: z.object({ planHash: z.string().trim().min(1).max(200) }),
    },
    ({ planHash }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Plan hash: ${planHash}\n\n` +
              '1. Call qlik_preview_visualization with this plan hash and inspect the bounded preview rows.\n' +
              '2. Confirm the chart type, resolved dimensions/measures, risk class, and warnings are correct.\n' +
              '3. Only call qlik_request_visualization_approval if the preview and plan are exactly what was intended.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'explain_chart_result',
    {
      title: 'Explain a chart operation result',
      description: 'Guides looking up and explaining the sanitized status of a chart operation.',
      argsSchema: z.object({ operationId: z.string().trim().min(1).max(200) }),
    },
    ({ operationId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Operation ID: ${operationId}\n\n` +
              'Call qlik_get_operation with this ID and explain its status, target, and any warnings in plain ' +
              'language. Never invent a status or object ID that the tool did not return.',
          },
        },
      ],
    }),
  );
}
