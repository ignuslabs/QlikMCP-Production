import type { ChartTypeId, PlatformId, TargetRef } from './types.js';

export interface SheetPosition {
  readonly col: number;
  readonly row: number;
  readonly colspan: number;
  readonly rowspan: number;
}

/** Safe manifest: native property proposals remain in the private plan repository. */
export interface SheetManifest {
  readonly version: 1;
  readonly compilerVersion: string;
  readonly catalogHash: string;
  readonly planHash: string;
  readonly title: string;
  readonly target: Required<TargetRef>;
  readonly platform: PlatformId;
  readonly sourceSheetId: string;
  readonly charts: readonly {
    readonly planHash: string;
    readonly objectId: string;
    readonly title: string;
    readonly chartType: ChartTypeId;
    readonly position: SheetPosition;
  }[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SheetPlanSummary extends SheetManifest {
  readonly operationId: string;
  readonly status: 'planned';
  readonly executionMode: 'scoped-autonomous';
}

export interface SheetPreviewSummary {
  readonly operationId: string;
  readonly planHash: string;
  readonly status: 'previewed';
  readonly charts: readonly {
    readonly objectId: string;
    readonly returnedRows: number;
    readonly truncated: boolean;
  }[];
  readonly verifiedAt: string;
}

export interface SheetExecutionSummary {
  readonly operationId: string;
  readonly planHash: string;
  readonly sheetId: string;
  readonly status: 'verified' | 'partial';
  readonly verified: boolean;
  readonly charts: readonly { readonly objectId: string; readonly verified: boolean }[];
  readonly verifiedAt: string;
  readonly attempt: number;
  readonly nextAttempt?: number;
  readonly errorCode?: string;
  readonly durationMilliseconds: number;
}
