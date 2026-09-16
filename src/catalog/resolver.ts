import { createError } from '../domain/errors.js';
import type { FieldRole, ResolvedFieldRef } from '../domain/types.js';
import type { CatalogDefinition } from './catalogTypes.js';

/**
 * Resolves a caller-supplied display label against the authorized semantic
 * catalog (master items first, then plain fields), matching the fixture's
 * ambiguity/sensitivity/unknown-field contract in
 * `test/fixtures/operations.json`. The compiler layer is responsible for
 * checking that the resolved role matches the requested position
 * (dimension vs. measure); this module never knows about chart types.
 */
export function resolveCatalogLabel(
  catalog: CatalogDefinition,
  rawLabel: string,
): ResolvedFieldRef {
  const label = rawLabel.trim();

  const masterCandidates = catalog.masterItems.filter((item) => item.label === label);
  if (masterCandidates.length === 1) {
    const item = masterCandidates[0]!;
    return {
      catalogId: item.id,
      masterItemId: item.id,
      label: item.label,
      role: roleOf(item.kind),
      semanticType: item.semanticType,
    };
  }
  if (masterCandidates.length > 1) {
    throw createError('AMBIGUOUS_FIELD', {
      message: `"${label}" resolves to more than one authorized master item.`,
      details: { candidates: masterCandidates.map((item) => item.id) },
    });
  }

  return resolveCatalogFieldLabel(catalog, label);
}

/** Resolves only a concrete data-model field, never a master library item. */
export function resolveCatalogFieldLabel(
  catalog: CatalogDefinition,
  rawLabel: string,
): ResolvedFieldRef {
  const label = rawLabel.trim();
  const qualifiedCandidates = label.includes('.')
    ? catalog.fields.filter((field) => field.qualifiedLabel === label)
    : [];
  if (qualifiedCandidates.length === 1) {
    const field = qualifiedCandidates[0]!;
    return {
      catalogId: field.id,
      label: field.label,
      role: field.role,
      semanticType: field.semanticType,
    };
  }

  const fieldCandidates = catalog.fields.filter((field) => field.label === label);
  if (fieldCandidates.length === 1) {
    const field = fieldCandidates[0]!;
    return {
      catalogId: field.id,
      label: field.label,
      role: field.role,
      semanticType: field.semanticType,
    };
  }
  if (fieldCandidates.length > 1) {
    throw createError('AMBIGUOUS_FIELD', {
      message: `"${label}" resolves to more than one authorized field. Use a qualified label (for example "Order.${label}").`,
      details: { candidates: fieldCandidates.map((field) => field.id) },
    });
  }

  const excluded = catalog.excludedMetadataExamples.find((example) => example.label === label);
  if (excluded) {
    throw createError('SENSITIVE_FIELD', {
      message: `"${label}" is excluded from the authorized catalog by ${excluded.exclusionReason}.`,
      details: { excludedMetadataId: excluded.id },
    });
  }

  throw createError('UNKNOWN_FIELD', {
    message: `"${label}" is not present in the authorized semantic catalog.`,
    details: { requestedLabel: label },
  });
}

function roleOf(kind: 'dimension' | 'measure'): FieldRole {
  return kind;
}
