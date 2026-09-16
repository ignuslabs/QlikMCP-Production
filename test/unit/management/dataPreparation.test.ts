import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  dataManifestSchema,
  datasetUploadSchema,
  MAX_DATASET_UPLOAD_BYTES,
  type ApprovedDataFile,
} from '../../../src/management/dataContracts.js';
import {
  compileDataManifest,
  DataPreparationError,
  profileDataRows,
  quoteQlikIdentifier,
  quoteQlikLiteral,
  validateDatasetUpload,
} from '../../../src/management/dataPreparation.js';

function csv(content: string, overrides: Record<string, unknown> = {}) {
  return {
    filename: 'sales.csv',
    mimeType: 'text/csv',
    contentBase64: Buffer.from(content).toString('base64'),
    ...overrides,
  };
}

function checksum(bytes: Buffer): number {
  let result = 0xffff_ffff;
  for (const value of bytes) {
    result ^= value;
    for (let index = 0; index < 8; index += 1) {
      result = (result >>> 1) ^ ((result & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return (result ^ 0xffff_ffff) >>> 0;
}

/** Small independent OOXML test fixture; no fixture generation dependency. */
function zip(entries: Record<string, string>, compress = false): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let localOffset = 0;
  for (const [filename, value] of Object.entries(entries)) {
    const name = Buffer.from(filename);
    const bytes = Buffer.from(value);
    const content = compress ? deflateRawSync(bytes) : bytes;
    const crc = checksum(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x0403_4b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(compress ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x0201_4b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(compress ? 8 : 0, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(content.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(localOffset, 42);
    central.push(directory, name);
    localOffset += header.length + name.length + content.length;
  }
  const body = Buffer.concat(local);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

function workbookEntries(sheetOverride?: string): Record<string, string> {
  return {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      sheetOverride ??
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>  Alice  </t></is></c><c r="B2"><v>1234567890123456.12</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Bob</t></is></c><c r="B3"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
  };
}

function xlsx(bytes = zip(workbookEntries())) {
  return {
    filename: 'sales.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    contentBase64: bytes.toString('base64'),
  };
}

const approvedFiles: ApprovedDataFile[] = [
  {
    dataFileId: 'orders-file',
    filename: 'orders.csv',
    format: 'csv',
    fields: ['OrderID', 'CustomerID', 'Amount', 'Name', 'Day'],
  },
  {
    dataFileId: 'customers-file',
    filename: 'customers.xlsx',
    format: 'xlsx',
    fields: ['ID', 'Customer', 'Name'],
    sheetNames: ['Customers'],
  },
  { dataFileId: 'history-file', filename: 'history.qvd', format: 'qvd' },
];

function manifest() {
  return {
    version: 1,
    tables: [
      {
        name: 'Orders',
        source: { format: 'csv', dataFileId: 'orders-file' },
        fields: [{ source: 'OrderID' }, { source: 'CustomerID' }, { source: 'Amount' }],
      },
    ],
  };
}

describe('validated dataset uploads', () => {
  it('parses BOM, escaped quotes, CRLF, multiline values, blanks, and reports the exact checksum', async () => {
    const content =
      '\ufeffID,Name,Notes\r\n001,"Ada, A","He said ""yes"""\r\n002,Bob,"two\nlines"\r\n003,,\r\n';
    const input = csv(content);
    const result = await validateDatasetUpload(input);
    expect(result.inspection).toEqual({
      level: 'parsed-csv',
      completeDataValidation: true,
      warnings: [],
    });
    expect(result.sha256).toBe(createHash('sha256').update(Buffer.from(content)).digest('hex'));
    expect(result.bytes.equals(Buffer.from(content))).toBe(true);
    expect(result.preview.tables[0]).toEqual({
      name: 'sales.csv',
      columns: ['ID', 'Name', 'Notes'],
      rows: [
        ['001', 'Ada, A', 'He said "yes"'],
        ['002', 'Bob', 'two\nlines'],
        ['003', '', ''],
      ],
      totalRowCount: 3,
      truncated: false,
    });
  });

  it('supports explicit delimiters and scans beyond the bounded preview', async () => {
    const content = `ID;Value\n${Array.from({ length: 100_005 }, (_, index) => `${index};OK`).join('\n')}\n`;
    const result = await validateDatasetUpload(csv(content, { csvDelimiter: ';' }));
    expect(result.preview.tables[0]?.rows).toHaveLength(50);
    expect(result.preview.tables[0]?.totalRowCount).toBe(100_005);
    expect(result.preview.tables[0]?.truncated).toBe(true);
    await expect(
      validateDatasetUpload(csv(`${content}BAD\n`, { csvDelimiter: ';' })),
    ).rejects.toThrow('header width');
  });

  it.each([
    '../sales.csv',
    '/sales.csv',
    '.sales.csv',
    'x/../sales.csv',
    'sales.csv.exe',
    'sales$(x).csv',
    'sales*.csv',
    'sales\u0000.csv',
    'sales.csv ',
    'folder\\sales.csv',
  ])('rejects unsafe filename %s', async (filename) => {
    await expect(validateDatasetUpload(csv('a\n1', { filename }))).rejects.toBeInstanceOf(
      DataPreparationError,
    );
  });

  it.each(['YQ', 'YR==', 'YQ==\n', 'YQ-=', 'YQ======', '===='])(
    'rejects noncanonical base64 %s',
    async (contentBase64) => {
      await expect(validateDatasetUpload(csv('a\n1', { contentBase64 }))).rejects.toBeInstanceOf(
        DataPreparationError,
      );
    },
  );

  it.each([
    'a,b\n1',
    'a,b\n1,2,3',
    'a,a\n1,2',
    ',b\n1,2',
    'a\n"bad',
    'a\n"bad"tail',
    'a\nmid"quote',
    'a\n\u0000',
    '$(include=bad),b\n1,2',
  ])('rejects malformed or unsafe CSV without leaking its values', async (content) => {
    await expect(validateDatasetUpload(csv(content))).rejects.toBeInstanceOf(DataPreparationError);
  });

  it('rejects binary bytes, wrong MIME, mismatched checksums, and unknown properties', async () => {
    await expect(
      validateDatasetUpload(
        csv('a\n1', { contentBase64: Buffer.from([0xff, 0xfe, 0, 0]).toString('base64') }),
      ),
    ).rejects.toThrow('UTF-8');
    await expect(
      validateDatasetUpload(csv('a\n1', { mimeType: 'application/octet-stream' })),
    ).rejects.toThrow('MIME');
    await expect(
      validateDatasetUpload(csv('a\n1', { expectedSha256: '0'.repeat(64) })),
    ).rejects.toThrow('checksum');
    await expect(
      validateDatasetUpload(csv('a\n1', { rawScript: 'EXECUTE injected' })),
    ).rejects.toThrow('metadata');
    expect(MAX_DATASET_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(datasetUploadSchema.shape.contentBase64.maxLength).toBe(
      4 * Math.ceil(MAX_DATASET_UPLOAD_BYTES / 3),
    );
  });

  it.each([false, true])(
    'decodes real XLSX content with compression=%s, preserving decimal precision and whitespace',
    async (compress) => {
      const result = await validateDatasetUpload(xlsx(zip(workbookEntries(), compress)));
      expect(result.inspection.level).toBe('parsed-xlsx');
      expect(result.inspection.warnings.join(' ')).toContain('cached');
      expect(result.preview.tables).toEqual([
        {
          name: 'Sales',
          columns: ['Name', 'Amount'],
          rows: [
            ['  Alice  ', '1234567890123456.12'],
            ['Bob', '2'],
          ],
          totalRowCount: 2,
          truncated: false,
        },
      ]);
    },
  );

  it('does not accept a ZIP signature as evidence of a workbook', async () => {
    await expect(
      validateDatasetUpload(xlsx(Buffer.from('PK\u0003\u0004fake workbook'))),
    ).rejects.toThrow('complete ZIP');
    await expect(
      validateDatasetUpload(xlsx(zip({ 'hello.txt': 'not a workbook' }))),
    ).rejects.toThrow('supported XLSX');
  });

  it('rejects ZIP path traversal, encrypted entries, inconsistent CRCs, and truncated archives', async () => {
    await expect(
      validateDatasetUpload(xlsx(zip({ ...workbookEntries(), '../secret.xml': '<x/>' }))),
    ).rejects.toThrow('entry names');
    const encrypted = zip(workbookEntries());
    encrypted.writeUInt16LE(1, 6);
    await expect(validateDatasetUpload(xlsx(encrypted))).rejects.toThrow('inconsistent');
    const corrupt = zip(workbookEntries());
    corrupt[100] = corrupt[100]! ^ 1;
    await expect(validateDatasetUpload(xlsx(corrupt))).rejects.toThrow('integrity');
    await expect(
      validateDatasetUpload(xlsx(zip(workbookEntries()).subarray(0, -10))),
    ).rejects.toThrow('complete ZIP');
  });

  it('rejects compressed expansion, oversized sparse coordinates, and XML entity declarations before workbook parsing', async () => {
    await expect(
      validateDatasetUpload(
        xlsx(
          zip({ ...workbookEntries(), 'xl/oversized.xml': `<x>${' '.repeat(100_000)}</x>` }, true),
        ),
      ),
    ).rejects.toThrow('decompression');
    await expect(
      validateDatasetUpload(
        xlsx(
          zip(
            workbookEntries(
              '<worksheet><sheetData><row r="999999999"><c r="A999999999"><v>1</v></c></row></sheetData></worksheet>',
            ),
          ),
        ),
      ),
    ).rejects.toThrow('bounds');
    await expect(
      validateDatasetUpload(
        xlsx(
          zip(
            workbookEntries(
              '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///secret">]><worksheet><sheetData/></worksheet>',
            ),
          ),
        ),
      ),
    ).rejects.toThrow('entity declarations');
    await expect(
      validateDatasetUpload(
        xlsx(
          zip(
            workbookEntries(
              '<worksheet><sheetData><row r="100000"><c r="GR100000"><v>1</v></c></row></sheetData></worksheet>',
            ),
          ),
        ),
      ),
    ).rejects.toThrow('allocation');
  });

  it('rejects macro payloads, XML macros disguised by content type, and encoded external relationships', async () => {
    await expect(
      validateDatasetUpload(xlsx(zip({ ...workbookEntries(), 'xl/vbaProject.bin': 'payload' }))),
    ).rejects.toThrow('macros');
    const entries = workbookEntries();
    entries['xl/_rels/workbook.xml.rels'] = entries['xl/_rels/workbook.xml.rels']!.replace(
      'Target="worksheets/sheet1.xml"',
      'Target="https:&#47;&#47;attacker.invalid/data" TargetMode="Ext&#101;rnal"',
    );
    await expect(validateDatasetUpload(xlsx(zip(entries)))).rejects.toThrow('External');
    const macro = workbookEntries();
    macro['[Content_Types].xml'] = macro['[Content_Types].xml']!.replace(
      'spreadsheetml.sheet.main+xml',
      'ms-excel.sheet.macroEnabled.main+xml',
    );
    await expect(validateDatasetUpload(xlsx(zip(macro)))).rejects.toThrow('Macro-enabled');
  });

  it('marks QVD inspection as header-only and requires Qlik for row preview', async () => {
    const result = await validateDatasetUpload({
      filename: 'history.qvd',
      mimeType: 'application/octet-stream',
      contentBase64: Buffer.concat([
        Buffer.from(
          '<?xml version="1.0"?><QvDataTableHeader><NoOfRecords>1</NoOfRecords></QvDataTableHeader>',
        ),
        Buffer.from([0, 255, 3]),
      ]).toString('base64'),
    });
    expect(result.inspection).toMatchObject({
      level: 'qvd-header-only',
      completeDataValidation: false,
    });
    expect(result.preview).toMatchObject({ available: false, tables: [] });
    await expect(
      validateDatasetUpload({
        filename: 'history.qvd',
        mimeType: 'application/octet-stream',
        contentBase64: Buffer.from('<foo>not qvd</foo>').toString('base64'),
      }),
    ).rejects.toThrow('header');
  });
});

describe('Qlik manifest compiler', () => {
  it('qualifies verified space names and keeps personal-space references unqualified', () => {
    const input = manifest();
    const shared = approvedFiles.map((file) => ({ ...file, spaceName: "Finance's East; Team" }));
    expect(compileDataManifest(input, shared).loadScript).toContain(
      "FROM [lib://Finance's East; Team:DataFiles/orders.csv]",
    );
    expect(compileDataManifest(input, approvedFiles).loadScript).toContain(
      'FROM [lib://DataFiles/orders.csv]',
    );
    for (const spaceName of [
      '',
      ' ',
      ' East',
      'East ',
      'East:DataFiles',
      'East/Other',
      'East\\Other',
      'East[Other]',
      'East]; DROP TABLE Sales;',
      'East$(include=bad)',
      'East\nTeam',
      'East\u200bTeam',
      'E\u0301quipe',
      'x'.repeat(257),
    ]) {
      expect(() =>
        compileDataManifest(
          input,
          approvedFiles.map((file) => ({ ...file, spaceName })),
        ),
      ).toThrow('approved data file');
    }
  });

  it('resolves identical basenames through verified DataFiles folders and rejects path injection', () => {
    const files: ApprovedDataFile[] = [
      {
        dataFileId: 'current',
        filename: 'sales.csv',
        spaceName: 'Revenue Team',
        folderPath: 'Revenue/Current Year',
        format: 'csv',
      },
      {
        dataFileId: 'prior',
        filename: 'sales.csv',
        spaceName: 'Revenue Team',
        folderPath: 'Revenue/Prior Year',
        format: 'csv',
      },
    ];
    const input = {
      version: 1,
      tables: [
        {
          name: 'Current',
          source: { format: 'csv', dataFileId: 'current' },
          fields: [{ source: 'Amount' }],
        },
        {
          name: 'Prior',
          source: { format: 'csv', dataFileId: 'prior' },
          fields: [{ source: 'Amount', as: 'PriorAmount' }],
        },
      ],
    };
    const result = compileDataManifest(input, files);
    expect(result.loadScript).toContain(
      'FROM [lib://Revenue Team:DataFiles/Revenue/Current Year/sales.csv]',
    );
    expect(result.loadScript).toContain(
      'FROM [lib://Revenue Team:DataFiles/Revenue/Prior Year/sales.csv]',
    );
    for (const folderPath of [
      '../Revenue',
      'Revenue/../Other',
      '/Revenue',
      'Revenue//Other',
      'Revenue/',
      'Revenue\\Other',
      'Revenue/$(include=bad)',
      'Revenue/x]; DROP TABLE Sales;',
      'Revenue/x\n',
      'Revenue/x%2fy',
      'Revenue/x ',
    ]) {
      expect(() => compileDataManifest(input, [{ ...files[0]!, folderPath }, files[1]!])).toThrow(
        'approved data file',
      );
    }
  });

  it('compiles only approved DataFiles and returns a content-free summary', () => {
    const result = compileDataManifest(manifest(), approvedFiles);
    expect(result.loadScript).toContain('[Orders]:\nNoConcatenate\nLOAD');
    expect(result.loadScript).toContain(
      "FROM [lib://DataFiles/orders.csv]\n(txt, utf8, embedded labels, delimiter is ',', msq);",
    );
    expect(result.sha256).toBe(createHash('sha256').update(result.loadScript).digest('hex'));
    expect(result.summary).toEqual({
      sourceFileCount: 1,
      tableCount: 1,
      outputTableCount: 1,
      fieldCount: 3,
      joinCount: 0,
      warnings: [],
    });
    expect(JSON.stringify(result.summary)).not.toContain('OrderID');
  });

  it('compiles ordered trim, case, empty, null, and explicit type/date transforms', () => {
    const input = {
      version: 1,
      tables: [
        {
          name: 'Orders',
          source: { format: 'csv', dataFileId: 'orders-file', delimiter: '\t' },
          fields: [
            {
              source: 'Name',
              as: 'Customer',
              trim: true,
              case: 'upper',
              emptyAsNull: true,
              nullValues: ["N'A"],
              type: { kind: 'text' },
            },
            {
              source: 'Amount',
              type: {
                kind: 'number',
                format: '#,##0.##############',
                decimalSeparator: '.',
                thousandSeparator: ',',
              },
            },
            {
              source: 'Day',
              type: { kind: 'date', inputFormat: 'DD/MM/YYYY', outputFormat: 'YYYY-MM-DD' },
            },
          ],
        },
      ],
    };
    const { loadScript } = compileDataManifest(input, approvedFiles);
    expect(loadScript).toContain(
      "Text(If(Match(EmptyIsNull(Upper(Trim([Name]))), 'N''A'), Null(), EmptyIsNull(Upper(Trim([Name]))))) AS [Customer]",
    );
    expect(loadScript).toContain("Num#([Amount], '#,##0.##############', '.', ',') AS [Amount]");
    expect(loadScript).toContain("Date(Date#([Day], 'DD/MM/YYYY'), 'YYYY-MM-DD') AS [Day]");
    expect(loadScript).toContain("delimiter is '\\t'");
  });

  it('escapes Qlik names/literals and rejects preprocessing expansion or controls', () => {
    expect(quoteQlikIdentifier('Total] AS x; DROP TABLE [Revenue')).toBe(
      '[Total]] AS x; DROP TABLE [Revenue]',
    );
    expect(quoteQlikLiteral("x'; DROP TABLE [Revenue]; //")).toBe(
      "'x''; DROP TABLE [Revenue]; //'",
    );
    for (const payload of ['$(include=malicious)', 'x$(v)', 'x\nDROP TABLE x', 'x\u200b']) {
      expect(() => quoteQlikIdentifier(payload)).toThrow(DataPreparationError);
      expect(() => quoteQlikLiteral(payload)).toThrow(DataPreparationError);
    }
    const file: ApprovedDataFile = { dataFileId: 'safe', filename: 'safe.csv', format: 'csv' };
    const result = compileDataManifest(
      {
        version: 1,
        tables: [
          {
            name: 'A]B',
            source: { format: 'csv', dataFileId: 'safe' },
            fields: [{ source: 'x]y', as: 'Out]put' }],
          },
        ],
      },
      [file],
    );
    expect(result.loadScript).toContain('[A]]B]:');
    expect(result.loadScript).toContain('[x]]y] AS [Out]]put]');
  });

  it('joins on explicit transformed keys and requires a prior target', () => {
    const input = {
      version: 1,
      tables: [
        ...manifest().tables,
        {
          name: 'Customers',
          source: { format: 'xlsx', dataFileId: 'customers-file', sheetName: 'Customers' },
          fields: [{ source: 'ID', as: 'CustomerID' }, { source: 'Customer' }],
          join: { type: 'left', targetTable: 'Orders', keys: ['CustomerID'] },
        },
      ],
    };
    const result = compileDataManifest(input, approvedFiles);
    expect(result.loadScript).toContain('LEFT JOIN ([Orders])\nLOAD\n  [ID] AS [CustomerID]');
    expect(result.loadScript).toContain('(ooxml, embedded labels, table is [Customers]);');
    expect(result.summary).toMatchObject({ tableCount: 2, outputTableCount: 1, joinCount: 1 });
    expect(() =>
      compileDataManifest({ ...input, tables: [...input.tables].reverse() }, approvedFiles),
    ).toThrow('previously');
  });

  it('rejects Cartesian joins, accidental natural keys, duplicate aliases, and unknown sources/fields', () => {
    const common = {
      name: 'Second',
      source: { format: 'csv', dataFileId: 'orders-file' },
      fields: [{ source: 'OrderID' }, { source: 'CustomerID' }],
      join: { type: 'inner', targetTable: 'Orders', keys: ['CustomerID'] },
    };
    expect(() =>
      compileDataManifest({ version: 1, tables: [...manifest().tables, common] }, approvedFiles),
    ).toThrow('non-key');
    expect(() =>
      compileDataManifest(
        {
          version: 1,
          tables: [...manifest().tables, { ...common, join: { ...common.join, keys: [] } }],
        },
        approvedFiles,
      ),
    ).toThrow('contract');
    expect(() =>
      compileDataManifest(
        {
          version: 1,
          tables: [
            {
              ...manifest().tables[0],
              fields: [
                { source: 'OrderID', as: 'Same' },
                { source: 'CustomerID', as: 'Same' },
              ],
            },
          ],
        },
        approvedFiles,
      ),
    ).toThrow('unique');
    expect(() => compileDataManifest(manifest(), [])).toThrow('approved');
    expect(() =>
      compileDataManifest(
        { version: 1, tables: [{ ...manifest().tables[0], fields: [{ source: 'Missing' }] }] },
        approvedFiles,
      ),
    ).toThrow('requested field');
    expect(
      dataManifestSchema.safeParse({ ...manifest(), rawScript: 'DROP TABLE Orders;' }).success,
    ).toBe(false);
  });

  it('supports QVD loading and warns about synthetic keys in separate tables', () => {
    const result = compileDataManifest(
      {
        version: 1,
        tables: [
          ...manifest().tables,
          {
            name: 'History',
            source: { format: 'qvd', dataFileId: 'history-file' },
            fields: [{ source: 'OrderID' }, { source: 'CustomerID' }],
          },
        ],
      },
      approvedFiles,
    );
    expect(result.loadScript).toContain('FROM [lib://DataFiles/history.qvd]\n(qvd);');
    expect(result.summary.warnings.join(' ')).toContain('synthetic key');
  });
});

describe('bounded data quality summaries', () => {
  it('counts missing, duplicate rows/keys, strict numeric/date types, and preserves leading-zero IDs', () => {
    const result = profileDataRows({
      columns: [
        { name: 'ID' },
        { name: 'Amount', expectedType: 'number' },
        { name: 'Day', expectedType: 'date' },
      ],
      rows: [
        ['001', '12.5', '2024-02-29'],
        ['001', '12.5', '2024-02-29'],
        ['002', '', '2025-02-29'],
        [null, 'oops', '2026-01-01'],
      ],
      keyFields: ['ID'],
    });
    expect(result.scope).toBe('supplied-rows');
    expect(result).toMatchObject({
      rowCount: 4,
      columnCount: 3,
      duplicateRows: 1,
      missingCells: 2,
      keys: { duplicateKeyRows: 1, rowsWithMissingKey: 1 },
    });
    expect(result.columns[0]).toMatchObject({
      inferredType: 'text',
      missingCount: 1,
      distinctNonMissingCount: 2,
    });
    expect(result.columns[1]).toMatchObject({
      inferredType: 'mixed',
      missingCount: 1,
      typeMismatchCount: 1,
    });
    expect(result.columns[2]).toMatchObject({ inferredType: 'mixed', typeMismatchCount: 1 });
    expect(JSON.stringify(result)).not.toContain('oops');
    expect(JSON.stringify(result)).not.toContain('2025-02-29');
  });

  it('keeps typed values distinct, handles empty samples, and never reports population quality', () => {
    const result = profileDataRows({
      columns: [{ name: 'Key' }, { name: 'Flag', expectedType: 'boolean' }],
      rows: [
        [1, true],
        ['1', 'TRUE'],
        ['', false],
      ],
      keyFields: ['Key'],
    });
    expect(result.duplicateRows).toBe(0);
    expect(result.keys?.duplicateKeyRows).toBe(0);
    expect(result.columns[1]?.typeMismatchCount).toBe(0);
    expect(
      profileDataRows({ columns: [{ name: 'Empty' }], rows: [] }).columns[0]?.inferredType,
    ).toBe('unknown');
  });

  it('rejects ragged/oversized rows, unknown/duplicate keys, nonfinite values, nested content, and unknown options', () => {
    const sample = { columns: [{ name: 'ID' }], rows: [[1]] };
    for (const input of [
      { ...sample, rows: [[1, 2]] },
      { ...sample, rows: [[Number.NaN]] },
      { ...sample, rows: [[{ secret: 'value' }]] },
      { ...sample, keyFields: ['Missing'] },
      { ...sample, keyFields: ['ID', 'ID'] },
      { ...sample, populationVerified: true },
      { ...sample, rows: Array.from({ length: 5001 }, () => [1]) },
      {
        columns: Array.from({ length: 200 }, (_, index) => ({ name: `c${index}` })),
        rows: Array.from({ length: 501 }, () => Array.from({ length: 200 }, () => 1)),
      },
    ])
      expect(() => profileDataRows(input)).toThrow(DataPreparationError);
  });
});
