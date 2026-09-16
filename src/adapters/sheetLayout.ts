import { createError } from '../domain/errors.js';
import type { SheetPlacement } from './targetAdapter.js';

export const SHEET_COLUMNS = 24;
export const SHEET_ROWS = 12;
export const MAX_SHEET_ROWS = 1_000;
export const MAX_SHEET_OBJECTS = 100;

/** Qlik Sense client sheet properties, separate from Engine generic-object properties. */
export const NATIVE_SHEET_LAYOUT = {
  columns: SHEET_COLUMNS,
  rows: SHEET_ROWS,
  gridResolution: 'small',
  height: 100,
  pxWidth: 1080,
  pxHeight: 720,
  layoutOptions: { sheetMode: 'RESPONSIVE', extendable: false, mobileLayout: 'LIST' },
  labelExpression: '',
  thumbnail: { qStaticContentUrlDef: { qUrl: '' } },
} as const;

export function sheetCellBounds(placement: SheetPlacement, columns: number, rows: number) {
  return {
    x: (placement.col * 100) / columns,
    y: (placement.row * 100) / rows,
    width: (placement.colspan * 100) / columns,
    height: (placement.rowspan * 100) / rows,
  };
}

export function matchesSheetCellBounds(
  value: unknown,
  placement: SheetPlacement,
  columns: number,
  rows: number,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bounds = value as Record<string, unknown>;
  const expected = sheetCellBounds(placement, columns, rows);
  return Object.entries(expected).every(
    ([key, number]) =>
      typeof bounds[key] === 'number' &&
      Number.isFinite(bounds[key]) &&
      Math.abs(bounds[key] - number) <= 1e-6,
  );
}

export function isSheetPlacement(value: unknown): value is SheetPlacement {
  if (!value || typeof value !== 'object') return false;
  const placement = value as Record<string, unknown>;
  return (
    ['col', 'row', 'colspan', 'rowspan'].every(
      (key) => typeof placement[key] === 'number' && Number.isSafeInteger(placement[key]),
    ) &&
    Number(placement.col) >= 0 &&
    Number(placement.row) >= 0 &&
    Number(placement.colspan) > 0 &&
    Number(placement.rowspan) > 0 &&
    Number(placement.col) + Number(placement.colspan) <= SHEET_COLUMNS &&
    Number(placement.row) + Number(placement.rowspan) <= MAX_SHEET_ROWS
  );
}

export function placementsOverlap(left: SheetPlacement, right: SheetPlacement): boolean {
  return (
    left.col < right.col + right.colspan &&
    right.col < left.col + left.colspan &&
    left.row < right.row + right.rowspan &&
    right.row < left.row + left.rowspan
  );
}

export function samePlacement(actual: SheetPlacement, expected: SheetPlacement): boolean {
  return (
    actual.col === expected.col &&
    actual.row === expected.row &&
    actual.colspan === expected.colspan &&
    actual.rowspan === expected.rowspan
  );
}

export function assertSheetPlacement(placement: SheetPlacement): void {
  if (!isSheetPlacement(placement)) {
    throw createError('MALFORMED_REQUEST', {
      message: 'The native sheet placement is outside the bounded integer grid.',
    });
  }
}

/** Structural comparison tolerates property ordering and Qlik-added defaults. */
export function containsProperties(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((entry, index) => containsProperties(actual[index], entry))
    );
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      containsProperties((actual as Record<string, unknown>)[key], value),
    );
  }
  return Object.is(actual, expected);
}
