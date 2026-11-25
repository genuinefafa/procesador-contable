/**
 * Bronze bank movements: ICBC statement parser (used by the PDF → JSON
 * converter), API JSON parser, append-only import and HTTP API.
 *
 * Fictitious data only (CUITs from CLAUDE.md, invented accounts and amounts).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getRawDb } from '../../database/db.js';
import { cleanupTestDb, runTestMigrations, resetTestDb } from '../../database/db-test.js';
import { BankRepository } from '../../database/repositories/bank.js';
import { parseIcbcApiJson } from '../../parsers/icbc-api.js';
import { parseIcbcStatementText } from '../../parsers/icbc-pdf.js';
import { formatBankAmount, parseBankAmount } from '../../parsers/icbc-types.js';
import { BankImportService } from '../../services/bank-import.service.js';
import { app } from '../../http/app.js';

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
    balance: '2.400,50',
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

function copy(lines: Line[], closing: string): string {
  return [
    'RESUMEN MENSUAL',
    'PERIODO 01-01-2026 AL 31-01-2026',
    'CUIT N° 30-12345678-9',
    `INFORMACION SOBRE SU CUENTA CORRIENTE EN PESOS      N° ${ACCOUNT} C.B.U.: 0`,
    'SALDO ULTIMO EXTRACTO AL 31/12/2025          1.000,00',
    ...lines.map(pdfLine),
    `TOT.LEY COMP.$ 1,00(*) SALDO FINAL AL 31/01/2026          ${closing}`,
  ].join('\n');
}

const statement = (lines = LINES, closing = '2.000,25'): string =>
  [copy(lines, closing), copy(lines, closing)].join('\n');

// 2026-03-10T00:00 in Argentina
const MARCH_10 = Date.UTC(2026, 2, 10, 3);

/** API element n: starts at a balance of 10.000,00 and pays 100,00 each. */
function element(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
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
    amount: -100,
    transactionBalance: formatBankAmount(10000 - 100 * n),
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

const response = (elements: unknown[], extra: Record<string, unknown> = {}) => ({
  state: 'OK',
  ...extra,
  body: { elements, hasMoreElements: false, totalElementCount: elements.length },
});
const bytes = (json: unknown): Buffer => Buffer.from(JSON.stringify(json));
const converted = { _converted: { from: 'icbc_pdf' } };

describe('bank amounts', () => {
  it('parses both sign styles and formats like the API', () => {
    expect(parseBankAmount('1.234,56-')).toBe(-1234.56);
    expect(parseBankAmount('-1.234,56')).toBe(-1234.56);
    expect(formatBankAmount(-1234567.5)).toBe('-1.234.567,50');
    expect(formatBankAmount(0.4)).toBe('0,40');
  });
});

describe('ICBC statement parser', () => {
  it('parses columns, signs, dates and the running balance', () => {
    const p = parseIcbcStatementText(statement());
    expect(p).toMatchObject({
      account: ACCOUNT,
      periodFrom: '2026-01-01',
      periodTo: '2026-01-31',
      openingBalance: 1000,
      closingBalance: 2000.25,
    });
    expect(p.lines).toHaveLength(3);
    expect(p.lines[0]).toMatchObject({
      date: '2026-01-02',
      valueDate: '2025-12-31',
      concept: 'MANTENIMIENTO DE CUENTA',
      ticket: null,
      amount: -100,
      balance: 900,
      raw: pdfLine(LINES[0]!),
    });
    expect(p.lines[1]).toMatchObject({ ticket: '1000001', channel: 'DNET', balance: 2400.5 });
    expect(p.lines[2]).toMatchObject({ ticket: 'MTA0000000001', amount: -400.25 });
  });

  it('rejects a statement that does not close', () => {
    expect(() => parseIcbcStatementText(statement(LINES, '2.000,26'))).toThrow('no cierra');
  });

  it('rejects a printed balance that differs from the running one', () => {
    const wrong = LINES.map((l, i) => (i === 1 ? { ...l, balance: '2.400,51' } : l));
    expect(() => parseIcbcStatementText(statement(wrong))).toThrow('no coincide');
  });

  it('rejects copies that differ', () => {
    const other = LINES.map((l, i) => (i === 1 ? { ...l, ticket: '1000009' } : l));
    const text = [copy(LINES, '2.000,25'), copy(other, '2.000,25')].join('\n');
    expect(() => parseIcbcStatementText(text)).toThrow('copias');
  });

  it('rejects other documents', () => {
    expect(() => parseIcbcStatementText('FACTURA A 0001-00000001')).toThrow('no es un resumen');
  });
});

describe('ICBC API parser', () => {
  it('maps the fields, with dates in Argentina time', () => {
    const p = parseIcbcApiJson(response([element(1)]));
    expect(p).toMatchObject({ source: 'icbc_api', account: ACCOUNT, periodFrom: '2026-03-10' });
    expect(p.rows[0]).toMatchObject({
      transactionNumber: 1,
      date: '2026-03-10',
      valueDate: '2026-03-10',
      operatedAt: '2026-03-10T10:00:00',
      concept: 'TR. A CTA',
      conceptCode: '978',
      ticket: '1000001',
      amount: -100,
      balance: 9900,
      counterpartTaxId: '20123456789',
      reasonCode: '09',
      reason: 'HABERES',
      raw: JSON.stringify(element(1)),
    });
  });

  it('orders by transaction number and marks converted files', () => {
    const p = parseIcbcApiJson(response([element(3), element(1), element(2)], converted));
    expect(p.source).toBe('icbc_pdf_converted');
    expect(p.rows.map((r) => r.transactionNumber)).toEqual([1, 2, 3]);
    expect(p.gaps).toEqual([]);
  });

  it('checks the balance chain, across holes too', () => {
    const broken = element(2, { transactionBalance: '9.850,00' });
    expect(() => parseIcbcApiJson(response([element(1), broken]))).toThrow('no encadenan');
    const hole = element(3, { transactionBalance: formatBankAmount(9800) });
    expect(parseIcbcApiJson(response([element(1), hole])).gaps).toEqual([{ after: 1, before: 3 }]);
  });

  it('rejects incomplete, repeated or unrelated responses', () => {
    const incomplete = response([element(1)]);
    incomplete.body.hasMoreElements = true;
    expect(() => parseIcbcApiJson(incomplete)).toThrow('incompleta');
    const short = response([element(1)]);
    short.body.totalElementCount = 2;
    expect(() => parseIcbcApiJson(short)).toThrow('incompleta');
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

  const service = () => new BankImportService();
  const repo = () => new BankRepository();
  const imp = (json: unknown, name = 'api.json') => service().importFile(bytes(json), name);

  it('stores each movement with its origin, in bank order', () => {
    const seed = imp(response([element(1), element(2)], converted), 'seed.json');
    const api = imp(response([element(4), element(3)]));
    expect(seed).toMatchObject({ newRows: 2, alreadyImported: false, warnings: [] });
    expect(api.warnings).toEqual([]);
    const rows = repo().listMovements();
    expect(rows.map((r) => [r.transactionNumber, r.source, r.version])).toEqual([
      [1, 'icbc_pdf_converted', 1],
      [2, 'icbc_pdf_converted', 1],
      [3, 'icbc_api', 1],
      [4, 'icbc_api', 1],
    ]);
    expect(rows[2]!.importId).toBe(api.import.id);
  });

  it('does nothing when the same file is imported again', () => {
    imp(response([element(1)]));
    expect(imp(response([element(1)]), 'copia.json')).toMatchObject({
      alreadyImported: true,
      newRows: 0,
    });
    expect(repo().listImports()).toHaveLength(1);
  });

  it('adds only the new rows of an overlapping download', () => {
    imp(response([element(1), element(2)]));
    expect(imp(response([element(2), element(3)]), 'b.json')).toMatchObject({
      newRows: 1,
      knownRows: 1,
      changedRows: 0,
    });
    expect(repo().listMovements()).toHaveLength(3);
  });

  it('versions real changes, also back to an earlier content', () => {
    const { action: _action, ...rest } = element(1);
    imp(response([element(1)]), 'a.json');
    const reordered = Object.fromEntries(Object.entries(rest).reverse());
    expect(imp(response([reordered]), 'b.json').knownRows).toBe(1);
    expect(imp(response([element(1, { reason: 'FACTURA' })]), 'c.json')).toMatchObject({
      newRows: 0,
      changedRows: 1,
    });
    expect(imp(response([element(1), element(2)]), 'd.json')).toMatchObject({
      newRows: 1,
      changedRows: 1,
    });
    expect(
      repo()
        .listMovements({ allVersions: true })
        .map((r) => [r.version, r.reason])
    ).toEqual([
      [1, 'HABERES'],
      [2, 'FACTURA'],
      [3, 'HABERES'],
      [1, 'HABERES'],
    ]);
    expect(
      repo()
        .listMovements()
        .map((r) => r.version)
    ).toEqual([3, 1]);
  });

  it('warns when the balance does not chain with stored rows', () => {
    imp(response([element(1)]));
    const off = element(2, { transactionBalance: '5.000,00' });
    expect(imp(response([off]), 'b.json').warnings).toEqual([
      'El saldo no encadena con el movimiento 1 ya cargado',
    ]);
  });

  it('rejects another account and a number already loaded from another source', () => {
    imp(response([element(1)]));
    expect(() =>
      imp(response([element(2, { accountNumber: '0002/00000002/02' })]), 'b.json')
    ).toThrow('cuenta');
    expect(() => imp(response([element(1, { reason: 'X' })], converted), 'c.json')).toThrow(
      'otra fuente'
    );
    expect(repo().listImports()).toHaveLength(1);
  });

  it('is immutable at the database level', () => {
    imp(response([element(1)]));
    const db = getRawDb();
    for (const table of ['bank_imports', 'bank_movements']) {
      expect(() => db.exec(`UPDATE ${table} SET account = 'x'`)).toThrow('immutable');
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('immutable');
    }
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
    const pdf = await post('%PDF-1.4 ...', 'resumen.pdf');
    expect(pdf.status).toBe(400);
    expect(await pdf.json()).toMatchObject({ error: expect.stringContaining('se convierten') });
    await post(JSON.stringify(response([element(1, { reason: 'FACTURA' })])), 'b.json');

    const latest = await app.request('/api/bank/movements?source=icbc_api&from=2026-03-10');
    expect(await latest.json()).toMatchObject({ count: 1, movements: [{ version: 2 }] });
    const all = await app.request('/api/bank/movements?versions=all');
    expect(await all.json()).toMatchObject({ count: 2 });
    expect((await app.request('/api/bank/movements?source=other')).status).toBe(400);
    const imports = await app.request('/api/bank/imports');
    expect(await imports.json()).toMatchObject({
      count: 2,
      imports: [{ filename: 'api.json' }, { filename: 'b.json' }],
    });
  });
});
