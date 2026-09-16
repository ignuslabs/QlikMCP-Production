import { createError, isHarnessError } from '../../domain/errors.js';
import type { TypedFailureCode } from '../../domain/errors.js';
import type {
  AttachChartRequest,
  AttachChartResult,
  CapabilityProbeResult,
  CatalogResult,
  CompilationContext,
  CleanupRequest,
  CleanupResult,
  CreateSessionChartRequest,
  CreateSessionChartResult,
  ListAppsResult,
  ListSheetObjectsResult,
  PageRequest,
  PersistChartRequest,
  PersistChartResult,
  TargetAdapter,
  VerifyChartRequest,
  VerifyChartResult,
} from '../targetAdapter.js';
import type {
  ActorContext,
  ConnectionAlias,
  PlatformId,
  RenderDescriptor,
  TargetRef,
} from '../../domain/types.js';
import type { CatalogVariant } from '../../catalog/catalogTypes.js';

/** Non-secret routing configuration. Credential material deliberately cannot be configured here. */
export interface WindowsAdapterConfig {
  readonly connection?: ConnectionAlias;
  readonly serverAlias?: string;
  readonly virtualProxyAlias?: string;
  readonly authMode?: 'proxy-session' | 'trusted-backend';
  /** App used only to obtain a QIX Global handle for GetDocList discovery. */
  readonly discoveryAppId?: string;
  /** The only persistent target authorized by the platform-admin readiness record. */
  readonly writeTarget?: WindowsWriteTarget;
  readonly readiness?: WindowsReadinessEvidence;
}

export interface WindowsWriteTarget {
  readonly connection: ConnectionAlias;
  readonly appId: string;
  readonly sheetId: string;
}

/** Platform-admin-owned, non-secret result of the readiness runbook. */
export interface WindowsReadinessEvidence {
  readonly approved: boolean;
  readonly expiresAt: string;
  readonly canRead: boolean;
  readonly canPreview: boolean;
  readonly canWriteDesignatedSheet: boolean;
  readonly cleanupVerified: boolean;
}

/** Opaque credentials are obtained for each connection attempt and are never logged or returned. */
export type WindowsSecret =
  | {
      readonly authMode: 'proxy-session';
      /** Short-lived JWT exchanged by `@qlik/api` for the proxy session cookie. */
      readonly accessToken: string;
    }
  | {
      readonly authMode: 'trusted-backend';
      /** Binary PKCS#12/PFX client identity, decoded from the injected secret value. */
      readonly pfx: Uint8Array;
      readonly passphrase?: string;
      readonly userHeader: string;
    };

export interface WindowsSecretProvider {
  get(
    connection: ConnectionAlias,
    authMode: NonNullable<WindowsAdapterConfig['authMode']>,
  ): Promise<WindowsSecret>;
}

export interface WindowsEngineSession {
  listAccessibleApps(actor: ActorContext, page?: PageRequest): Promise<ListAppsResult>;
  getCompilationContext(
    appId: string,
    actor: ActorContext,
    variant?: CatalogVariant,
  ): Promise<CompilationContext>;
  getSemanticCatalog(
    appId: string,
    actor: ActorContext,
    variant?: CatalogVariant,
    page?: PageRequest,
  ): Promise<CatalogResult>;
  listSheetObjects(
    appId: string,
    sheetId: string,
    actor: ActorContext,
    page?: PageRequest,
  ): Promise<ListSheetObjectsResult>;
  createSessionChart(request: CreateSessionChartRequest): Promise<CreateSessionChartResult>;
  disposeSessionChart(sessionObjectId: string): Promise<void>;
  persistChart(request: PersistChartRequest): Promise<PersistChartResult>;
  attachChartToSheet(request: AttachChartRequest): Promise<AttachChartResult>;
  verifyChart(request: VerifyChartRequest): Promise<VerifyChartResult>;
  cleanupObject(request: CleanupRequest): Promise<CleanupResult>;
  close(): Promise<void>;
}

export interface WindowsEngineSessionFactory {
  open(options: {
    readonly connection: ConnectionAlias;
    readonly serverAlias: string;
    readonly virtualProxyAlias?: string;
    readonly discoveryAppId?: string;
    readonly writeTarget?: WindowsWriteTarget;
    readonly authMode: NonNullable<WindowsAdapterConfig['authMode']>;
    readonly secret: WindowsSecret;
  }): Promise<WindowsEngineSession>;
}

export interface WindowsAdapterDependencies {
  readonly secrets: WindowsSecretProvider;
  readonly sessions: WindowsEngineSessionFactory;
  readonly now?: () => Date;
}

const QIX_PERMISSION_CODES = new Set([5, 401, 403, 22007, 22016, 4203, 4230]);
const QIX_NOT_FOUND_CODES = new Set([2, 404, 1003, 2001, 3003, 19004, 22005, 4204]);
const QIX_CAPACITY_CODES = new Set([6, 19, 22, 22008, 4240]);
const QIX_MALFORMED_CODES = new Set([-32700, -32602, -32600, 8, 9, 400, 422, 22003, 4202]);

function numericErrorCode(candidate: Record<string, unknown>): number | undefined {
  if (typeof candidate.code === 'number') return candidate.code;
  const original = candidate.original;
  if (original && typeof original === 'object') {
    const code = (original as Record<string, unknown>).code;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

function httpStatus(candidate: Record<string, unknown>): number | undefined {
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  const errors = candidate.errors;
  if (Array.isArray(errors)) {
    const status = errors.find((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === 'object'),
    )?.status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

export function mapWindowsError(error: unknown): never {
  if (isHarnessError(error)) throw error;
  const candidate = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  const numberCode = numericErrorCode(candidate);
  const status = httpStatus(candidate) ?? 0;
  const name = typeof candidate.name === 'string' ? candidate.name.toUpperCase() : '';
  let mapped: TypedFailureCode = 'TRANSIENT_UNAVAILABLE';
  if (
    candidate.isCancelled === true ||
    numberCode === 15 ||
    numberCode === 22001 ||
    name === 'ABORTERROR' ||
    code.includes('CANCEL')
  )
    mapped = 'OPERATION_CANCELLED';
  else if (
    status === 401 ||
    status === 403 ||
    (numberCode !== undefined && QIX_PERMISSION_CODES.has(numberCode)) ||
    code.includes('ACCESS') ||
    code.includes('AUTH') ||
    code.includes('PERMISSION') ||
    name.includes('AUTHORIZATION')
  )
    mapped = 'PERMISSION_DENIED';
  else if (
    status === 404 ||
    (numberCode !== undefined && QIX_NOT_FOUND_CODES.has(numberCode)) ||
    code.includes('NOT_FOUND')
  )
    mapped = 'NOT_FOUND';
  else if (status === 429 || numberCode === 429 || numberCode === 4205 || code.includes('RATE'))
    mapped = 'RATE_LIMITED';
  else if (
    (numberCode !== undefined && QIX_CAPACITY_CODES.has(numberCode)) ||
    code.includes('CAPACITY')
  )
    mapped = 'CAPACITY_EXHAUSTED';
  else if (
    (numberCode !== undefined && QIX_MALFORMED_CODES.has(numberCode)) ||
    code.includes('MALFORMED') ||
    code.includes('INVALID_ARGUMENT') ||
    (status >= 400 && status < 500)
  )
    mapped = 'MALFORMED_REQUEST';
  throw createError(mapped, {
    message: 'The Windows target operation failed; sensitive transport details were removed.',
  });
}

/**
 * Creates the real Windows adapter. Dependencies are mandatory so a target can never silently
 * fall back to environment credentials or an unapproved socket implementation.
 */
export function createWindowsAdapter(
  config: WindowsAdapterConfig,
  dependencies: WindowsAdapterDependencies,
): WindowsAdapter {
  return new WindowsAdapter(config, dependencies);
}

export class WindowsAdapter implements TargetAdapter {
  readonly platform: PlatformId = 'windows';
  private readonly now: () => Date;
  private readonly sessionObjectOwners = new Map<
    string,
    {
      readonly connection: ConnectionAlias;
      readonly sessionObjectId: string;
      readonly session: WindowsEngineSession;
    }
  >();

  constructor(
    private readonly config: WindowsAdapterConfig = {},
    private readonly dependencies?: WindowsAdapterDependencies,
  ) {
    this.now = dependencies?.now ?? (() => new Date());
  }

  private readiness(
    connection: ConnectionAlias,
    allowExpiredForCleanup = false,
  ): WindowsReadinessEvidence | undefined {
    const evidence = this.config.readiness;
    if (this.config.connection !== connection) return undefined;
    const expiresAt = evidence ? Date.parse(evidence.expiresAt) : Number.NaN;
    if (
      !evidence?.approved ||
      !Number.isFinite(expiresAt) ||
      (!allowExpiredForCleanup && expiresAt <= this.now().getTime())
    )
      return undefined;
    if (!this.config.serverAlias || !this.config.authMode || !this.dependencies) return undefined;
    return evidence;
  }

  private requireCapability(
    connection: ConnectionAlias,
    capability: 'read' | 'preview' | 'write' | 'cleanup',
  ): WindowsReadinessEvidence {
    // Cleanup is a compensating action for an object that may already exist. Keep an explicitly
    // approved and cleanup-verified target usable after evidence expiry so rollback cannot be
    // stranded if the readiness window closes between apply and cleanup.
    const readiness = this.readiness(connection, capability === 'cleanup');
    if (!readiness) {
      throw createError('NOT_CONFIGURED', {
        message: 'The Windows target has no current, approved readiness evidence.',
      });
    }
    const allowed =
      capability === 'read'
        ? readiness.canRead
        : capability === 'preview'
          ? readiness.canPreview
          : capability === 'write'
            ? readiness.canWriteDesignatedSheet
            : readiness.cleanupVerified;
    if (!allowed) {
      throw createError('PERMISSION_DENIED', {
        message: `The Windows readiness record does not authorize ${capability} operations.`,
      });
    }
    return readiness;
  }

  private assertDesignatedTarget(target: Required<TargetRef>): void {
    const allowed = this.config.writeTarget;
    if (
      !allowed ||
      target.connection !== allowed.connection ||
      target.appId !== allowed.appId ||
      target.sheetId !== allowed.sheetId
    ) {
      throw createError('PERMISSION_DENIED', {
        message: 'Windows mutation is restricted to the approved designated test sheet.',
      });
    }
  }

  private ownerKey(connection: ConnectionAlias, sessionObjectId: string): string {
    return `${connection}\u0000${sessionObjectId}`;
  }

  private async withSession<T>(
    connection: ConnectionAlias,
    capability: 'read' | 'write' | 'cleanup',
    fn: (session: WindowsEngineSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.openSession(connection, capability);
    try {
      return await fn(session);
    } catch (error) {
      return mapWindowsError(error);
    } finally {
      await this.closeSession(session);
    }
  }

  private async openSession(
    connection: ConnectionAlias,
    capability: 'read' | 'preview' | 'write' | 'cleanup',
  ): Promise<WindowsEngineSession> {
    this.requireCapability(connection, capability);
    if (!this.dependencies || !this.config.serverAlias || !this.config.authMode) {
      throw createError('NOT_CONFIGURED', {
        message: 'The Windows target has no current, approved readiness evidence.',
      });
    }
    try {
      const secret = await this.dependencies.secrets.get(connection, this.config.authMode);
      return await this.dependencies.sessions.open({
        connection,
        serverAlias: this.config.serverAlias,
        ...(this.config.virtualProxyAlias
          ? { virtualProxyAlias: this.config.virtualProxyAlias }
          : {}),
        ...(this.config.discoveryAppId ? { discoveryAppId: this.config.discoveryAppId } : {}),
        ...(this.config.writeTarget ? { writeTarget: this.config.writeTarget } : {}),
        authMode: this.config.authMode,
        secret,
      });
    } catch (error) {
      return mapWindowsError(error);
    }
  }

  private async closeSession(session: WindowsEngineSession): Promise<void> {
    try {
      await session.close();
    } catch {
      /* close failures contain transport data and are intentionally suppressed */
    }
  }

  async getEnvironmentCapabilities(connection: ConnectionAlias): Promise<CapabilityProbeResult> {
    const readiness = this.readiness(connection);
    const hasWriteTarget = this.config.writeTarget?.connection === connection;
    return readiness
      ? {
          platform: 'windows',
          connection,
          configured: true,
          canRead: readiness.canRead,
          canPreview: readiness.canPreview,
          canWriteDesignatedSheet: readiness.canWriteDesignatedSheet && hasWriteTarget,
          cleanupVerified: readiness.cleanupVerified && hasWriteTarget,
          reason: 'Current platform-admin readiness evidence is approved.',
        }
      : {
          platform: 'windows',
          connection,
          configured: false,
          canRead: false,
          canPreview: false,
          canWriteDesignatedSheet: false,
          cleanupVerified: false,
          reason: 'No current platform-admin certificate/proxy readiness evidence is configured.',
        };
  }

  listAccessibleApps(connection: ConnectionAlias, actor: ActorContext, page?: PageRequest) {
    return this.withSession(connection, 'read', (s) => s.listAccessibleApps(actor, page));
  }
  getCompilationContext(
    connection: ConnectionAlias,
    appId: string,
    actor: ActorContext,
    variant?: CatalogVariant,
  ) {
    return this.withSession(connection, 'read', (s) =>
      s.getCompilationContext(appId, actor, variant),
    );
  }
  getSemanticCatalog(
    connection: ConnectionAlias,
    appId: string,
    actor: ActorContext,
    variant?: CatalogVariant,
    page?: PageRequest,
  ) {
    return this.withSession(connection, 'read', (s) =>
      s.getSemanticCatalog(appId, actor, variant, page),
    );
  }
  listSheetObjects(
    connection: ConnectionAlias,
    appId: string,
    sheetId: string,
    actor: ActorContext,
    page?: PageRequest,
  ) {
    return this.withSession(connection, 'read', (s) =>
      s.listSheetObjects(appId, sheetId, actor, page),
    );
  }
  async createSessionChart(request: CreateSessionChartRequest): Promise<CreateSessionChartResult> {
    const connection = request.target.connection;
    const session = await this.openSession(connection, 'preview');
    let retained = false;
    try {
      const result = await session.createSessionChart(request);
      const ownerKey = this.ownerKey(connection, result.sessionObjectId);
      const previous = this.sessionObjectOwners.get(ownerKey);
      if (previous) {
        throw createError('TRANSIENT_UNAVAILABLE', {
          message: 'The Windows Engine returned a duplicate session-object identifier.',
        });
      }
      this.sessionObjectOwners.set(ownerKey, {
        connection,
        sessionObjectId: result.sessionObjectId,
        session,
      });
      retained = true;
      return result;
    } catch (error) {
      if (!retained) await this.closeSession(session);
      return mapWindowsError(error);
    }
  }

  async disposeSessionChart(connection: ConnectionAlias, sessionObjectId: string): Promise<void> {
    const ownerKey = this.ownerKey(connection, sessionObjectId);
    const owner = this.sessionObjectOwners.get(ownerKey);
    if (!owner) {
      const belongsToAnotherConnection = [...this.sessionObjectOwners.values()].some(
        (candidate) => candidate.sessionObjectId === sessionObjectId,
      );
      if (!belongsToAnotherConnection) return;
      throw createError('PERMISSION_DENIED', {
        message: 'The session object does not belong to the requested Windows connection.',
      });
    }
    this.sessionObjectOwners.delete(ownerKey);
    let failure: unknown;
    try {
      await owner.session.disposeSessionChart(sessionObjectId);
    } catch (error) {
      failure = error;
    } finally {
      await this.closeSession(owner.session);
    }
    if (failure) mapWindowsError(failure);
  }
  async persistChart(request: PersistChartRequest): Promise<PersistChartResult> {
    this.requireCapability(request.target.connection, 'write');
    this.assertDesignatedTarget(request.target);
    return await this.withSession(request.target.connection, 'write', (s) =>
      s.persistChart(request),
    );
  }
  async attachChartToSheet(request: AttachChartRequest): Promise<AttachChartResult> {
    this.requireCapability(request.target.connection, 'write');
    this.assertDesignatedTarget(request.target);
    return await this.withSession(request.target.connection, 'write', (s) =>
      s.attachChartToSheet(request),
    );
  }
  async verifyChart(request: VerifyChartRequest): Promise<VerifyChartResult> {
    this.requireCapability(request.target.connection, 'write');
    this.assertDesignatedTarget(request.target);
    return await this.withSession(request.target.connection, 'write', (s) =>
      s.verifyChart(request),
    );
  }
  async cleanupObject(request: CleanupRequest): Promise<CleanupResult> {
    this.requireCapability(request.target.connection, 'cleanup');
    this.assertDesignatedTarget(request.target);
    return await this.withSession(request.target.connection, 'cleanup', (s) =>
      s.cleanupObject(request),
    );
  }

  renderDescriptor(
    target: Required<TargetRef>,
    objectId: string,
    operationId: string,
    mode: 'preview' | 'persisted',
  ): RenderDescriptor {
    this.requireCapability(target.connection, mode === 'preview' ? 'preview' : 'write');
    if (mode === 'persisted') this.assertDesignatedTarget(target);
    return {
      rendering: 'qlik-embed',
      connectionAlias: target.connection,
      appId: target.appId,
      objectId,
      operationId,
      mode,
    };
  }
}
