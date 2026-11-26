/**
 * Parser of the ICBC monthly statement ("RESUMEN MENSUAL"), from the text
 * pdf-parse extracts. Only used to convert old statements to API-shaped JSON
 * (scripts/icbc-pdf-to-json.ts); the app itself never reads PDFs.
 *
 * The sheet is printed twice (one copy per address): both copies must match,
 * and every printed balance must match the running balance.
 */

import { BankParseError, parseBankAmount, toCents } from './icbc-types.js';

const OPENING = /SALDO ULTIMO EXTRACTO AL \d{2}\/\d{2}\/\d{4}\s+([\d.]+,\d{2}-?)/;
const CLOSING = /SALDO FINAL AL \d{2}\/\d{2}\/\d{4}\s+([\d.]+,\d{2}-?)/;
const PERIOD = /PERIODO (\d{2})-(\d{2})-(\d{4}) AL (\d{2})-(\d{2})-(\d{4})/;
const ACCOUNT = /N° (\d{4}\/\d{8}\/\d{2})/;
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

export interface StatementLine {
  date: string; // YYYY-MM-DD
  valueDate: string | null;
  concept: string;
  ticket: string | null;
  origin: string | null;
  channel: string | null;
  amount: number;
  /** Running balance after this line (printed only at the end of each day). */
  balance: number;
  raw: string;
}

export interface ParsedStatement {
  account: string;
  periodFrom: string;
  periodTo: string;
  openingBalance: number;
  closingBalance: number;
  lines: StatementLine[];
}

/** dd-mm printed without year: the closest one to the statement month (Dec/Jan value dates). */
function resolveDate(ddmm: string, year: number, month: number): string {
  const [dd, mm] = ddmm.split('-') as [string, string];
  const diff = Number(mm) - month;
  const y = diff > 6 ? year - 1 : diff < -6 ? year + 1 : year;
  return `${y}-${mm}-${dd}`;
}

export function parseIcbcStatementText(text: string): ParsedStatement {
  const period = text.match(PERIOD);
  const account = text.match(ACCOUNT)?.[1];
  if (!period || !account) {
    throw new BankParseError('El PDF no es un resumen mensual de ICBC');
  }
  const [, d1, m1, y1, d2, m2, y2] = period as unknown as string[];
  const year = Number(y1);
  const month = Number(m1);

  // Split into copies, each from its "SALDO ULTIMO EXTRACTO" to its "SALDO FINAL".
  const copies: Array<{ opening: string; closing: string; rows: string[] }> = [];
  let current: { opening: string; rows: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
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

  const openingBalance = parseBankAmount(first.opening);
  const closingBalance = parseBankAmount(first.closing);
  let running = toCents(openingBalance);
  const lines = first.rows.map((raw): StatementLine => {
    const col = (c: readonly [number, number | undefined]): string => raw.slice(c[0], c[1]).trim();
    const amounts = [...col(COL.amounts).matchAll(AMOUNT)].map((m) => m[0]);
    if (amounts.length === 0 || amounts.length > 2) {
      throw new BankParseError(`Línea de movimiento sin importe reconocible: "${raw.trim()}"`);
    }
    const amount = parseBankAmount(amounts[0]!);
    running += toCents(amount);
    if (amounts[1] && toCents(parseBankAmount(amounts[1])) !== running) {
      throw new BankParseError(
        `El saldo impreso ${amounts[1]} no coincide con el calculado ${running / 100}: "${raw.trim()}"`
      );
    }
    const value = col(COL.valueDate);
    return {
      date: resolveDate(raw.slice(0, 5), year, month),
      valueDate: /^\d{2}-\d{2}$/.test(value) ? resolveDate(value, year, month) : null,
      concept: col(COL.concept),
      ticket: col(COL.ticket) || null,
      origin: col(COL.origin) || null,
      channel: col(COL.channel) || null,
      amount,
      balance: running / 100,
      raw,
    };
  });
  if (running !== toCents(closingBalance)) {
    throw new BankParseError(
      `El saldo no cierra: calculado ${running / 100}, final impreso ${first.closing}`
    );
  }

  return {
    account,
    periodFrom: `${y1}-${m1}-${d1}`,
    periodTo: `${y2}-${m2}-${d2}`,
    openingBalance,
    closingBalance,
    lines,
  };
}
