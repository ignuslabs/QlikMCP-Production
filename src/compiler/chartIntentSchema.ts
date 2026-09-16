import { z } from 'zod';

/**
 * Agent-facing `ChartIntent` contract (see docs/06-native-visualization-contract.md).
 *
 * This is a data shape only: it never accepts a raw QIX property tree, an
 * object ID/handle, or an arbitrary caller-supplied engine expression. Field
 * references are display labels resolved server-side against the bounded
 * catalog (see `catalog/resolver.ts` and `compiler/expressionGrammar.ts`).
 * The tool-level `connection`/`appId`/`sheetId` (see
 * `mcp/tools/planVisualization.ts`) supply target identity; `intent` below
 * carries only the analytical request.
 */

const FIELD_LABEL = z.string().trim().min(1).max(120);
const MEASURE_LABEL = z.string().trim().min(1).max(200);

const filterSchema = z
  .object({
    field: FIELD_LABEL,
    values: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
  })
  .strict();

const analysisSchema = z
  .object({
    dimensions: z.array(FIELD_LABEL).min(0).max(6),
    measures: z.array(MEASURE_LABEL).min(1).max(8),
    filters: z.array(filterSchema).min(0).max(10).optional(),
  })
  .strict();

const SORT_OPTIONS = [
  'measure-descending',
  'measure-ascending',
  'dimension-ascending',
  'dimension-descending',
  'none',
] as const;

const presentationSchema = z
  .object({
    preferredChartType: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(120),
    sort: z.enum(SORT_OPTIONS).optional(),
    target: z.number().finite().optional(),
    topN: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const MODE_OPTIONS = ['preview', 'preview-then-apply', 'apply'] as const;

export const chartIntentSchema = z
  .object({
    analysis: analysisSchema,
    presentation: presentationSchema,
    mode: z.enum(MODE_OPTIONS).optional().default('preview'),
  })
  .strict();

export type ChartIntentInput = z.infer<typeof chartIntentSchema>;
export type ChartFilterInput = z.infer<typeof filterSchema>;
