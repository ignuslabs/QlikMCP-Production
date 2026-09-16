import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import readExcelFile from 'read-excel-file/node';
import { HarnessError } from '../domain/errors.js';
// saxen publishes JavaScript without declarations; the used surface is typed below.
// @ts-expect-error No bundled declarations are published by saxen.
import { Parser } from 'saxen';
import {
  approvedDataFileSchema,
  dataIdentifierSchema,
  dataManifestSchema,
  dataQualityRequestSchema,
  datasetUploadSchema,
  MAX_DATASET_CELL_LENGTH,
  MAX_DATASET_COLUMNS,
  MAX_DATASET_PREVIEW_ROWS,
  MAX_DATASET_UPLOAD_BYTES,
  type ApprovedDataFile,
  type DataCell,
  type DataFieldTransform,
  type DataManifest,
  type DatasetFormat,
} from './dataContracts.js';

const MAX_CSV_ROWS = 100_000;
const MAX_PREVIEW_CHARACTERS = 256 * 1024;
const MAX_XLSX_ENTRIES = 500;
const MAX_XLSX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_XLSX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_XLSX_COMPRESSION_RATIO = 200;
const MAX_XLSX_CELLS = 500_000;
const MAX_XLSX_SHEETS = 20;

export class DataPreparationError extends HarnessError {
  constructor(
    readonly reason: 'invalid-upload' | 'invalid-manifest' | 'invalid-sample',
    message: string,
  ) {
    super({
      code: 'MALFORMED_REQUEST',
      category: 'validation',
      retryable: false,
      stage: 'request',
      message,
    });
    this.name = 'DataPreparationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface DatasetTablePreview {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly DataCell[])[];
  readonly totalRowCount: number;
  readonly truncated: boolean;
}

export interface ValidatedDatasetUpload {
  /** Transient transport content. Never put this object in audit storage or logs. */
  readonly bytes: Buffer;
  readonly filename: string;
  readonly mimeType: string;
  readonly format: DatasetFormat;
  readonly byteLength: number;
  readonly sha256: string;
  readonly inspection: {
    readonly level: 'parsed-csv' | 'parsed-xlsx' | 'qvd-header-only';
    readonly completeDataValidation: boolean;
    readonly warnings: readonly string[];
  };
  /** Row values are returned only to the requesting caller; do not persist them in summaries. */
  readonly preview: {
    readonly available: boolean;
    readonly tables: readonly DatasetTablePreview[];
    readonly reason?: string;
  };
}

function invalidUpload(message: string): never {
  throw new DataPreparationError('invalid-upload', message);
}

function invalidManifest(message: string): never {
  throw new DataPreparationError('invalid-manifest', message);
}

function strictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalidUpload('The file must use valid UTF-8 encoding.');
  }
}

function formatFromFilename(filename: string): DatasetFormat {
  return filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() as DatasetFormat;
}

/** Only parses approved CSV/XLSX formats; QVD record decoding remains Qlik-owned. */
export async function validateDatasetUpload(input: unknown): Promise<ValidatedDatasetUpload> {
  const parsed = datasetUploadSchema.safeParse(input);
  if (!parsed.success) invalidUpload('Upload metadata or encoded content is invalid.');
  const upload = parsed.data;
  const base64 = upload.contentBase64;
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    invalidUpload('Content must be canonical padded base64.');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_DATASET_UPLOAD_BYTES) {
    invalidUpload('The dataset exceeds the supported upload size or is empty.');
  }
  if (bytes.toString('base64') !== base64)
    invalidUpload('Content must be canonical padded base64.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (upload.expectedSha256 && upload.expectedSha256 !== sha256) {
    invalidUpload('Dataset checksum does not match the supplied SHA-256 digest.');
  }
  const format = formatFromFilename(upload.filename);
  const acceptedMimes: Record<DatasetFormat, readonly string[]> = {
    csv: ['text/csv', 'application/csv'],
    xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    qvd: ['application/octet-stream', 'application/vnd.qlik.qvd'],
  };
  if (!acceptedMimes[format].includes(upload.mimeType)) {
    invalidUpload('Filename and MIME type must identify the same supported dataset format.');
  }
  if (format !== 'csv' && upload.csvDelimiter !== undefined) {
    invalidUpload('CSV delimiter options cannot be used with a binary dataset.');
  }
  const metadata = {
    bytes,
    filename: upload.filename,
    mimeType: upload.mimeType,
    format,
    byteLength: bytes.length,
    sha256,
  };
  if (format === 'csv') {
    const table = parseCsvPreview(bytes, upload.csvDelimiter ?? ',', upload.filename);
    return {
      ...metadata,
      inspection: { level: 'parsed-csv', completeDataValidation: true, warnings: [] },
      preview: { available: true, tables: [table] },
    };
  }
  if (format === 'xlsx') {
    const inspection = inspectXlsxArchive(bytes);
    let sheets: Awaited<ReturnType<typeof readExcelFile<string>>>;
    try {
      // Preserve the source decimal representation and whitespace in previews.
      sheets = await readExcelFile<string>(bytes, { trim: false, parseNumber: (value) => value });
    } catch {
      invalidUpload('The XLSX workbook could not be decoded as a valid spreadsheet.');
    }
    if (sheets.length === 0 || sheets.length > MAX_XLSX_SHEETS) {
      invalidUpload('The workbook has an unsupported number of worksheets.');
    }
    let previewCharacters = 0;
    const tables = sheets.map((sheet) => {
      if (!dataIdentifierSchema.safeParse(sheet.sheet).success) {
        invalidUpload('A worksheet name cannot be used safely in a Qlik load script.');
      }
      const [header, ...records] = sheet.data;
      if (!header?.length || header.length > MAX_DATASET_COLUMNS) {
        invalidUpload('Every worksheet must start with a bounded, non-empty header row.');
      }
      const columns = validateHeaders(header);
      if (records.length > MAX_CSV_ROWS) invalidUpload('The worksheet exceeds the row limit.');
      const rows: DataCell[][] = [];
      for (const record of records) {
        if (record.length > columns.length)
          invalidUpload('Worksheet rows exceed the header width.');
        const cells: DataCell[] = Array.from({ length: columns.length }, (_, index): DataCell => {
          const value = record[index] ?? null;
          if (value instanceof Date) {
            if (!Number.isFinite(value.getTime()))
              invalidUpload('A worksheet contains an invalid date.');
            const iso = value.toISOString();
            return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
          }
          if (typeof value === 'string' && value.length > MAX_DATASET_CELL_LENGTH) {
            invalidUpload('A worksheet cell exceeds the supported length.');
          }
          if (
            value !== null &&
            typeof value !== 'string' &&
            typeof value !== 'number' &&
            typeof value !== 'boolean'
          )
            invalidUpload('A worksheet contains an unsupported cell value.');
          if (typeof value === 'number' && !Number.isFinite(value))
            invalidUpload('A worksheet contains a non-finite number.');
          return value;
        });
        const characters = countRowCharacters(cells);
        if (
          rows.length < MAX_DATASET_PREVIEW_ROWS &&
          previewCharacters + characters <= MAX_PREVIEW_CHARACTERS
        ) {
          rows.push(cells);
          previewCharacters += characters;
        }
      }
      return {
        name: sheet.sheet,
        columns,
        rows,
        totalRowCount: records.length,
        truncated: rows.length < records.length,
      };
    });
    return {
      ...metadata,
      inspection: {
        level: 'parsed-xlsx',
        completeDataValidation: true,
        warnings: inspection.hasFormulas
          ? [
              'Formula cells show saved cached values only; formulas are not recalculated and missing caches may appear empty.',
            ]
          : [],
      },
      preview: { available: true, tables },
    };
  }
  inspectQvdHeader(bytes);
  return {
    ...metadata,
    inspection: {
      level: 'qvd-header-only',
      completeDataValidation: false,
      warnings: [
        'Only the bounded XML header was inspected. Qlik must validate and decode the binary records.',
      ],
    },
    preview: {
      available: false,
      tables: [],
      reason: 'QVD row preview requires a Qlik Engine load.',
    },
  };
}

function countRowCharacters(row: readonly DataCell[]): number {
  return row.reduce<number>(
    (total, value) => total + (typeof value === 'string' ? value.length : 8),
    0,
  );
}

function validateHeaders(header: readonly unknown[]): string[] {
  const columns = header.map((value) => {
    if (typeof value !== 'string' || !dataIdentifierSchema.safeParse(value).success) {
      invalidUpload('Headers must be non-empty text that is safe for Qlik field references.');
    }
    return value;
  });
  if (new Set(columns).size !== columns.length)
    invalidUpload('Dataset column names must be unique.');
  return columns;
}

function parseCsvPreview(bytes: Buffer, delimiter: string, name: string): DatasetTablePreview {
  const content = strictUtf8(bytes);
  let columns: string[] | undefined;
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let inQuotes = false;
  let afterQuote = false;
  let rowStarted = false;
  let totalRowCount = 0;
  let previewCharacters = 0;
  const finishCell = () => {
    row.push(value);
    if (row.length > MAX_DATASET_COLUMNS) invalidUpload('CSV exceeds the column limit.');
    value = '';
    afterQuote = false;
  };
  const finishRow = () => {
    finishCell();
    if (!columns) {
      columns = validateHeaders(row);
    } else {
      if (row.length !== columns.length)
        invalidUpload('Every CSV row must match the header width.');
      totalRowCount += 1;
      const characters = countRowCharacters(row);
      if (
        rows.length < MAX_DATASET_PREVIEW_ROWS &&
        previewCharacters + characters <= MAX_PREVIEW_CHARACTERS
      ) {
        rows.push(row);
        previewCharacters += characters;
      }
    }
    row = [];
    rowStarted = false;
  };
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (
      character.charCodeAt(0) < 32 &&
      character !== '\t' &&
      character !== '\r' &&
      character !== '\n'
    )
      invalidUpload('CSV content contains binary or unsupported control characters.');
    if (inQuotes) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        value += character;
      }
    } else if (character === delimiter) {
      rowStarted = true;
      finishCell();
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      finishRow();
    } else if (character === '"' && value.length === 0 && !afterQuote) {
      inQuotes = true;
      rowStarted = true;
    } else {
      if (afterQuote || character === '"') invalidUpload('CSV quoting is malformed.');
      value += character;
      rowStarted = true;
    }
    if (value.length > MAX_DATASET_CELL_LENGTH)
      invalidUpload('A CSV cell exceeds the supported length.');
  }
  if (inQuotes) invalidUpload('CSV contains an unterminated quoted field.');
  if (rowStarted || row.length > 0 || value.length > 0 || afterQuote) finishRow();
  if (!columns) invalidUpload('CSV must contain a header row.');
  return { name, columns, rows, totalRowCount, truncated: rows.length < totalRowCount };
}

interface XmlParser {
  on(
    event: 'openTag',
    callback: (
      name: string,
      attributes: () => Record<string, string>,
      decode: (value: string) => string,
      selfClosing: boolean,
    ) => void,
  ): void;
  on(event: 'closeTag', callback: (name: string) => void): void;
  on(event: 'text' | 'cdata', callback: (value: string) => void): void;
  on(event: 'error' | 'warn', callback: () => void): void;
  parse(content: string): unknown;
}

function inspectXml(
  content: string,
  onOpen?: (name: string, attributes: Record<string, string>) => void,
): void {
  if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(content))
    invalidUpload('XML entity declarations are not allowed.');
  const parser: XmlParser = new Parser();
  let depth = 0;
  let roots = 0;
  let textLength = 0;
  parser.on('error', () => invalidUpload('An embedded XML document is malformed.'));
  parser.on('warn', () => invalidUpload('An embedded XML document is malformed.'));
  parser.on('openTag', (qualifiedName, getAttributes, decode) => {
    depth += 1;
    if (depth === 1) roots += 1;
    if (depth > 100 || roots > 1)
      invalidUpload('An embedded XML document exceeds the structural limits.');
    textLength = 0;
    const attributes = Object.fromEntries(
      Object.entries(getAttributes()).map(([key, value]) => [key, decode(value)]),
    );
    onOpen?.(qualifiedName.split(':').at(-1)!, attributes);
  });
  parser.on('closeTag', () => {
    depth -= 1;
    textLength = 0;
  });
  const inspectText = (value: string) => {
    textLength += value.length;
    if (textLength > MAX_DATASET_CELL_LENGTH)
      invalidUpload('An embedded XML value exceeds the supported length.');
  };
  parser.on('text', inspectText);
  parser.on('cdata', inspectText);
  parser.parse(content);
  if (depth !== 0 || roots !== 1) invalidUpload('An embedded XML document is incomplete.');
}

function inspectQvdHeader(bytes: Buffer): void {
  const marker = Buffer.from('</QvDataTableHeader>');
  const end = bytes.indexOf(marker);
  if (end < 0 || end + marker.length > 1024 * 1024) {
    invalidUpload('A bounded QVD XML header was not found.');
  }
  const header = strictUtf8(bytes.subarray(0, end + marker.length));
  let root: string | undefined;
  inspectXml(header, (name) => {
    root ??= name;
  });
  if (root !== 'QvDataTableHeader') invalidUpload('The file does not identify a QVD data table.');
}

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** Validates ZIP bounds before decompression and XML allocation before workbook parsing. */
function inspectXlsxArchive(bytes: Buffer): { hasFormulas: boolean } {
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (
      bytes.readUInt32LE(offset) === 0x0605_4b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) invalidUpload('XLSX must contain a complete ZIP archive.');
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    bytes.readUInt16LE(endOffset + 4) !== 0 ||
    bytes.readUInt16LE(endOffset + 6) !== 0 ||
    bytes.readUInt16LE(endOffset + 8) !== entryCount ||
    entryCount < 1 ||
    entryCount > MAX_XLSX_ENTRIES ||
    centralOffset + centralSize !== endOffset
  ) {
    invalidUpload('Multipart, oversized, and ZIP64 XLSX archives are not supported.');
  }
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let uncompressedTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || bytes.readUInt32LE(offset) !== 0x0201_4b50)
      invalidUpload('The XLSX ZIP directory is malformed.');
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    if (offset + 46 + nameLength + extraLength + commentLength > endOffset)
      invalidUpload('The XLSX ZIP directory is incomplete.');
    const entry: ZipEntry = {
      name: strictUtf8(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      flags: bytes.readUInt16LE(offset + 8),
      method: bytes.readUInt16LE(offset + 10),
      crc: bytes.readUInt32LE(offset + 16),
      compressedSize: bytes.readUInt32LE(offset + 20),
      uncompressedSize: bytes.readUInt32LE(offset + 24),
      localOffset: bytes.readUInt32LE(offset + 42),
    };
    if (
      !entry.name ||
      entry.name.length > 200 ||
      !/^[A-Za-z0-9_[\]./-]+$/.test(entry.name) ||
      entry.name.startsWith('/') ||
      entry.name.split('/').some((part) => part === '..' || part === '.') ||
      names.has(entry.name.toLowerCase())
    )
      invalidUpload('The XLSX archive contains unsafe or duplicate entry names.');
    if (
      entry.flags & ~0x080e ||
      ![0, 8].includes(entry.method) ||
      bytes.readUInt16LE(offset + 34) !== 0
    )
      invalidUpload('Encrypted or unsupported XLSX ZIP entries are not allowed.');
    uncompressedTotal += entry.uncompressedSize;
    if (
      entry.uncompressedSize > MAX_XLSX_ENTRY_BYTES ||
      uncompressedTotal > MAX_XLSX_UNCOMPRESSED_BYTES ||
      entry.uncompressedSize > Math.max(entry.compressedSize, 1) * MAX_XLSX_COMPRESSION_RATIO
    )
      invalidUpload('The XLSX archive exceeds the decompression limits.');
    if (
      /(?:vbaProject|externalLinks|embeddings|activeX|connections\.xml|queryTables)/i.test(
        entry.name,
      )
    )
      invalidUpload('XLSX macros, embedded objects, and external data references are not allowed.');
    entries.push(entry);
    names.add(entry.name.toLowerCase());
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (
    offset !== endOffset ||
    !names.has('[content_types].xml') ||
    !names.has('xl/workbook.xml') ||
    !names.has('xl/_rels/workbook.xml.rels')
  )
    invalidUpload('The archive is not a supported XLSX workbook.');
  let nextLocalOffset = 0;
  let hasFormulas = false;
  let workbookCells = 0;
  let worksheets = 0;
  for (const entry of [...entries].sort((left, right) => left.localOffset - right.localOffset)) {
    const local = entry.localOffset;
    if (
      local !== nextLocalOffset ||
      local + 30 > centralOffset ||
      bytes.readUInt32LE(local) !== 0x0403_4b50 ||
      bytes.readUInt16LE(local + 6) !== entry.flags ||
      bytes.readUInt16LE(local + 8) !== entry.method
    )
      invalidUpload('The XLSX archive contains inconsistent local entries.');
    const nameLength = bytes.readUInt16LE(local + 26);
    const extraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (
      dataEnd > centralOffset ||
      strictUtf8(bytes.subarray(local + 30, local + 30 + nameLength)) !== entry.name
    )
      invalidUpload('An XLSX ZIP entry is truncated or inconsistent.');
    if (
      !(entry.flags & 8) &&
      (bytes.readUInt32LE(local + 14) !== entry.crc ||
        bytes.readUInt32LE(local + 18) !== entry.compressedSize ||
        bytes.readUInt32LE(local + 22) !== entry.uncompressedSize)
    )
      invalidUpload('An XLSX ZIP entry has inconsistent sizes or checksum.');
    const compressed = bytes.subarray(dataStart, dataEnd);
    let content: Buffer;
    try {
      if (entry.method === 0) {
        content = compressed;
      } else {
        // Node's info option reports compressed bytes actually consumed. Reject
        // trailing hidden streams before handing the archive to another parser.
        const inflated = inflateRawSync(compressed, {
          maxOutputLength: Math.max(1, entry.uncompressedSize),
          info: true,
        }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (inflated.engine.bytesWritten !== compressed.length)
          invalidUpload('An XLSX ZIP entry contains trailing compressed content.');
        content = inflated.buffer;
      }
    } catch {
      invalidUpload('An XLSX ZIP entry could not be safely decompressed.');
    }
    if (content.length !== entry.uncompressedSize || crc32(content) !== entry.crc)
      invalidUpload('An XLSX ZIP entry failed its integrity check.');
    nextLocalOffset = dataEnd;
    if (entry.flags & 8) {
      const signatureLength =
        dataEnd + 4 <= centralOffset && bytes.readUInt32LE(dataEnd) === 0x0807_4b50 ? 4 : 0;
      const descriptor = dataEnd + signatureLength;
      if (
        descriptor + 12 > centralOffset ||
        bytes.readUInt32LE(descriptor) !== entry.crc ||
        bytes.readUInt32LE(descriptor + 4) !== entry.compressedSize ||
        bytes.readUInt32LE(descriptor + 8) !== entry.uncompressedSize
      )
        invalidUpload('An XLSX ZIP descriptor is inconsistent.');
      nextLocalOffset = descriptor + 12;
    }
    if (/\.(?:xml|rels)$/i.test(entry.name)) {
      const xml = strictUtf8(content);
      const isWorksheet = /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name);
      let maxRow = 0;
      let maxColumn = 0;
      let cellCount = 0;
      let rowCount = 0;
      inspectXml(xml, (name, attributes) => {
        if (
          name === 'Relationship' &&
          (attributes.TargetMode?.toLowerCase() === 'external' ||
            /^(?:[a-z]+:|\/\/)/i.test(attributes.Target ?? ''))
        )
          invalidUpload('External XLSX relationships are not allowed.');
        if (
          name === 'Override' &&
          /macroEnabled|vbaProject|oleObject/i.test(attributes.ContentType ?? '')
        )
          invalidUpload('Macro-enabled workbook content is not allowed.');
        if (!isWorksheet) return;
        if (name === 'f') hasFormulas = true;
        if (name === 'row') {
          rowCount += 1;
          if (rowCount > MAX_CSV_ROWS + 1) {
            invalidUpload('An XLSX worksheet exceeds the supported row count.');
          }
          const rowNumber = attributes.r === undefined ? rowCount : Number(attributes.r);
          if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_CSV_ROWS + 1)
            invalidUpload('An XLSX worksheet row exceeds the supported bounds.');
          maxRow = Math.max(maxRow, rowNumber);
        }
        if (name === 'c') {
          cellCount += 1;
          const match = /^([A-Z]{1,3})([1-9][0-9]{0,5})$/.exec(attributes.r ?? '');
          if (!match) invalidUpload('XLSX cells must have bounded explicit coordinates.');
          const column = [...match[1]!].reduce(
            (total, character) => total * 26 + character.charCodeAt(0) - 64,
            0,
          );
          const row = Number(match[2]);
          if (column > MAX_DATASET_COLUMNS || row > MAX_CSV_ROWS + 1)
            invalidUpload('An XLSX cell exceeds the supported bounds.');
          maxColumn = Math.max(maxColumn, column);
          maxRow = Math.max(maxRow, row);
        }
      });
      if (isWorksheet) {
        worksheets += 1;
        workbookCells += Math.max(cellCount, maxRow * maxColumn, rowCount * maxColumn);
        if (workbookCells > MAX_XLSX_CELLS || worksheets > MAX_XLSX_SHEETS)
          invalidUpload(
            'The XLSX workbook exceeds the row, column, or worksheet allocation limits.',
          );
      }
    }
  }
  if (nextLocalOffset !== centralOffset || worksheets === 0)
    invalidUpload('The XLSX workbook contains unsupported archive content.');
  return { hasFormulas };
}

/** Qlik's documented escape is a doubled closing bracket. */
export function quoteQlikIdentifier(value: string): string {
  if (!dataIdentifierSchema.safeParse(value).success)
    invalidManifest('An identifier is unsafe for a Qlik load script.');
  return `[${value.replaceAll(']', ']]')}]`;
}

export function quoteQlikLiteral(value: string): string {
  if (value.length > 200 || /[\p{Cc}\p{Cf}]/u.test(value) || value.includes('$('))
    invalidManifest('A literal is unsafe for a Qlik load script.');
  return `'${value.replaceAll("'", "''")}'`;
}

function compileField(field: DataFieldTransform): string {
  let expression = quoteQlikIdentifier(field.source);
  if (field.trim) expression = `Trim(${expression})`;
  if (field.case) expression = `${field.case === 'upper' ? 'Upper' : 'Lower'}(${expression})`;
  if (field.emptyAsNull) expression = `EmptyIsNull(${expression})`;
  if (field.nullValues?.length) {
    expression = `If(Match(${expression}, ${field.nullValues.map(quoteQlikLiteral).join(', ')}), Null(), ${expression})`;
  }
  if (field.type?.kind === 'text') expression = `Text(${expression})`;
  if (field.type?.kind === 'number')
    expression = `Num#(${expression}, ${quoteQlikLiteral(field.type.format)}, ${quoteQlikLiteral(field.type.decimalSeparator)}, ${quoteQlikLiteral(field.type.thousandSeparator)})`;
  if (field.type?.kind === 'date')
    expression = `Date(Date#(${expression}, ${quoteQlikLiteral(field.type.inputFormat)}), ${quoteQlikLiteral(field.type.outputFormat)})`;
  return `${expression} AS ${quoteQlikIdentifier(field.as ?? field.source)}`;
}

export interface CompiledDataManifest {
  readonly loadScript: string;
  readonly sha256: string;
  readonly summary: {
    readonly sourceFileCount: number;
    readonly tableCount: number;
    readonly outputTableCount: number;
    readonly fieldCount: number;
    readonly joinCount: number;
    readonly warnings: readonly string[];
  };
}

/**
 * Server-resolved files must share the target app's DataFiles scope.
 * Grammar references: Qlik Cloud LOAD format specification, NoConcatenate,
 * Combining tables with Join and Keep, and Using quotation marks in the script.
 */
export function compileDataManifest(
  input: unknown,
  approvedFiles: readonly ApprovedDataFile[],
): CompiledDataManifest {
  const parsed = dataManifestSchema.safeParse(input);
  if (!parsed.success) invalidManifest('The data manifest does not match the supported contract.');
  const manifest = parsed.data;
  const files = new Map<string, ApprovedDataFile>();
  for (const candidate of approvedFiles) {
    const result = approvedDataFileSchema.safeParse(candidate);
    if (!result.success || result.data.format !== formatFromFilename(result.data.filename))
      invalidManifest('An approved data file has inconsistent metadata.');
    if (files.has(result.data.dataFileId))
      invalidManifest('Approved data file IDs must be unique.');
    files.set(result.data.dataFileId, result.data);
  }
  const tableNames = new Set<string>();
  const outputTables = new Map<string, Set<string>>();
  const usedFileIds = new Set<string>();
  const statements: string[] = [];
  const warnings: string[] = [];
  let fieldCount = 0;
  let joinCount = 0;
  for (const table of manifest.tables) {
    if (tableNames.has(table.name)) invalidManifest('Manifest table names must be unique.');
    tableNames.add(table.name);
    const file = files.get(table.source.dataFileId);
    if (!file || file.format !== table.source.format)
      invalidManifest('A manifest source is not an approved file of the specified format.');
    usedFileIds.add(file.dataFileId);
    if (
      table.source.format === 'xlsx' &&
      file.sheetNames &&
      !file.sheetNames.includes(table.source.sheetName)
    )
      invalidManifest('The requested worksheet is not present in the approved workbook.');
    if (file.fields && table.fields.some((field) => !file.fields!.includes(field.source)))
      invalidManifest('A requested field is not present in the approved data file.');
    const fieldNames = table.fields.map((field) => field.as ?? field.source);
    if (new Set(fieldNames).size !== fieldNames.length)
      invalidManifest('Output field names must be unique within each table.');
    let prefix = `${quoteQlikIdentifier(table.name)}:\nNoConcatenate`;
    if (table.join) {
      const target = outputTables.get(table.join.targetTable);
      if (!target || table.join.targetTable === table.name)
        invalidManifest('Joins must target a previously created output table.');
      const keys = new Set(table.join.keys);
      if (
        keys.size !== table.join.keys.length ||
        table.join.keys.some((key) => !target.has(key) || !fieldNames.includes(key))
      )
        invalidManifest('Join keys must be unique fields present in both tables after transforms.');
      const commonFields = fieldNames.filter((field) => target.has(field));
      if (commonFields.length !== keys.size || commonFields.some((field) => !keys.has(field)))
        invalidManifest(
          'Rename shared non-key fields before joining; Qlik joins on all common field names.',
        );
      prefix = `${table.join.type.toUpperCase()} JOIN (${quoteQlikIdentifier(table.join.targetTable)})`;
      outputTables.set(table.join.targetTable, new Set([...target, ...fieldNames]));
      joinCount += 1;
    } else {
      outputTables.set(table.name, new Set(fieldNames));
    }
    fieldCount += table.fields.length;
    const format = sourceFormat(table.source);
    const connection = file.spaceName ? `${file.spaceName}:DataFiles` : 'DataFiles';
    const path = `[lib://${connection}/${file.folderPath ? `${file.folderPath}/` : ''}${file.filename}]`;
    statements.push(
      `${prefix}\nLOAD\n  ${table.fields.map(compileField).join(',\n  ')}\nFROM ${path}\n(${format});`,
    );
  }
  for (const [index, fields] of [...outputTables.values()].entries()) {
    for (const other of [...outputTables.values()].slice(index + 1)) {
      if ([...fields].filter((field) => other.has(field)).length > 1) {
        warnings.push(
          'Two output tables share multiple fields; review the data model for a synthetic key before reloading.',
        );
        break;
      }
    }
  }
  if (joinCount)
    warnings.push(
      'Join cardinality and missing keys require data validation; a join can multiply or remove rows.',
    );
  const loadScript = `${statements.join('\n\n')}\n`;
  return {
    loadScript,
    sha256: createHash('sha256').update(loadScript).digest('hex'),
    summary: {
      sourceFileCount: usedFileIds.size,
      tableCount: manifest.tables.length,
      outputTableCount: outputTables.size,
      fieldCount,
      joinCount,
      warnings: [...new Set(warnings)],
    },
  };
}

function sourceFormat(source: DataManifest['tables'][number]['source']): string {
  switch (source.format) {
    case 'csv':
      return `txt, utf8, embedded labels, delimiter is ${source.delimiter === '\t' ? "'\\t'" : quoteQlikLiteral(source.delimiter)}, msq`;
    case 'xlsx':
      return `ooxml, embedded labels, table is ${quoteQlikIdentifier(source.sheetName)}`;
    case 'qvd':
      return 'qvd';
  }
}

type DetectedType = 'text' | 'number' | 'boolean' | 'date';

function isMissing(value: DataCell): boolean {
  return value === null || (typeof value === 'string' && value.trim().length === 0);
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function detectedType(value: Exclude<DataCell, null>): DetectedType {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return 'boolean';
  if (isIsoDate(trimmed)) return 'date';
  // Leading-zero identifiers remain text; do not silently erase their semantics.
  if (
    /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed) &&
    Number.isFinite(Number(trimmed))
  )
    return 'number';
  return 'text';
}

export interface DataQualitySummary {
  readonly scope: 'supplied-rows';
  readonly rowCount: number;
  readonly columnCount: number;
  readonly duplicateRows: number;
  readonly missingCells: number;
  readonly columns: readonly {
    readonly name: string;
    readonly missingCount: number;
    readonly distinctNonMissingCount: number;
    readonly inferredType: DetectedType | 'mixed' | 'unknown';
    readonly expectedType?: DetectedType;
    readonly typeMismatchCount: number;
  }[];
  readonly keys?: { readonly duplicateKeyRows: number; readonly rowsWithMissingKey: number };
}

/** Aggregates only caller-supplied rows. It never implies full dataset quality. */
export function profileDataRows(input: unknown): DataQualitySummary {
  const parsed = dataQualityRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new DataPreparationError(
      'invalid-sample',
      'The supplied data sample does not match the bounded row contract.',
    );
  const { columns, rows, keyFields } = parsed.data;
  const seenRows = new Set<string>();
  let duplicateRows = 0;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    if (seenRows.has(encoded)) duplicateRows += 1;
    seenRows.add(encoded);
  }
  const qualityColumns = columns.map((column, index) => {
    const distinct = new Set<string>();
    const types = new Set<DetectedType>();
    let missingCount = 0;
    let typeMismatchCount = 0;
    for (const row of rows) {
      const cell = row[index]!;
      if (isMissing(cell)) {
        missingCount += 1;
        continue;
      }
      const type = detectedType(cell as Exclude<DataCell, null>);
      types.add(type);
      distinct.add(JSON.stringify(cell));
      if (column.expectedType && column.expectedType !== 'text' && type !== column.expectedType)
        typeMismatchCount += 1;
    }
    const inferredType: DetectedType | 'mixed' | 'unknown' =
      types.size === 0 ? 'unknown' : types.size > 1 ? 'mixed' : [...types][0]!;
    return {
      name: column.name,
      missingCount,
      distinctNonMissingCount: distinct.size,
      inferredType,
      ...(column.expectedType ? { expectedType: column.expectedType } : {}),
      typeMismatchCount,
    };
  });
  let keys: DataQualitySummary['keys'];
  if (keyFields) {
    const indices = keyFields.map((name) => columns.findIndex((column) => column.name === name));
    const seen = new Set<string>();
    let duplicateKeyRows = 0;
    let rowsWithMissingKey = 0;
    for (const row of rows) {
      const values = indices.map((index) => row[index]!);
      if (values.some(isMissing)) {
        rowsWithMissingKey += 1;
        continue;
      }
      const encoded = JSON.stringify(values);
      if (seen.has(encoded)) duplicateKeyRows += 1;
      seen.add(encoded);
    }
    keys = { duplicateKeyRows, rowsWithMissingKey };
  }
  return {
    scope: 'supplied-rows',
    rowCount: rows.length,
    columnCount: columns.length,
    duplicateRows,
    missingCells: qualityColumns.reduce((total, column) => total + column.missingCount, 0),
    columns: qualityColumns,
    ...(keys ? { keys } : {}),
  };
}
