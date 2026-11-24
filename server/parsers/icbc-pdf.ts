/**
 * Parser of the ICBC monthly statement ("RESUMEN MENSUAL"), from the text
 * pdf-parse extracts. The sheet is printed twice (one copy per address); both
 * copies must match, and the movements must close against the balances.
 */

import { createHash } from 'crypto';
import { BankParseError, toCents, type BankRowInput, type ParsedBankFile } from './icbc-types.js';

const OPENING = /SALDO ULTIMO EXTRACTO AL \d{2}\/\d{2}\/\d{4}\s+([\d.]+,\d{2}-?)/;
const CLOSING = /SALDO FINAL AL \d{2}\/\d{2}\/\d{4}\s+([\d.]+,\d{2}-?)/;
const PERIOD = /PERIODO (\d{2})-(\d{2})-(\d{4}) AL (\d{2})-(\d{2})-(\d{4})/;
const ACCOUNT = /N° (\d{4}\/\d{8}\/\d{2})/;
const CUIT = /CUIT N° (\d{2}-\d{8}-\d)/;
const MOVEMENT = /^\d{2}-\d{2} /;
const AMOUNT = /[\d.]+,\d{2}-?/g;

/** Fixed-width columns: start and end offsets within the line. */
const COL = {
  concept: [6, 33],
  valueDate: [33, 38],
  ticket: [39, 53],
  origin: [53, 57],
  channel: [58, 62],
  amounts: [62, undefined],
} as const;

function parseAmount(text: string): number {
  const value = Number(text.replace('-', '').replaceAll('.', '').replace(',', '.'));
  return text.endsWith('-') ? -value : value;
}

/** dd-mm printed without year: the closest one to the statement month (Dec/Jan value dates). */
function resolveDate(ddmm: string, year: number, month: number): string {
  const [dd, mm] = ddmm.split('-') as [string, string];
  const diff = Number(mm) - month;
  const y = diff > 6 ? year - 1 : diff < -6 ? year + 1 : year;
  return `${y}-${mm}-${dd}`;
}

function parseLine(
  raw: string,
  year: number,
  month: number
): Omit<BankRowInput, 'rowNumber' | 'rowKey' | 'contentHash'> {
  const col = (c: readonly [number, number | undefined]): string => raw.slice(c[0], c[1]).trim();
  const amounts = [...col(COL.amounts).matchAll(AMOUNT)].map((m) => m[0]);
  if (amounts.length === 0 || amounts.length > 2) {
    throw new BankParseError(`Línea de movimiento sin importe reconocible: "${raw.trim()}"`);
  }
  const value = col(COL.valueDate);
  return {
    date: resolveDate(raw.slice(0, 5), year, month),
    valueDate: /^\d{2}-\d{2}$/.test(value) ? resolveDate(value, year, month) : null,
    concept: col(COL.concept),
    ticket: col(COL.ticket) || null,
    origin: col(COL.origin) || null,
    channel: col(COL.channel) || null,
    amount: parseAmount(amounts[0]!),
    balance: amounts[1] ? parseAmount(amounts[1]) : null,
    raw,
  };
}

export function parseIcbcStatementText(text: string): ParsedBankFile {
  const period = text.match(PERIOD);
  const account = text.match(ACCOUNT)?.[1];
  if (!period || !account) {
    throw new BankParseError('El PDF no es un resumen mensual de ICBC');
  }
  const [, d1, m1, y1, d2, m2, y2] = period as unknown as string[];
  const year = Number(y1);
  const month = Number(m1);

  // Split into copies, each from its "SALDO ULTIMO EXTRACTO" to its "SALDO FINAL".
  const lines = text.split(/\r?\n/);
  const copies: Array<{ opening: string; closing: string; rows: string[] }> = [];
  let current: { opening: string; rows: string[] } | null = null;
  for (const line of lines) {
    const opening = line.match(OPENING);
    if (opening) {
      if (current) throw new BankParseError('Dos saldos iniciales seguidos en el PDF');
      current = { opening: opening[1]!, rows: [] };
    }
    if (MOVEMENT.test(line)) {
      if (!current) throw new BankParseError(`Movimiento fuera de una copia: "${line.trim()}"`);
      current.rows.push(line);
    }
    const closing = line.match(CLOSING);
    if (closing) {
      if (!current) throw new BankParseError('Saldo final sin saldo inicial en el PDF');
      copies.push({ ...current, closing: closing[1]! });
      current = null;
    }
  }
  if (current || copies.length === 0) {
    throw new BankParseError('El resumen no tiene saldo inicial y final');
  }
  const first = copies[0]!;
  if (copies.some((c) => JSON.stringify(c) !== JSON.stringify(first))) {
    throw new BankParseError('Las copias de la hoja no coinciden entre sí');
  }

  const openingBalance = parseAmount(first.opening);
  const closingBalance = parseAmount(first.closing);
  const parsed = first.rows.map((raw) => parseLine(raw, year, month));
  const total = parsed.reduce((sum, r) => sum + toCents(r.amount), toCents(openingBalance));
  if (total !== toCents(closingBalance)) {
    throw new BankParseError(
      `El saldo no cierra: inicial ${first.opening} + movimientos = ${total / 100}, final ${first.closing}`
    );
  }

  return {
    source: 'icbc_pdf',
    account,
    holderCuit: text.match(CUIT)?.[1]?.replaceAll('-', '') ?? null,
    periodFrom: `${y1}-${m1}-${d1}`,
    periodTo: `${y2}-${m2}-${d2}`,
    openingBalance,
    closingBalance,
    rows: parsed.map((r, i) => ({
      ...r,
      rowNumber: i + 1,
      rowKey: `${y1}-${m1}#${i + 1}`,
      contentHash: createHash('sha256').update(r.raw.trimEnd()).digest('hex'),
    })),
  };
}
