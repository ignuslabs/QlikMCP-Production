import { createError } from '../domain/errors.js';
import type { ConnectionAllowlistEntry, PolicyConfig } from '../config/policyConfig.js';
import type { ChartTypeId, ConnectionAlias } from '../domain/types.js';

/**
 * Central policy engine: non-production connection/environment allowlisting
 * and default-deny mutation authorization. Every check here is re-run
 * immediately before a mutating adapter call, never trusted from an earlier
 * step or from client-supplied input (see docs/09-security-operations-and-provider-adapters.md).
 */
export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  listConnections(): readonly ConnectionAllowlistEntry[] {
    return Object.values(this.config.connections);
  }

  assertConnectionAllowed(connection: ConnectionAlias): ConnectionAllowlistEntry {
    const entry = this.config.connections[connection];
    if (!entry) {
      throw createError('NOT_FOUND', {
        message: `Connection "${connection}" is not a configured non-production connection.`,
        details: { connection },
      });
    }
    if (
      !this.config.allowedEnvironments.includes(entry.environment) ||
      entry.environment === 'production'
    ) {
      throw createError('PERMISSION_DENIED', {
        message: `Connection "${connection}" environment "${entry.environment}" is not a permitted non-production environment.`,
        details: { connection, environment: entry.environment },
      });
    }
    return entry;
  }

  /** Default-deny: an actor must be explicitly allowlisted to request approval or apply a mutation. */
  assertMutationActorAllowed(actor: string): void {
    if (!this.config.mutationActors.has(actor)) {
      throw createError('PERMISSION_DENIED', {
        message: `Actor "${actor}" is not authorized to request approval for or apply a mutation (default-deny policy).`,
        details: { actor },
      });
    }
  }

  /** Default-deny: only an independently authenticated reviewer may decide a request. */
  assertReviewerActorAllowed(actor: string): void {
    if (!this.config.reviewerActors.has(actor)) {
      throw createError('PERMISSION_DENIED', {
        message: `Actor "${actor}" is not authorized to review visualization requests (default-deny policy).`,
        details: { actor },
      });
    }
  }

  assertReviewerSeparated(requestingActor: string, reviewingActor: string): void {
    if (requestingActor === reviewingActor) {
      throw createError('PERMISSION_DENIED', {
        message: 'A visualization request must be decided by a different authenticated actor.',
      });
    }
  }

  /** Default-deny mutation scope, rechecked as one unit immediately before persistence. */
  assertMutationTargetAllowed(
    connection: ConnectionAlias,
    appId: string,
    sheetId: string,
    chartType: ChartTypeId,
  ): ConnectionAllowlistEntry {
    const entry = this.assertConnectionAllowed(connection);
    const sheets = entry.allowedApps[appId];
    if (!sheets || !sheets.includes(sheetId) || !entry.allowedChartTypes.includes(chartType)) {
      throw createError('PERMISSION_DENIED', {
        message: 'The requested app, sheet, or chart type is outside the mutation allowlist.',
        details: { connection, appId, sheetId, chartType },
      });
    }
    return entry;
  }

  /** Production discovery is limited to the actor/app scope of an explicit sheet grant. */
  assertReadAllowed(
    actor: string,
    connection: ConnectionAlias,
    appId?: string,
  ): ConnectionAllowlistEntry {
    const entry = this.config.connections[connection];
    if (entry?.environment !== 'production') return this.assertConnectionAllowed(connection);
    const grant = entry.sheetGeneration;
    if (
      !grant?.allowProduction ||
      !grant.actors.includes(actor) ||
      !grant.appIds.length ||
      (appId !== undefined && !grant.appIds.includes(appId))
    ) {
      throw createError('PERMISSION_DENIED', {
        message: 'Production discovery requires an explicit actor/app sheet-generation grant.',
      });
    }
    return entry;
  }

  /** A separate, explicit grant for creating new sheets; never authorizes editing existing sheets. */
  assertSheetGenerationAllowed(
    actor: string,
    connection: ConnectionAlias,
    appId: string,
    chartTypes: readonly ChartTypeId[],
  ): ConnectionAllowlistEntry {
    const entry = this.config.connections[connection];
    const grant = entry?.sheetGeneration;
    if (
      !entry ||
      !grant ||
      !grant.actors.includes(actor) ||
      !grant.appIds.includes(appId) ||
      chartTypes.length < 1 ||
      chartTypes.length > grant.maxCharts ||
      chartTypes.some((type) => !grant.chartTypes.includes(type)) ||
      (entry.environment === 'production'
        ? !grant.allowProduction
        : !this.config.allowedEnvironments.includes(entry.environment))
    ) {
      throw createError('PERMISSION_DENIED', {
        message:
          'New sheet generation requires an explicit server policy for this actor, connection, app, chart types and count.',
      });
    }
    return entry;
  }

  assertSheetWritable(writeAllowed: boolean, sheetId: string): void {
    if (!writeAllowed) {
      throw createError('PERMISSION_DENIED', {
        message: `Sheet "${sheetId}" is not designated as a writable development sheet.`,
        details: { sheetId },
      });
    }
  }
}
