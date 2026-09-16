import { computePlanHash } from '../domain/ids.js';

/** Canonical, JSON-serializable input used to derive a deterministic plan hash. */
export interface PlanHashInput {
  readonly compilerVersion: string;
  readonly catalogId: string;
  readonly platform: string;
  readonly visualizationSchemaProfile: string;
  readonly visualizationSchemaVersion: string | null;
  readonly target: {
    readonly connection: string;
    readonly appId: string;
    readonly sheetId: string;
  };
  readonly chartType: string;
  readonly dimensions: readonly { readonly catalogId: string; readonly label: string }[];
  readonly measures: readonly { readonly catalogId: string; readonly expression: string }[];
  readonly filters: readonly { readonly catalogId: string; readonly values: readonly string[] }[];
  readonly presentation: {
    readonly title: string;
    readonly sort: string;
    readonly target: number | null;
    readonly resultLimit: number;
  };
}

export function derivePlanHash(input: PlanHashInput): string {
  return computePlanHash(input);
}
