import { createDefaultApprovalStore, type ApprovalRepository } from '../policy/approvalStore.js';
import {
  createDefaultIdempotencyStore,
  type IdempotencyRepository,
} from '../policy/idempotencyStore.js';
import { createDefaultOperationStore } from '../policy/operationStore.js';
import type { OperationStore } from '../policy/operationStore.js';
import { createDefaultPlanStore, type PlanRepository } from '../policy/planStore.js';
import { PolicyEngine } from '../policy/policy.js';
import { loadPolicyConfig } from '../config/policyConfig.js';
import { FixtureAdapter } from '../adapters/fixture/fixtureAdapter.js';
import { CloudAdapter } from '../adapters/cloud/cloudAdapter.js';
import { createCloudRuntimeAdapter } from '../adapters/cloud/cloudRuntime.js';
import { WindowsAdapter } from '../adapters/windows/windowsAdapter.js';
import { createWindowsRuntimeAdapter } from '../adapters/windows/windowsRuntime.js';
import { OperationService } from './operationService.js';
import type { TargetAdapter } from '../adapters/targetAdapter.js';
import type { ActorContext, PlatformId } from '../domain/types.js';
import { LoggerOperationEventSink } from '../observability/operationEvents.js';
import type { CloudOAuthClientSecretProvider } from '../adapters/cloud/cloudOAuth.js';

/**
 * Builds the default, fully offline-runnable `OperationService` for this
 * process.
 *
 * `QLIK_HARNESS_TARGET_MODE` (default `"fixture"`) selects which adapter
 * backs the `cloud-dev`/`windows-dev` connection aliases:
 *  - `"fixture"` (default, safe/offline): both aliases are served by the
 *    single deterministic, in-memory `FixtureAdapter`, the only adapter
 *    whose mutation path can actually execute in this repository.
 *  - `"cloud"` / `"windows"`: wires in the real provider adapter for that
 *    platform. Its fail-closed runtime constructor still requires explicit
 *    routing, readiness, and secret injection before any provider call.
 *
 * The effective actor identity comes from environment configuration, never
 * from MCP tool input (see docs/09-security-operations-and-provider-adapters.md).
 */
export function resolveActorContext(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ActorContext {
  const actor = environment.QLIK_HARNESS_ACTOR?.trim() || 'local-dev-actor';
  const hostClientId = environment.QLIK_HARNESS_HOST_CLIENT_ID?.trim() || 'local-mcp-host';
  return { actor, hostClientId };
}

export interface BuildOperationServiceOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly actor?: ActorContext;
  readonly adapters?: Readonly<Partial<Record<PlatformId, TargetAdapter>>>;
  readonly approvals?: ApprovalRepository;
  readonly idempotency?: IdempotencyRepository;
  readonly plans?: PlanRepository;
  readonly operations?: OperationStore;
  readonly correlationId?: () => string | undefined;
  readonly cloudClientSecrets?: CloudOAuthClientSecretProvider;
}

export function buildDefaultAdapters(
  cloudClientSecrets?: CloudOAuthClientSecretProvider,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Partial<Record<PlatformId, TargetAdapter>>> {
  const configuredMode = environment.QLIK_HARNESS_TARGET_MODE?.trim().toLowerCase() || 'fixture';
  if (configuredMode !== 'fixture' && configuredMode !== 'cloud' && configuredMode !== 'windows') {
    throw new Error('QLIK_HARNESS_TARGET_MODE must be fixture, cloud, or windows.');
  }
  const mode = configuredMode;
  const fixtureAdapter = new FixtureAdapter();
  const cloudConnection = environment.QLIK_CLOUD_CONNECTION_ALIAS?.trim();
  const cloudAdapter =
    createCloudRuntimeAdapter(
      {
        QLIK_CLOUD_CONNECTION_ALIAS: environment.QLIK_CLOUD_CONNECTION_ALIAS,
        QLIK_CLOUD_TENANT_HOST: environment.QLIK_CLOUD_TENANT_HOST,
        QLIK_CLOUD_TENANT_ALIAS: environment.QLIK_CLOUD_TENANT_ALIAS,
        QLIK_CLOUD_REGION_ALIAS: environment.QLIK_CLOUD_REGION_ALIAS,
        QLIK_CLOUD_OAUTH_CLIENT_ID: environment.QLIK_CLOUD_OAUTH_CLIENT_ID,
        QLIK_CLOUD_ENVIRONMENT: environment.QLIK_CLOUD_ENVIRONMENT,
        QLIK_CLOUD_WRITE_APP_ID: environment.QLIK_CLOUD_WRITE_APP_ID,
        QLIK_CLOUD_WRITE_SHEET_ID: environment.QLIK_CLOUD_WRITE_SHEET_ID,
        QLIK_CLOUD_SHEET_CREATION_APP_IDS: environment.QLIK_CLOUD_SHEET_CREATION_APP_IDS,
        QLIK_CLOUD_READINESS_APPROVED: environment.QLIK_CLOUD_READINESS_APPROVED,
        QLIK_CLOUD_READINESS_EXPIRES_AT: environment.QLIK_CLOUD_READINESS_EXPIRES_AT,
        QLIK_CLOUD_READINESS_CAN_READ: environment.QLIK_CLOUD_READINESS_CAN_READ,
        QLIK_CLOUD_READINESS_CAN_PREVIEW: environment.QLIK_CLOUD_READINESS_CAN_PREVIEW,
        QLIK_CLOUD_READINESS_CAN_WRITE_DESIGNATED_SHEET:
          environment.QLIK_CLOUD_READINESS_CAN_WRITE_DESIGNATED_SHEET,
        QLIK_CLOUD_READINESS_CLEANUP_VERIFIED: environment.QLIK_CLOUD_READINESS_CLEANUP_VERIFIED,
      },
      {
        clientSecrets:
          cloudClientSecrets ??
          (async (connection) => {
            if (!cloudConnection || connection !== cloudConnection) {
              throw new Error('No OAuth client secret is configured for this Cloud connection.');
            }
            const secret = environment.QLIK_CLOUD_OAUTH_CLIENT_SECRET?.trim();
            if (!secret) {
              throw new Error('The Cloud OAuth client secret is unavailable.');
            }
            return secret;
          }),
      },
    ) ?? new CloudAdapter();
  const windowsAdapter =
    createWindowsRuntimeAdapter(
      {
        QLIK_WINDOWS_CONNECTION_ALIAS: environment.QLIK_WINDOWS_CONNECTION_ALIAS,
        QLIK_WINDOWS_SERVER_ALIAS: environment.QLIK_WINDOWS_SERVER_ALIAS,
        QLIK_WINDOWS_AUTH_MODE: environment.QLIK_WINDOWS_AUTH_MODE,
        QLIK_WINDOWS_VIRTUAL_PROXY_ALIAS: environment.QLIK_WINDOWS_VIRTUAL_PROXY_ALIAS,
        QLIK_WINDOWS_DISCOVERY_APP_ID: environment.QLIK_WINDOWS_DISCOVERY_APP_ID,
        QLIK_WINDOWS_WRITE_APP_ID: environment.QLIK_WINDOWS_WRITE_APP_ID,
        QLIK_WINDOWS_WRITE_SHEET_ID: environment.QLIK_WINDOWS_WRITE_SHEET_ID,
        QLIK_WINDOWS_READINESS_APPROVED: environment.QLIK_WINDOWS_READINESS_APPROVED,
        QLIK_WINDOWS_READINESS_EXPIRES_AT: environment.QLIK_WINDOWS_READINESS_EXPIRES_AT,
        QLIK_WINDOWS_READINESS_CAN_READ: environment.QLIK_WINDOWS_READINESS_CAN_READ,
        QLIK_WINDOWS_READINESS_CAN_PREVIEW: environment.QLIK_WINDOWS_READINESS_CAN_PREVIEW,
        QLIK_WINDOWS_READINESS_CAN_WRITE_DESIGNATED_SHEET:
          environment.QLIK_WINDOWS_READINESS_CAN_WRITE_DESIGNATED_SHEET,
        QLIK_WINDOWS_READINESS_CLEANUP_VERIFIED:
          environment.QLIK_WINDOWS_READINESS_CLEANUP_VERIFIED,
      },
      { secretEnvironment: environment },
    ) ?? new WindowsAdapter();

  return {
    fixture: fixtureAdapter,
    cloud: mode === 'cloud' ? cloudAdapter : fixtureAdapter,
    windows: mode === 'windows' ? windowsAdapter : fixtureAdapter,
  };
}

export function buildDefaultOperationService(
  options: BuildOperationServiceOptions = {},
): OperationService {
  const environment = options.environment ?? process.env;
  const actor = options.actor ?? resolveActorContext(environment);
  const policy = new PolicyEngine(loadPolicyConfig(environment));
  const adapters =
    options.adapters ?? buildDefaultAdapters(options.cloudClientSecrets, environment);

  return new OperationService({
    actor,
    adapters,
    policy,
    approvals: options.approvals ?? createDefaultApprovalStore(),
    idempotency: options.idempotency ?? createDefaultIdempotencyStore(),
    plans: options.plans ?? createDefaultPlanStore(),
    operations: options.operations ?? createDefaultOperationStore(),
    operationEvents: new LoggerOperationEventSink(),
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
  });
}
