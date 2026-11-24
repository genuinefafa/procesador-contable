/**
 * Bronze bank statements: ICBC parsers, append-only import and API.
 *
 * Fictitious data only (CUITs from CLAUDE.md, invented accounts and amounts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { getRawDb } from '../../database/db.js';
import { cleanupTestDb, runTestMigrations, resetTestDb } from '../../database/db-test.js';
import { BankRepository } from '../../database/repositories/bank.js';
import { parseIcbcApiJson } from '../../parsers/icbc-api.js';
import { parseIcbcStatementText } from '../../parsers/icbc-pdf.js';
import { BankImportService } from '../../services/bank-import.service.js';
import { app } from '../../http/app.js';

vi.mock('pdf-parse', () => ({
  default: async (bytes: Buffer) => ({ text: bytes.toString('utf-8').replace('%PDF-fake\n', '') }),
}));

const ACCOUNT = '0001/00000001/01';

interface Line {
  date: string;
  concept: string;
  valueDate?: string;
  ticket?: string;
  channel?: string;
  amount: string;
  balance?: string;
}

/** Same fixed-width layout as the real statement (120 columns). */
function pdfLine(l: Line): string {
  const head =
    l.date.padEnd(6) +
    l.concept.padEnd(27) +
    (l.valueDate ?? '').padEnd(6) +
    (l.ticket ?? '').padEnd(14) +
    '0001'.padEnd(5) +
    (l.channel ?? '').padEnd(4);
  return (head.padEnd(62) + l.amount.padStart(20) + (l.balance ?? '').padStart(30)).padEnd(120);
}

const LINES: Line[] = [
  { date: '02-01', concept: 'MANTENIMIENTO DE CUENTA', valueDate: '31-12', amount: '100,00-' },
  {
    date: '02-01',
    concept: 'TRANS PAG PROV',
    ticket: '1000001',
    channel: 'DNET',
    amount: '1.500,50',
  },
  {
    date: '09-01',
    concept: 'TR.0000001  A 0001/0000002',
    ticket: 'MTA0000000001',
    channel: 'DNET',
    amount: '400,25-',
    balance: '2.000,25',
  },
];

function copy(lines: Line[], opening: string, closing: string): string {
  return [
    'RESUMEN MENSUAL',
    'PERIODO 01-01-2026 AL 31-01-2026',
    'CUIT N° 30-12345678-9',
    `INFORMACION SOBRE SU CUENTA CORRIENTE EN PESOS      N° ${ACCOUNT} C.B.U.: 0`,
    `SALDO ULTIMO EXTRACTO AL 31/12/2025          ${opening}`,
    ...lines.map(pdfLine),
    `TOT.LEY COMP.$ 1,00(*) SALDO FINAL AL 31/01/2026          ${closing}`,
    'SALDO PAGINA ANTERIOR          2.000,25',
  ].join('\n');
}

const statement = (lines = LINES, closing = '2.000,25'): string =>
  [copy(lines, '1.000,00', closing), copy(lines, '1.000,00', closing)].join('\n');

// 2026-03-10T00:00 in Argentina
const MARCH_10 = Date.UTC(2026, 2, 10, 3);

function element(n: number, over: Record<string, unknown> = {}) {
  return {
    action: { primaryAction: 'go_details' },
    transactionNumber: String(n),
    accountNumber: ACCOUNT,
    accountantDate: MARCH_10,
    dateValue: MARCH_10,
    dateHourOp: MARCH_10 + 10 * 3600_000,
    concept: 'TR. A CTA ',
    transactionCode: '978',
    ticketNumber: '1000001',
    amount: -1500.5,
    transactionBalance: '1.000,25',
    channel: 'DATANET',
    beneficiary: 'PERSONA DE PRUEBA',
    docNumber: '20-12345678-9',
    cbu: null,
    bankOrdOut: null,
    reasonCode: '09',
    reason: 'HABERES',
    ...over,
  };
}

const response = (elements: unknown[], body: Record<string, unknown> = {}) => ({
  state: 'OK',
  body: { elements, hasMoreElements: false, totalElementCount: elements.length, ...body },
});
const bytes = (json: unknown) => Buffer.from(JSON.stringify(json));
const pdfBytes = (text: string) => Buffer.from(`%PDF-fake\n${text}`);

describe('ICBC statement parser', () => {
  it('parses columns, signs, dates and keeps the raw line', () => {
    const p = parseIcbcStatementText(statement());
    expect(p).toMatchObject({
      source: 'icbc_pdf',
      account: ACCOUNT,
      holderCuit: '30123456789',
      periodFrom: '2026-01-01',
      periodTo: '2026-01-31',
      openingBalance: 1000,
      closingBalance: 2000.25,
    });
    expect(p.rows).toHaveLength(3);
    expect(p.rows[0]).toMatchObject({
      date: '2026-01-02',
      valueDate: '2025-12-31',
      concept: 'MANTENIMIENTO DE CUENTA',
      ticket: null,
      amount: -100,
      balance: null,
      rowKey: '2026-01#1',
      raw: pdfLine(LINES[0]!),
    });
    expect(p.rows[1]).toMatchObject({ ticket: '1000001', channel: 'DNET', amount: 1500.5 });
    expect(p.rows[2]).toMatchObject({
      concept: 'TR.0000001  A 0001/0000002',
      ticket: 'MTA0000000001',
      amount: -400.25,
      balance: 2000.25,
    });
  });

  it('rejects a statement that does not close', () => {
    expect(() => parseIcbcStatementText(statement(LINES, '2.000,26'))).toThrow('no cierra');
  });

  it('rejects copies that differ', () => {
    const other = LINES.map((l, i) => (i === 1 ? { ...l, ticket: '1000009' } : l));
    const text = [copy(LINES, '1.000,00', '2.000,25'), copy(other, '1.000,00', '2.000,25')].join(
      '\n'
    );
    expect(() => parseIcbcStatementText(text)).toThrow('copias');
  });

  it('rejects other documents', () => {
    expect(() => parseIcbcStatementText('FACTURA A 0001-00000001')).toThrow('no es un resumen');
  });
});

describe('ICBC API parser', () => {
  it('maps the fields, with dates in Argentina time', () => {
    const p = parseIcbcApiJson(response([element(10)]));
    expect(p).toMatchObject({ source: 'icbc_api', account: ACCOUNT, periodFrom: '2026-03-10' });
    expect(p.rows[0]).toMatchObject({
      rowKey: '10',
      date: '2026-03-10',
      valueDate: '2026-03-10',
      operatedAt: '2026-03-10T10:00:00',
      concept: 'TR. A CTA',
      conceptCode: '978',
      ticket: '1000001',
      amount: -1500.5,
      balance: 1000.25,
      counterpartTaxId: '20123456789',
      reasonCode: '09',
      reason: 'HABERES',
      raw: JSON.stringify(element(10)),
    });
  });

  it('rejects incomplete, repeated or unrelated responses', () => {
    expect(() => parseIcbcApiJson(response([element(1)], { hasMoreElements: true }))).toThrow(
      'incompleta'
    );
    expect(() => parseIcbcApiJson(response([element(1)], { totalElementCount: 2 }))).toThrow(
      'incompleta'
    );
    expect(() => parseIcbcApiJson(response([element(1), element(1)]))).toThrow('repetido');
    expect(() => parseIcbcApiJson({ state: 'ERROR' })).toThrow('no es una respuesta');
  });
});

describe('bronze import', () => {
  beforeAll(async () => {
    cleanupTestDb();
    await runTestMigrations();
  });
  beforeEach(() => resetTestDb());
  afterEach(() => vi.unstubAllEnvs());

  const service = () => new BankImportService();
  const repo = () => new BankRepository();

  it('stores each source with its own rows and origin', async () => {
    const pdf = await service().importFile(pdfBytes(statement()), 'enero.pdf');
    const api = await service().importFile(bytes(response([element(1)])), 'api.json');
    expect(pdf).toMatchObject({ newRows: 3, alreadyImported: false });
    const rows = repo().listMovements();
    expect(rows.map((r) => r.source)).toEqual(['icbc_pdf', 'icbc_pdf', 'icbc_pdf', 'icbc_api']);
    expect(rows[3]).toMatchObject({ importId: api.import.id, rowNumber: 1 });
    expect(repo().listMovements({ importId: pdf.import.id })).toHaveLength(3);
  });

  it('does nothing when the same file is imported again', async () => {
    await service().importFile(pdfBytes(statement()), 'enero.pdf');
    const again = await service().importFile(pdfBytes(statement()), 'copia.pdf');
    expect(again).toMatchObject({ alreadyImported: true, newRows: 0, knownRows: 3 });
    expect(repo().listImports()).toHaveLength(1);
  });

  it('adds only the new rows of an overlapping API download', async () => {
    await service().importFile(bytes(response([element(1), element(2)])), 'a.json');
    const next = await service().importFile(bytes(response([element(2), element(3)])), 'b.json');
    expect(next).toMatchObject({ newRows: 1, knownRows: 1, changedRows: 0 });
    expect(
      repo()
        .listMovements()
        .map((r) => r.rowKey)
    ).toEqual(['1', '2', '3']);
  });

  it('ignores UI actions and key order, and versions real changes', async () => {
    const { action: _action, ...rest } = element(1);
    await service().importFile(bytes(response([element(1)])), 'a.json');
    const same = await service().importFile(
      bytes(response([Object.fromEntries(Object.entries(rest).reverse())])),
      'b.json'
    );
    expect(same.newRows).toBe(0);
    const changed = await service().importFile(
      bytes(response([element(1, { reason: 'FACTURA' })])),
      'c.json'
    );
    expect(changed).toMatchObject({ newRows: 1, changedRows: 1 });
    expect(
      repo()
        .listMovements()
        .map((r) => r.reason)
    ).toEqual(['HABERES', 'FACTURA']);
  });

  it('is immutable at the database level', async () => {
    await service().importFile(bytes(response([element(1)])), 'a.json');
    const db = getRawDb();
    for (const table of ['bank_imports', 'bank_movements']) {
      expect(() => db.exec(`UPDATE ${table} SET account = 'x'`)).toThrow('immutable');
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('immutable');
    }
  });

  it('rejects a statement of another CUIT without writing', async () => {
    vi.stubEnv('COMPANY_CUIT', '23-12345678-9');
    await expect(service().importFile(pdfBytes(statement()), 'x.pdf')).rejects.toThrow(
      'El resumen'
    );
    expect(repo().listImports()).toHaveLength(0);
  });

  it('serves the API', async () => {
    const post = (content: string, name: string) => {
      const form = new FormData();
      form.append('file', new File([content], name));
      return app.request('/api/bank/imports', { method: 'POST', body: form });
    };
    const ok = await post(JSON.stringify(response([element(1)])), 'api.json');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ success: true, newRows: 1 });
    expect((await post('fecha;importe', 'x.csv')).status).toBe(400);

    const list = await app.request('/api/bank/movements?source=icbc_api&from=2026-03-10');
    expect(await list.json()).toMatchObject({ count: 1, movements: [{ rowKey: '1' }] });
    expect((await app.request('/api/bank/movements?source=other')).status).toBe(400);
    const imports = await app.request('/api/bank/imports');
    expect(await imports.json()).toMatchObject({ count: 1, imports: [{ filename: 'api.json' }] });
  });
});
