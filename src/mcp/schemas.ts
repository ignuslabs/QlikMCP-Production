import { z } from 'zod';
import { CHART_TYPE_IDS } from '../domain/types.js';

/**
 * Shared, strict zod schemas used to build every MCP tool's input/output
 * contract. Every object schema in this module is `.strict()`: unknown
 * properties are rejected, not silently stripped (see
 * docs/08-mcp-server-contract.md, "Tool Rules").
 */

export const platformSchema = z.enum(['cloud', 'windows']);

export const connectionSchema = z.string().trim().min(1).max(100);
export const appIdSchema = z.string().trim().min(1).max(200);
export const sheetIdSchema = z.string().trim().min(1).max(200);

export const pageRequestSchema = z
  .object({
    pageSize: z.number().int().min(1).max(50).optional(),
    pageToken: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const appSummarySchema = z
  .object({
    appId: appIdSchema,
    name: z.string(),
    connection: connectionSchema,
    platform: platformSchema,
    environment: z.string(),
  })
  .strict();

export const cardinalitySchema = z
  .object({
    band: z.enum(['low', 'medium', 'high', 'continuous']),
    maxDistinctValues: z.number().int().min(0).optional(),
  })
  .strict();

export const catalogFieldSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    role: z.enum(['dimension', 'measure']),
    semanticType: z.string(),
    cardinality: cardinalitySchema,
    visible: z.literal(true),
    qualifiedLabel: z.string().optional(),
  })
  .strict();

export const masterItemSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(['dimension', 'measure']),
    semanticType: z.string(),
    visible: z.literal(true),
  })
  .strict();

export const chartSupportSchema = z
  .object({
    type: z.enum([
      'barchart',
      'linechart',
      'scatterplot',
      'table',
      'kpi',
      'gauge',
      'treemap',
      'piechart',
      'combochart',
    ]),
    enabled: z.boolean(),
    maxDimensionCardinalityBand: z.enum(['low', 'medium', 'high', 'continuous']).optional(),
    boundedResultRows: z.number().int().min(1).optional(),
    requiresSemanticType: z.string().optional(),
    requiresNumericMeasures: z.number().int().min(0).optional(),
    requiresMeasures: z.number().int().min(0).optional(),
    requiresTarget: z.boolean().optional(),
    maxDimensionCount: z.number().int().min(0).optional(),
  })
  .strict();

export const sheetSummarySchema = z
  .object({
    sheetId: sheetIdSchema,
    name: z.string(),
    writeAllowed: z.boolean(),
  })
  .strict();

export const sheetObjectSummarySchema = z
  .object({
    objectId: z.string(),
    type: z.string(),
    title: z.string(),
  })
  .strict();

export const targetRefSchema = z
  .object({
    connection: connectionSchema,
    appId: appIdSchema,
    sheetId: sheetIdSchema,
  })
  .strict();

export const resolvedFieldRefSchema = z
  .object({
    catalogId: z.string(),
    masterItemId: z.string().optional(),
    label: z.string(),
    role: z.enum(['dimension', 'measure']),
    semanticType: z.string().optional(),
  })
  .strict();

export const resolvedMeasureRefSchema = resolvedFieldRefSchema.extend({
  role: z.literal('measure'),
  expression: z.string(),
});

export const resolvedFilterRefSchema = z
  .object({
    catalogId: z.string(),
    label: z.string(),
    values: z.array(z.string()),
  })
  .strict();

export const compactDiffSchema = z
  .object({
    summary: z.string(),
    additions: z.array(z.string()),
    removals: z.array(z.string()),
  })
  .strict();

export const riskClassSchema = z.enum(['standard', 'elevated', 'restricted']);
export const chartTypeIdSchema = z.enum(CHART_TYPE_IDS);
export const nativeChartTypeSchema = z.enum([
  'barchart',
  'linechart',
  'scatterplot',
  'table',
  'sn-table',
  'kpi',
  'gauge',
  'treemap',
  'piechart',
  'combochart',
]);

export const renderDescriptorSchema = z
  .object({
    rendering: z.literal('qlik-embed'),
    connectionAlias: connectionSchema,
    appId: appIdSchema,
    objectId: z.string(),
    operationId: z.string(),
    mode: z.enum(['preview', 'persisted']),
  })
  .strict();
