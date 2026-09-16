import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  appIdSchema,
  chartTypeIdSchema,
  connectionSchema,
  riskClassSchema,
  sheetIdSchema,
} from '../schemas.js';
import { runTool } from '../toolHandler.js';
import type { OperationService } from '../../server/operationService.js';

const requestInput = z.object({ requestId: z.string().trim().min(1).max(200) }).strict();
const requestSummary = z
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
        filters: z.array(z.object({ field: z.string(), values: z.array(z.string()) }).strict()),
      })
      .strict(),
    riskClass: riskClassSchema,
    warnings: z.array(z.string()),
    diff: z
      .object({
        summary: z.string(),
        additions: z.array(z.string()),
        removals: z.array(z.string()),
      })
      .strict(),
    note: z.string().optional(),
    createdAt: z.string(),
    expiresAt: z.string(),
    status: z.enum(['pending', 'approved', 'rejected', 'expired']),
    decidedAt: z.string().optional(),
    decidedBy: z.string().optional(),
    rejectionReason: z.string().optional(),
  })
  .strict();
const approvalSummary = z
  .object({
    approvalToken: z.string(),
    planHash: z.string(),
    actor: z.string(),
    connection: connectionSchema,
    appId: appIdSchema,
    sheetId: sheetIdSchema,
    chartType: chartTypeIdSchema,
    resolvedSummary: z
      .object({ dimensions: z.array(z.string()), measures: z.array(z.string()) })
      .strict(),
    riskClass: riskClassSchema,
    warnings: z.array(z.string()),
    expiresAt: z.string(),
    singleUse: z.literal(true),
    status: z.literal('approved'),
  })
  .strict();

export function registerApprovalDecisionActions(
  server: McpServer,
  service: OperationService,
): void {
  server.registerTool(
    'qlik_approve_visualization_request',
    {
      title: 'Approve visualization request',
      description:
        'Explicitly approves a pending request and issues its plan-bound, target-bound, expiring token.',
      inputSchema: requestInput,
      outputSchema: approvalSummary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ requestId }) =>
      runTool(
        () => service.approveApproval(requestId),
        (result) => `Approval issued for plan ${result.planHash}; expires ${result.expiresAt}.`,
      ),
  );

  server.registerTool(
    'qlik_reject_visualization_request',
    {
      title: 'Reject visualization request',
      description: 'Explicitly rejects a pending request without issuing a token.',
      inputSchema: z
        .object({
          requestId: z.string().trim().min(1).max(200),
          reason: z.string().trim().max(500).optional(),
        })
        .strict(),
      outputSchema: requestSummary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ requestId, reason }) =>
      runTool(
        () => service.rejectApproval(requestId, reason),
        (result) => `Approval request ${result.requestId} was rejected.`,
      ),
  );
}

export function registerApprovalLookup(server: McpServer, service: OperationService): void {
  server.registerTool(
    'qlik_get_visualization_approval',
    {
      title: 'Get approval request',
      description: 'Returns sanitized request state; approval tokens are never returned by lookup.',
      inputSchema: requestInput,
      outputSchema: requestSummary,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ requestId }) =>
      runTool(
        async () => service.getApprovalRequest(requestId),
        (result) => `Approval request ${result.requestId}: ${result.status}.`,
      ),
  );
}

export function registerApprovalDecisions(server: McpServer, service: OperationService): void {
  registerApprovalDecisionActions(server, service);
  registerApprovalLookup(server, service);
}
