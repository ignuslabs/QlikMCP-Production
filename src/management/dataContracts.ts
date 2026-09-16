import { z } from 'zod';

export const MAX_DATASET_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_DATASET_COLUMNS = 200;
export const MAX_DATASET_PREVIEW_ROWS = 50;
export const MAX_DATA_QUALITY_ROWS = 5000;
export const MAX_DATA_QUALITY_CELLS = 100_000;
export const MAX_DATASET_CELL_LENGTH = 16_384;

/** Dollar expansion occurs before Qlik parses quoted identifiers or literals. */
export const dataIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0, 'An identifier must contain visible characters.')
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'Control characters are not allowed.')
  .refine((value) => !value.includes('$('), 'Qlik dollar expansion is not allowed.');

export const datasetFilenameSchema = z
  .string()
  .min(5)
  .max(128)
  .refine((value) => value === value.normalize('NFC'), 'Use a normalized filename.')
  .regex(
    /^[\p{L}\p{N}_][\p{L}\p{N} _().-]*\.(csv|xlsx|qvd)$/iu,
    'Use a CSV, XLSX, or QVD filename without a path.',
  )
  .refine((value) => !value.includes('..'), 'Parent path segments are not allowed.');

export const datasetFormatSchema = z.enum(['csv', 'xlsx', 'qvd']);
/** A verified Qlik space name used before the DataFiles connection separator. */
export const dataSpaceNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim() && value.length > 0, 'Use the exact space name.')
  .refine((value) => value === value.normalize('NFC'), 'Use a normalized space name.')
  .refine(
    (value) => !/[\p{Cc}\p{Cf}:/\\[\]$"*?<>|]/u.test(value),
    'Space names cannot contain path separators, script expansion, or quote delimiters.',
  );
/** A server-resolved DataFiles directory, never a raw caller-supplied URI. */
export const dataFolderPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value === value.normalize('NFC'), 'Use a normalized folder path.')
  .refine((value) => {
    const segments = value.split('/');
    return (
      segments.length <= 10 &&
      segments.every(
        (segment) =>
          /^[\p{L}\p{N}_][\p{L}\p{N} _().-]{0,127}$/u.test(segment) && !segment.endsWith(' '),
      )
    );
  }, 'Use bounded relative folder segments without traversal or script syntax.');
export const csvDelimiterSchema = z.enum([',', ';', '\t', '|']);
export const datasetSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Use a lowercase SHA-256 digest.');

export const datasetUploadSchema = z
  .object({
    filename: datasetFilenameSchema,
    mimeType: z.enum([
      'text/csv',
      'application/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
      'application/vnd.qlik.qvd',
    ]),
    contentBase64: z
      .string()
      .min(4)
      .max(4 * Math.ceil(MAX_DATASET_UPLOAD_BYTES / 3)),
    expectedSha256: datasetSha256Schema.optional(),
    csvDelimiter: csvDelimiterSchema.optional(),
  })
  .strict();

const dataFileIdSchema = z.string().trim().min(1).max(200);

/** Supplied by the authenticated service after resolving its allowed data files. */
export const approvedDataFileSchema = z
  .object({
    dataFileId: dataFileIdSchema,
    filename: datasetFilenameSchema,
    spaceName: dataSpaceNameSchema.optional(),
    folderPath: dataFolderPathSchema.optional(),
    format: datasetFormatSchema,
    sha256: datasetSha256Schema.optional(),
    fields: z.array(dataIdentifierSchema).min(1).max(MAX_DATASET_COLUMNS).optional(),
    sheetNames: z.array(dataIdentifierSchema).min(1).max(100).optional(),
  })
  .strict();

const safeLiteralSchema = z
  .string()
  .max(200)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'Control characters are not allowed.')
  .refine((value) => !value.includes('$('), 'Qlik dollar expansion is not allowed.');

export const dataFieldTypeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text') }).strict(),
  z
    .object({
      kind: z.literal('number'),
      format: z.enum(['0', '0.##############', '#,##0', '#,##0.##############']),
      decimalSeparator: z.enum(['.', ',']),
      thousandSeparator: z.enum(['', '.', ',', ' ']),
    })
    .strict()
    .refine((value) => value.decimalSeparator !== value.thousandSeparator, {
      message: 'Decimal and thousands separators must differ.',
    }),
  z
    .object({
      kind: z.literal('date'),
      inputFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY']),
      outputFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY']),
    })
    .strict(),
]);

export const dataFieldTransformSchema = z
  .object({
    source: dataIdentifierSchema,
    as: dataIdentifierSchema.optional(),
    trim: z.boolean().optional(),
    case: z.enum(['upper', 'lower']).optional(),
    emptyAsNull: z.boolean().optional(),
    nullValues: z.array(safeLiteralSchema).max(20).optional(),
    type: dataFieldTypeSchema.optional(),
  })
  .strict();

export const dataSourceSchema = z.discriminatedUnion('format', [
  z
    .object({
      format: z.literal('csv'),
      dataFileId: dataFileIdSchema,
      delimiter: csvDelimiterSchema.default(','),
    })
    .strict(),
  z
    .object({
      format: z.literal('xlsx'),
      dataFileId: dataFileIdSchema,
      sheetName: dataIdentifierSchema,
    })
    .strict(),
  z.object({ format: z.literal('qvd'), dataFileId: dataFileIdSchema }).strict(),
]);

export const dataJoinSchema = z
  .object({
    type: z.enum(['left', 'inner', 'right', 'outer']),
    targetTable: dataIdentifierSchema,
    /** Names after field transforms. They must be the only common output names. */
    keys: z.array(dataIdentifierSchema).min(1).max(10),
  })
  .strict();

export const dataTableSchema = z
  .object({
    name: dataIdentifierSchema,
    source: dataSourceSchema,
    fields: z.array(dataFieldTransformSchema).min(1).max(MAX_DATASET_COLUMNS),
    join: dataJoinSchema.optional(),
  })
  .strict();

export const dataManifestSchema = z
  .object({
    version: z.literal(1),
    tables: z.array(dataTableSchema).min(1).max(20),
  })
  .strict();

export const dataCellSchema = z.union([
  z.string().max(MAX_DATASET_CELL_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const dataQualityColumnSchema = z
  .object({
    name: dataIdentifierSchema,
    expectedType: z.enum(['text', 'number', 'boolean', 'date']).optional(),
  })
  .strict();

export const dataQualityRequestSchema = z
  .object({
    columns: z.array(dataQualityColumnSchema).min(1).max(MAX_DATASET_COLUMNS),
    rows: z.array(z.array(dataCellSchema).max(MAX_DATASET_COLUMNS)).max(MAX_DATA_QUALITY_ROWS),
    keyFields: z.array(dataIdentifierSchema).min(1).max(10).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const names = value.columns.map((column) => column.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: 'custom', message: 'Column names must be unique.' });
    }
    if (value.rows.length * value.columns.length > MAX_DATA_QUALITY_CELLS) {
      context.addIssue({
        code: 'custom',
        message: 'The supplied row sample exceeds the cell limit.',
      });
    }
    if (value.rows.some((row) => row.length !== value.columns.length)) {
      context.addIssue({
        code: 'custom',
        message: 'Every row must match the declared column count.',
      });
    }
    if (
      value.keyFields &&
      (new Set(value.keyFields).size !== value.keyFields.length ||
        value.keyFields.some((field) => !names.includes(field)))
    ) {
      context.addIssue({ code: 'custom', message: 'Key fields must be unique declared columns.' });
    }
    const characters = value.rows.reduce(
      (total, row) =>
        total +
        row.reduce<number>(
          (count, cell) => count + (typeof cell === 'string' ? cell.length : 8),
          0,
        ),
      0,
    );
    if (characters > 2 * 1024 * 1024) {
      context.addIssue({
        code: 'custom',
        message: 'The supplied row sample exceeds the content limit.',
      });
    }
  });

export type DatasetUpload = z.infer<typeof datasetUploadSchema>;
export type DatasetFormat = z.infer<typeof datasetFormatSchema>;
export type ApprovedDataFile = z.infer<typeof approvedDataFileSchema>;
export type DataManifest = z.infer<typeof dataManifestSchema>;
export type DataFieldTransform = z.infer<typeof dataFieldTransformSchema>;
export type DataCell = z.infer<typeof dataCellSchema>;
export type DataQualityRequest = z.infer<typeof dataQualityRequestSchema>;
