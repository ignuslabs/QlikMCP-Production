import type { ResolvedFieldRef } from '../domain/types.js';
import type { CardinalityBand, CatalogDefinition } from './catalogTypes.js';

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface FieldCardinality {
  readonly band: CardinalityBand;
  readonly maxDistinctValues: number | undefined;
}

/**
 * Resolves the cardinality of a resolved field/master-item reference. Plain
 * field references look up `catalog.fields` directly by ID; master-item
 * references fall back to a best-effort normalized-label match against the
 * underlying field (master items do not carry their own cardinality data),
 * defaulting to a safe "low" band when no underlying field can be found.
 */
export function resolveFieldCardinality(
  catalog: CatalogDefinition,
  ref: ResolvedFieldRef,
): FieldCardinality {
  const directField = catalog.fields.find((field) => field.id === ref.catalogId);
  if (directField) {
    return {
      band: directField.cardinality.band,
      maxDistinctValues: directField.cardinality.maxDistinctValues,
    };
  }
  if (ref.masterItemId) {
    const normalized = normalizeLabel(ref.label);
    const matched = catalog.fields.find((field) => normalizeLabel(field.label) === normalized);
    if (matched) {
      return {
        band: matched.cardinality.band,
        maxDistinctValues: matched.cardinality.maxDistinctValues,
      };
    }
  }
  return { band: 'low', maxDistinctValues: undefined };
}
