import type { NativeChartType } from '../domain/types.js';

/**
 * Types describing the shared logical catalog contract in
 * `test/fixtures/catalog.json` (`contract: "qlik-logical-catalog-v1"`).
 * The fixture-safe adapter loads this file directly (read-only); Cloud and
 * Windows adapters would map their live metadata into the same shape.
 */

export type CardinalityBand = 'low' | 'medium' | 'high' | 'continuous';

export interface CatalogFieldCardinality {
  readonly band: CardinalityBand;
  readonly maxDistinctValues?: number;
}

export interface CatalogField {
  readonly id: string;
  readonly label: string;
  readonly role: 'dimension' | 'measure';
  readonly semanticType: string;
  readonly cardinality: CatalogFieldCardinality;
  readonly visible: boolean;
  readonly qualifiedLabel?: string;
}

export interface CatalogMasterItem {
  readonly id: string;
  readonly label: string;
  readonly kind: 'dimension' | 'measure';
  readonly semanticType: string;
  readonly visible: boolean;
}

export interface CatalogChartSupport {
  readonly type: NativeChartType;
  readonly enabled: boolean;
  readonly maxDimensionCardinalityBand?: CardinalityBand;
  readonly boundedResultRows?: number;
  readonly requiresSemanticType?: string;
  readonly requiresNumericMeasures?: number;
  readonly requiresMeasures?: number;
  readonly requiresTarget?: boolean;
  readonly maxDimensionCount?: number;
}

export interface ExcludedMetadataExample {
  readonly id: string;
  readonly label: string;
  readonly kind: 'field' | 'master-item' | 'load-script';
  readonly classification: 'sensitive' | 'restricted' | 'internal';
  readonly visible: false;
  readonly exclusionReason: string;
}

export interface CatalogDefinition {
  readonly catalogId: string;
  readonly description: string;
  readonly visibilityPolicy: {
    readonly includeVisibleMetadata: boolean;
    readonly excludeHiddenMetadata: boolean;
    readonly excludeSensitiveMetadata: boolean;
    readonly excludeLoadScripts: boolean;
    readonly excludeDataConnections: boolean;
    readonly excludeSecurityRules: boolean;
  };
  readonly fields: readonly CatalogField[];
  readonly masterItems: readonly CatalogMasterItem[];
  readonly chartSupport: readonly CatalogChartSupport[];
  readonly excludedMetadataExamples: readonly ExcludedMetadataExample[];
  readonly excludedResponseProperties: readonly string[];
}

export interface CatalogSheetDefinition {
  readonly id: string;
  readonly alias: string;
  readonly name: string;
  readonly writeAllowed: boolean;
}

export interface CatalogTargetDefinition {
  readonly targetId: string;
  readonly connectionAlias: string;
  readonly platform: 'cloud' | 'windows';
  readonly environment: string;
  readonly catalogRef: string;
  readonly catalogVariants: Readonly<Record<string, string>>;
  readonly app: { readonly id: string; readonly alias: string; readonly name: string };
  readonly sheets: readonly CatalogSheetDefinition[];
}

export interface CatalogFixtureFile {
  readonly fixtureVersion: string;
  readonly contract: string;
  readonly nonProductionOnly: true;
  readonly variantAliases: Readonly<Record<string, string>>;
  readonly catalogs: Readonly<Record<string, CatalogDefinition>>;
  readonly targets: readonly CatalogTargetDefinition[];
}

/** The catalog variant an app/catalog lookup may request. */
export type CatalogVariant = 'default' | 'empty';
