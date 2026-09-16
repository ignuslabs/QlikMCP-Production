import { createError } from '../domain/errors.js';
import type { CapabilityProbeResult, TargetAdapter } from './targetAdapter.js';
import type { ChartTypeId, ConnectionAlias } from '../domain/types.js';
import type { PolicyEngine } from '../policy/policy.js';

/**
 * Runtime capability probe (see docs/02-platform-support-matrix.md,
 * "Required Runtime Probe"). Tool schemas remain stable, while target-scoped
 * advertisement and call-time enforcement are both derived from the adapter's
 * current capability result below.
 */
export async function probeCapabilities(
  adapter: TargetAdapter,
  connection: ConnectionAlias,
): Promise<CapabilityProbeResult> {
  return adapter.getEnvironmentCapabilities(connection);
}

export type HarnessToolCapability =
  | 'service'
  | 'discovery'
  | 'planning'
  | 'preview'
  | 'approval'
  | 'create'
  | 'sheet-planning'
  | 'sheet-preview'
  | 'sheet-create'
  | 'sheet-verify';

export const TOOL_CAPABILITY = {
  qlik_list_apps: 'discovery',
  qlik_get_app_catalog: 'discovery',
  qlik_list_sheet_objects: 'discovery',
  qlik_plan_visualization: 'planning',
  qlik_preview_visualization: 'preview',
  qlik_request_visualization_approval: 'approval',
  qlik_approve_visualization_request: 'service',
  qlik_reject_visualization_request: 'service',
  qlik_get_visualization_approval: 'service',
  qlik_apply_visualization: 'create',
  qlik_get_operation: 'service',
  qlik_get_readiness: 'service',
  qlik_plan_sheet: 'sheet-planning',
  qlik_preview_sheet: 'sheet-preview',
  qlik_apply_sheet: 'sheet-create',
  qlik_verify_sheet: 'sheet-verify',
} as const satisfies Readonly<Record<string, HarnessToolCapability>>;

export type HarnessToolName = keyof typeof TOOL_CAPABILITY;

/** Optional caller-specific scope; omitted contexts never advertise autonomous sheet tools. */
export interface SheetToolAvailabilityContext {
  readonly policy: PolicyEngine;
  readonly adapter: TargetAdapter;
  readonly actor: string;
  readonly appId: string;
  readonly chartTypes: readonly ChartTypeId[];
}

function sheetScopeAllowed(
  capabilities: CapabilityProbeResult,
  context: SheetToolAvailabilityContext | undefined,
): boolean {
  if (
    !context?.adapter.ensureSheet ||
    !context.adapter.verifySheet ||
    context.adapter.canCreateSheetsInApp?.(capabilities.connection, context.appId) !== true
  )
    return false;
  try {
    const entry = context.policy.assertSheetGenerationAllowed(
      context.actor,
      capabilities.connection,
      context.appId,
      context.chartTypes,
    );
    return entry.platform === capabilities.platform;
  } catch {
    return false;
  }
}

/** Single source of truth used by MCP hosts when deciding which target-scoped tools to advertise. */
export function availableToolCapabilities(
  capabilities: CapabilityProbeResult,
  sheetContext?: SheetToolAvailabilityContext,
): ReadonlySet<HarnessToolCapability> {
  const available = new Set<HarnessToolCapability>(['service']);
  if (capabilities.canRead) {
    available.add('discovery');
    available.add('planning');
  }
  if (capabilities.canPreview) available.add('preview');
  if (
    capabilities.configured &&
    capabilities.canWriteDesignatedSheet &&
    capabilities.cleanupVerified
  ) {
    available.add('approval');
    available.add('create');
  }
  if (sheetScopeAllowed(capabilities, sheetContext) && capabilities.canRead) {
    available.add('sheet-planning');
    available.add('sheet-verify');
    if (capabilities.canPreview) available.add('sheet-preview');
    if (
      capabilities.configured &&
      capabilities.canWriteDesignatedSheet &&
      capabilities.cleanupVerified
    )
      available.add('sheet-create');
  }
  return available;
}

export async function probeToolAvailability(adapter: TargetAdapter, connection: ConnectionAlias) {
  return availableToolCapabilities(await probeCapabilities(adapter, connection));
}

/** Returns the concrete MCP tool names a host may expose for this target. */
export function availableTools(
  capabilities: CapabilityProbeResult,
  sheetContext?: SheetToolAvailabilityContext,
): readonly HarnessToolName[] {
  const available = availableToolCapabilities(capabilities, sheetContext);
  return (Object.keys(TOOL_CAPABILITY) as HarnessToolName[]).filter((tool) =>
    available.has(TOOL_CAPABILITY[tool]),
  );
}

export async function assertReadCapability(
  adapter: TargetAdapter,
  connection: ConnectionAlias,
): Promise<CapabilityProbeResult> {
  const capabilities = await probeCapabilities(adapter, connection);
  if (!capabilities.canRead) {
    throw createError('NOT_CONFIGURED', { message: capabilities.reason, details: { connection } });
  }
  return capabilities;
}

export async function assertPreviewCapability(
  adapter: TargetAdapter,
  connection: ConnectionAlias,
): Promise<CapabilityProbeResult> {
  const capabilities = await probeCapabilities(adapter, connection);
  if (!capabilities.canPreview) {
    throw createError('NOT_CONFIGURED', { message: capabilities.reason, details: { connection } });
  }
  return capabilities;
}

export async function assertMutationCapability(
  adapter: TargetAdapter,
  connection: ConnectionAlias,
): Promise<CapabilityProbeResult> {
  const capabilities = await probeCapabilities(adapter, connection);
  if (!capabilities.configured) {
    throw createError('NOT_CONFIGURED', { message: capabilities.reason, details: { connection } });
  }
  if (!capabilities.canWriteDesignatedSheet) {
    throw createError('PERMISSION_DENIED', {
      message:
        'The target capability probe has not proven designated-sheet write access for this connection.',
      details: { connection },
    });
  }
  if (!capabilities.cleanupVerified) {
    throw createError('PERMISSION_DENIED', {
      message: 'Mutation tools stay unavailable until cleanup has been proven for this connection.',
      details: { connection },
    });
  }
  return capabilities;
}
