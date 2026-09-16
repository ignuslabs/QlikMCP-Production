import type { SheetManifest, SheetPreviewSummary } from './sheetTypes.js';
/**
 * Shared cross-cutting domain types for the Qlik AI Harness.
 *
 * These types describe the harness's own internal, provider-neutral records
 * (actor/target identity, chart plans, approvals, operations). They are
 * deliberately independent of any MCP wire format and of any Qlik-specific
 * transport detail; adapters translate to/from these shapes.
 */

export type PlatformId = 'cloud' | 'windows' | 'fixture';

/** A non-production connection alias, e.g. "cloud-dev" or "windows-dev". */
export type ConnectionAlias = string;

/** The effective local/remote identity attributed to harness operations. Never a Qlik credential. */
export interface ActorContext {
  readonly actor: string;
  readonly hostClientId: string;
}

export interface TargetRef {
  readonly connection: ConnectionAlias;
  readonly appId: string;
  readonly sheetId?: string;
}

/** The nine chart types an agent may request. Restricted and exhaustive by design. */
/** Needs to be updated to support both Qlik Windows Enterprise (on-prem) and Qlik Cloud */
/** https://qlik.dev/embed/foundational-knowledge/visualizations/ */
/** https://qlik.dev/embed/qlik-embed/quickstart/qlik-embed-charts-on-the-fly-tutorial/ */
export const CHART_TYPE_IDS = [
  'bar',
  'line',
  'scatter',
  'table',
  'kpi',
  'gauge',
  'treemap',
  'pie',
  'combo',
] as const;
export type ChartTypeId = (typeof CHART_TYPE_IDS)[number];

/**
 * Selects the Qlik-host-specific visualization property contract used by the
 * compiler. This is connection policy, not caller-controlled MCP input.
 */
export const VISUALIZATION_SCHEMA_PROFILE_IDS = [
  'qlik-cloud-current',
  'qlik-windows-pre-november-2025',
  'qlik-windows-november-2025-or-later',
] as const;
export type VisualizationSchemaProfileId = (typeof VISUALIZATION_SCHEMA_PROFILE_IDS)[number];

/** Qlik in-app/QIX chart identifiers; catalog support uses the legacy-compatible subset. */
export type NativeChartType =
  | 'barchart'
  | 'linechart'
  | 'scatterplot'
  | 'table'
  | 'sn-table'
  | 'kpi'
  | 'gauge'
  | 'treemap'
  | 'piechart'
  | 'combochart';

export type RiskClass = 'standard' | 'elevated' | 'restricted';

export type FieldRole = 'dimension' | 'measure';

export interface ResolvedFieldRef {
  readonly catalogId: string;
  readonly masterItemId?: string;
  readonly label: string;
  readonly role: FieldRole;
  readonly semanticType?: string;
}

export interface ResolvedMeasureRef extends ResolvedFieldRef {
  readonly role: 'measure';
  /** A harness-generated, allowlisted aggregation expression such as "Sum(Revenue)". Never caller-supplied raw text. */
  readonly expression: string;
}

export interface ResolvedFilterRef {
  readonly catalogId: string;
  readonly label: string;
  readonly values: readonly string[];
}

export interface CompactDiff {
  readonly summary: string;
  readonly additions: readonly string[];
  readonly removals: readonly string[];
}

/**
 * The full, server-side-only resolved chart plan. It is never returned in
 * full to an MCP caller: `qlik_plan_visualization` returns a `ChartPlanSummary`
 * derived from this record, and `propertyProposal` is used only by the
 * preview/apply pipeline when calling into a `TargetAdapter`.
 */
export interface ResolvedChartPlan {
  readonly planHash: string;
  readonly compilerVersion: string;
  readonly intentVersion: string;
  readonly catalogId: string;
  readonly target: TargetRef;
  readonly platform: PlatformId;
  /** Present on every compiler-produced v2 plan; optional for legacy stored/test plan compatibility. */
  readonly visualizationSchemaProfile?: VisualizationSchemaProfileId;
  readonly visualizationSchemaVersion?: string;
  readonly chartType: ChartTypeId;
  readonly nativeChartType: NativeChartType;
  readonly resolved: {
    readonly dimensions: readonly ResolvedFieldRef[];
    readonly measures: readonly ResolvedMeasureRef[];
    readonly filters: readonly ResolvedFilterRef[];
  };
  readonly title: string;
  readonly sort: string;
  readonly resultLimit: number;
  readonly riskClass: RiskClass;
  readonly warnings: readonly string[];
  readonly diff: CompactDiff;
  /** Compiler-produced native property proposal. Server/adapter-internal only; never serialized to a caller. */
  readonly propertyProposal: NativePropertyProposalLike;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * Intentionally loosely typed at the domain layer (see `compiler/chartTypeRegistry.ts`
 * for the concrete shape); kept as an alias here to avoid a circular import
 * between `domain` and `compiler`.
 */
export type NativePropertyProposalLike = Record<string, unknown>;

/** The bounded, safe-to-return summary of a plan. No property proposal, no QIX shapes. */
export interface ChartPlanSummary {
  readonly operationId: string;
  readonly planHash: string;
  readonly compilerVersion: string;
  readonly target: TargetRef;
  readonly platform: PlatformId;
  readonly chartType: ChartTypeId;
  readonly nativeChartType: NativeChartType;
  readonly resolved: {
    readonly dimensions: readonly ResolvedFieldRef[];
    readonly measures: readonly ResolvedMeasureRef[];
    readonly filters: readonly ResolvedFilterRef[];
  };
  readonly title: string;
  readonly riskClass: RiskClass;
  readonly warnings: readonly string[];
  readonly diff: CompactDiff;
  readonly previewEligible: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ApprovalRecord {
  readonly approvalToken: string;
  readonly planHash: string;
  readonly actor: string;
  readonly connectionAlias: ConnectionAlias;
  readonly appId: string;
  readonly sheetId: string;
  readonly riskClass: RiskClass;
  readonly expiresAt: string;
  readonly singleUse: true;
  readonly reviewedBy: string;
  state: 'requested' | 'approved' | 'rejected' | 'expired' | 'consumed';
  consumed: boolean;
  decidedAt?: string;
  consumedByIdempotencyKey?: string;
  readonly createdAt: string;
}

export type ApprovalDecision = 'pending' | 'approved' | 'rejected';

/** Durable, server-internal context needed by a separate reviewer service. */
export interface ApprovalReviewContext {
  readonly operationId: string;
  readonly correlationId: string;
  readonly platform: PlatformId;
  readonly chartType: ChartTypeId;
  readonly title: string;
  readonly resolvedSummary: {
    readonly dimensions: readonly string[];
    readonly measures: readonly string[];
    readonly filters: readonly {
      readonly field: string;
      readonly values: readonly string[];
    }[];
  };
  readonly warnings: readonly string[];
  readonly diff: CompactDiff;
}

export interface ApprovalRequestRecord {
  readonly requestId: string;
  readonly planHash: string;
  readonly requestingActor: string;
  readonly connectionAlias: ConnectionAlias;
  readonly appId: string;
  readonly sheetId: string;
  readonly riskClass: RiskClass;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly note?: string;
  readonly reviewContext?: ApprovalReviewContext;
  status: ApprovalDecision;
  decidedAt?: string;
  decidedBy?: string;
  rejectionReason?: string;
  approvalToken?: string;
}

export interface ApprovalRequestSummary {
  readonly requestId: string;
  readonly planHash: string;
  readonly requestingActor: string;
  readonly connection: ConnectionAlias;
  readonly appId: string;
  readonly sheetId: string;
  readonly chartType: ChartTypeId;
  readonly title: string;
  readonly resolvedSummary: ApprovalReviewContext['resolvedSummary'];
  readonly riskClass: RiskClass;
  readonly warnings: readonly string[];
  readonly diff: CompactDiff;
  readonly note?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ApprovalDecision | 'expired';
  readonly decidedAt?: string;
  readonly decidedBy?: string;
  readonly rejectionReason?: string;
}

export interface ApprovalSummary {
  readonly approvalToken: string;
  readonly planHash: string;
  readonly actor: string;
  readonly connection: ConnectionAlias;
  readonly appId: string;
  readonly sheetId: string;
  readonly chartType: ChartTypeId;
  readonly resolvedSummary: {
    readonly dimensions: readonly string[];
    readonly measures: readonly string[];
  };
  readonly riskClass: RiskClass;
  readonly warnings: readonly string[];
  readonly expiresAt: string;
  readonly singleUse: true;
  readonly status: 'approved';
}

/** Matches `test/fixtures/operations.json#/operationContract/phases` exactly. */
export type OperationPhase =
  | 'discovered'
  | 'planned'
  | 'previewed'
  | 'approval-requested'
  | 'approved'
  | 'applying'
  | 'verified'
  | 'failed'
  | 'cleanup-required'
  | 'expired'
  | 'replayed';

export interface TypedOutcome {
  readonly status: OperationPhase;
  readonly category?: string;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  readonly cleanupRequired?: boolean;
  readonly originalOperationId?: string;
  readonly originalObjectId?: string;
}

/**
 * A sanitized operation/audit record. Field names and shape mirror
 * `test/fixtures/audit/*.json` (`recordType: "sanitized-operation-audit"`)
 * exactly so the harness's own audit output is directly comparable to the
 * shared fixture contract.
 */
export interface OperationRecord {
  readonly sheetManifestIntegrity?: string;
  readonly sheetManifest?: SheetManifest;
  readonly sheetPreview?: SheetPreviewSummary;
  readonly recordVersion: '1.0.0';
  readonly recordType: 'sanitized-operation-audit';
  readonly operationId: string;
  readonly timestamp: string;
  readonly correlationId: string;
  readonly requestingPrincipal: string;
  readonly hostClientId: string;
  readonly connectionAlias: ConnectionAlias;
  readonly platform: PlatformId;
  readonly target: { readonly appId: string; readonly sheetId?: string };
  readonly effectiveQlikIdentityClass: string;
  readonly intentVersion: string;
  readonly compilerVersion: string;
  readonly planHash?: string;
  readonly policyResult: string;
  readonly approvalState: string;
  typedOutcome: TypedOutcome;
  retryCount: number;
  durationMilliseconds: number;
  cleanupAttempted: boolean;
  cleanupOutcome: string;
  createdObjectId: string | null;
  sheetAttachmentId?: string | null;
  readonly traceReference: string;
  readonly redaction: {
    readonly rawPayloadsRemoved: true;
    readonly sensitiveValuesRemoved: true;
    readonly credentialMaterialPresent: false;
  };
}

export type IdempotencyStatus = 'in-progress' | 'completed' | 'failed';

export interface IdempotencyRecord {
  readonly idempotencyKey: string;
  readonly actor: string;
  readonly connectionAlias: ConnectionAlias;
  readonly appId: string;
  readonly sheetId: string;
  readonly planHash: string;
  status: IdempotencyStatus;
  operationId: string;
  result?: unknown;
}

export interface RenderDescriptor {
  readonly rendering: 'qlik-embed';
  readonly connectionAlias: ConnectionAlias;
  readonly appId: string;
  readonly objectId: string;
  readonly operationId: string;
  readonly mode: 'preview' | 'persisted';
}
export interface PreviewSummary {
  readonly operationId: string;
  readonly planHash: string;
  readonly status: 'previewed';
  readonly preview: {
    readonly dimensionLabels: readonly string[];
    readonly measureLabels: readonly string[];
    readonly rows: readonly (readonly (string | number)[])[];
    readonly returnedRows: number;
    readonly maxRows: number;
    readonly truncated: boolean;
    readonly continuation?: string;
  };
  readonly render: RenderDescriptor;
  readonly warnings: readonly string[];
}

export interface ApplySummary {
  readonly operationId: string;
  readonly planHash: string;
  readonly status: 'verified';
  readonly objectId: string;
  readonly sheetAttachmentId: string;
  readonly verified: true;
  readonly render: RenderDescriptor;
  readonly warnings: readonly string[];
}
