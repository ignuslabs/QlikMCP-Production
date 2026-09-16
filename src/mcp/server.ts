import { registerSheetWorkflow } from './tools/sheetWorkflow.js';
import { McpServer } from '@modelcontextprotocol/server';
import { registerListApps } from './tools/listApps.js';
import { registerGetAppCatalog } from './tools/getAppCatalog.js';
import { registerListSheetObjects } from './tools/listSheetObjects.js';
import { registerPlanVisualization } from './tools/planVisualization.js';
import { registerPreviewVisualization } from './tools/previewVisualization.js';
import { registerRequestApproval } from './tools/requestApproval.js';
import { registerApprovalDecisionActions, registerApprovalLookup } from './tools/decideApproval.js';
import { registerApplyVisualization } from './tools/applyVisualization.js';
import { registerGetOperation } from './tools/getOperation.js';
import { registerGetReadiness } from './tools/getReadiness.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import type { OperationService } from '../server/operationService.js';
import type { ManagementContext } from '../management/context.js';
import { registerManagement } from './tools/management.js';

export const SERVER_NAME = 'qlik-ai-harness';
export const SERVER_VERSION = '0.4.1-rc.1';
export const SERVER_INSTRUCTIONS =
  'Workflow: call qlik_get_readiness; discover and plan; preview; request a separately authenticated reviewer; then apply only the unchanged approved plan. Scoped autonomous sheets: qlik_plan_sheet -> qlik_preview_sheet -> qlik_apply_sheet -> qlik_verify_sheet. Fail closed on scope, readiness, expiry or idempotency errors. Resume partial sheets only with the same key and returned nextAttempt. Never report partial results as success.';

export type McpToolProfile = 'all' | 'requester' | 'reviewer' | 'verifier';

export function serverInstructionsForProfile(profile: McpToolProfile): string {
  if (profile === 'requester') {
    return 'Requester: call qlik_get_readiness; discover; plan; preview; request approval, then stop for a separately authenticated reviewer. Apply only the approved plan. For explicitly scoped autonomous sheets use qlik_plan_sheet -> qlik_preview_sheet -> qlik_apply_sheet -> qlik_verify_sheet; resume partial work with the same key and nextAttempt. Never bypass policy or claim partial success.';
  }
  if (profile === 'reviewer') {
    return 'Reviewer workflow: start with qlik_get_visualization_approval to inspect the exact target, plan hash, chart type, title, resolved fields, risk, warnings, diff, status, and expiry. Wait for explicit human confirmation, then approve or reject. Never plan, preview, apply, use provider credentials, or decide a request made by the same actor.';
  }
  if (profile === 'verifier') {
    return 'Verifier workflow: call only qlik_get_visualization_approval. Report its sanitized target, plan hash, chart type, resolved fields, warnings, decision identity, status, and expiry. Treat missing, expired, rejected, or mismatched state as failed verification. Never approve, reject, plan, preview, apply, infer readiness, or claim successful application.';
  }
  return SERVER_INSTRUCTIONS;
}

export function parseMcpToolProfile(value: string | undefined): McpToolProfile {
  const profile = value?.trim() || 'all';
  if (
    profile === 'all' ||
    profile === 'requester' ||
    profile === 'reviewer' ||
    profile === 'verifier'
  ) {
    return profile;
  }
  throw new Error('QLIK_HARNESS_MCP_ROLE must be one of: all, requester, reviewer, verifier.');
}

/**
 * Builds the MCP facade over a provider-neutral `OperationService`. The
 * default profile registers exactly the 16 canonical tools; narrower local
 * roles expose subsets of those same tools. Every tool has a strict zod input
 * and output schema (see docs/08-mcp-server-contract.md). This module has no
 * knowledge of Qlik, policy, or persistence; it only translates between the
 * MCP wire contract and the core service.
 */
export function buildMcpServer(
  service: OperationService,
  toolProfile: McpToolProfile = 'all',
  management?: ManagementContext,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        serverInstructionsForProfile(toolProfile) +
        (management && (toolProfile === 'all' || toolProfile === 'requester')
          ? ' Management: discover exact authorized actions and schemas with qlik_management_catalog. Inspect with qlik_management_read. Stage datasets through qlik_upload_begin/chunk/finish, then plan immutable steps with qlik_management_plan and execute the same steps after any required separate review. New shared-space sheets are private to their creator; use explicit sheet.publish when the user wants permitted space members to see them. Use qlik_management_status and qlik_management_reconcile for uncertain outcomes; never create a replacement plan to retry an uncertain write. Reload submission is not completion: inspect terminal status and loaded model/chart values. Download private exports with qlik_artifact_chunk before expiry.'
          : management && toolProfile === 'reviewer'
            ? ' Management review: qlik_management_approve requires the requester owner, planId, and exact unchanged steps. Review the supplied changes and human authorization; same-actor approval is prohibited.'
            : ''),
    },
  );

  if (toolProfile === 'all' || toolProfile === 'requester') {
    registerListApps(server, service);
    registerGetAppCatalog(server, service);
    registerListSheetObjects(server, service);
    registerPlanVisualization(server, service);
    registerPreviewVisualization(server, service);
    registerRequestApproval(server, service);
    registerApplyVisualization(server, service);
    registerGetOperation(server, service);
    registerGetReadiness(server, service);
    registerSheetWorkflow(server, service);
  }
  if (toolProfile === 'all' || toolProfile === 'reviewer') {
    registerApprovalDecisionActions(server, service);
  }
  registerApprovalLookup(server, service);

  registerResources(server, service);
  registerPrompts(server);
  if (management) registerManagement(server, management, toolProfile);

  return server;
}
