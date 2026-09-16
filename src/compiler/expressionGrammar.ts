import { resolveCatalogFieldLabel, resolveCatalogLabel } from '../catalog/resolver.js';
import { createError } from '../domain/errors.js';
import type { ResolvedFieldRef, ResolvedMeasureRef } from '../domain/types.js';
import type { CatalogDefinition } from '../catalog/catalogTypes.js';

/**
 * A deliberately tiny, allowlisted measure grammar. A caller may reference a
 * catalog label directly (resolved server-side against master items/fields)
 * or wrap exactly one catalog label in exactly one allowlisted aggregation
 * function, e.g. "Sum(Revenue)". Nothing else is accepted: the harness never
 * evaluates or forwards a caller-supplied raw engine expression.
 */
const ALLOWED_AGGREGATIONS = ['Sum', 'Avg', 'Count', 'Min', 'Max', 'Median'] as const;
type Aggregation = (typeof ALLOWED_AGGREGATIONS)[number];

const AGGREGATION_PATTERN = new RegExp(`^(${ALLOWED_AGGREGATIONS.join('|')})\\(([^()]+)\\)$`, 'i');
const SUSPICIOUS_EXPRESSION_PATTERN = /[()+\-*/=<>]/;

export type MeasureReferenceFormat = 'catalog-label' | 'allowlisted-aggregation';

export function isPlainDimensionReference(raw: string): boolean {
  return !SUSPICIOUS_EXPRESSION_PATTERN.test(raw.trim());
}

export function classifyMeasureReference(raw: string): MeasureReferenceFormat | undefined {
  const trimmed = raw.trim();
  if (AGGREGATION_PATTERN.test(trimmed)) return 'allowlisted-aggregation';
  return SUSPICIOUS_EXPRESSION_PATTERN.test(trimmed) ? undefined : 'catalog-label';
}

function normalizeAggregation(raw: string): Aggregation {
  const match = ALLOWED_AGGREGATIONS.find((fn) => fn.toLowerCase() === raw.toLowerCase());
  if (!match) {
    throw createError('DISALLOWED_EXPRESSION', {
      message: `"${raw}" is not an approved aggregation function.`,
    });
  }
  return match;
}

function qlikFieldReference(label: string): string {
  return `[${label.split(']').join(']]')}]`;
}

function assertAggregationSupportsField(
  aggregation: Aggregation,
  ref: ResolvedFieldRef,
  requestedLabel: string,
): void {
  if (aggregation === 'Count' || ref.semanticType === 'numeric') return;
  throw createError('INVALID_MEASURE', {
    message: `"${requestedLabel}" is not a numeric field for the ${aggregation} aggregation.`,
    details: { requestedLabel, aggregation, resolvedSemanticType: ref.semanticType ?? 'unknown' },
  });
}

export function resolveMeasureReference(
  catalog: CatalogDefinition,
  rawMeasure: string,
): ResolvedMeasureRef {
  const trimmed = rawMeasure.trim();
  const match = AGGREGATION_PATTERN.exec(trimmed);

  if (match) {
    const aggregation = normalizeAggregation(match[1]!);
    const label = match[2]!.trim();
    const ref = resolveCatalogFieldLabel(catalog, label);
    assertAggregationSupportsField(aggregation, ref, label);
    return {
      ...ref,
      role: 'measure',
      semanticType: 'numeric',
      expression: `${aggregation}(${qlikFieldReference(ref.label)})`,
    };
  }

  if (SUSPICIOUS_EXPRESSION_PATTERN.test(trimmed)) {
    throw createError('DISALLOWED_EXPRESSION', {
      message: `"${trimmed}" is outside the approved aggregation and expression allowlist.`,
      details: { requested: trimmed },
    });
  }

  const ref = resolveCatalogLabel(catalog, trimmed);
  assertMeasureRole(ref, trimmed);
  return { ...ref, role: 'measure', expression: `Sum(${qlikFieldReference(ref.label)})` };
}

export function resolveDimensionReference(
  catalog: CatalogDefinition,
  rawDimension: string,
): ResolvedFieldRef {
  const trimmed = rawDimension.trim();
  if (SUSPICIOUS_EXPRESSION_PATTERN.test(trimmed)) {
    throw createError('DISALLOWED_EXPRESSION', {
      message: `"${trimmed}" is outside the approved dimension reference format.`,
      details: { requested: trimmed },
    });
  }
  const ref = resolveCatalogLabel(catalog, trimmed);
  if (ref.role !== 'dimension') {
    throw createError('INVALID_DIMENSION', {
      message: `"${trimmed}" resolves to a ${ref.role}, not a valid dimension.`,
      details: { requestedLabel: trimmed, resolvedRole: ref.role },
    });
  }
  return ref;
}

function assertMeasureRole(ref: ResolvedFieldRef, requestedLabel: string): void {
  if (ref.role !== 'measure') {
    throw createError('INVALID_MEASURE', {
      message: `"${requestedLabel}" resolves to a ${ref.role}, not a valid measure.`,
      details: { requestedLabel, resolvedRole: ref.role },
    });
  }
}

export function resolveFilterReference(
  catalog: CatalogDefinition,
  rawField: string,
): ResolvedFieldRef {
  const trimmed = rawField.trim();
  if (SUSPICIOUS_EXPRESSION_PATTERN.test(trimmed)) {
    throw createError('DISALLOWED_EXPRESSION', {
      message: `"${trimmed}" is outside the approved filter field reference format.`,
      details: { requested: trimmed },
    });
  }
  const ref = resolveCatalogFieldLabel(catalog, trimmed);
  if (ref.role !== 'dimension') {
    throw createError('INVALID_DIMENSION', {
      message: `"${trimmed}" resolves to a ${ref.role}, not a valid filter field.`,
      details: { requestedLabel: trimmed, resolvedRole: ref.role },
    });
  }
  return ref;
}
