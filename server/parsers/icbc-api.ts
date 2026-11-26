/**
 * Parser of the ICBC home banking API JSON (get_transactions_paged), the only
 * input of bronze. Old monthly PDFs are converted to this same shape
 * (scripts/icbc-pdf-to-json.ts) and marked with `_converted`.
 */

import { createHash } from 'crypto';
import * as z from 'zod';
import {
  BankParseError,
  parseBankAmount,
  toCents,
  type BankRowInput,
  type ParsedBankFile,
} from './icbc-types.js';

const text = z.string().nullish();

const ElementSchema = z.looseObject({
  transactionNumber: z.string().regex(/^\d+$/),
  accountNumber: z.string().min(1),
  accountantDate: z.number(),
  dateValue: z.number().nullish(),
  dateHourOp: z.number().nullish(),
  concept: z.string(),
  transactionCode: text,
  ticketNumber: text,
  amount: z.number(),
  transactionBalance: z.string().min(1),
  channel: text,
  beneficiary: text,
  docNumber: text,
  cbu: text,
  bankOrdOut: text,
  reasonCode: text,
  reason: text,
});

/** Envelope marker written by the PDF converter. */
export const ConvertedSchema = z.looseObject({ from: z.literal('icbc_pdf') });

const ResponseSchema = z.looseObject({
  _converted: ConvertedSchema.optional(),
  body: z.looseObject({
    elements: z.array(z.unknown()),
    hasMoreElements: z.boolean(),
    totalElementCount: z.number(),
  }),
});

const ARGENTINA_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3, no DST

/** Epoch ms to the local (Argentina) date and time. */
function localIso(epochMs: number): string {
  return new Date(epochMs - ARGENTINA_OFFSET_MS).toISOString().slice(0, 19);
}

function clean(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/** JSON with sorted keys, so key order does not change the hash. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v
  );
}

/** Content hash of a movement; `action` only describes buttons of the bank's UI. */
export function movementHash(raw: Record<string, unknown>): string {
  const { action: _action, ...content } = raw;
  return createHash('sha256').update(canonical(content)).digest('hex');
}

export function parseIcbcApiJson(json: unknown): ParsedBankFile {
  const response = ResponseSchema.safeParse(json);
  if (!response.success) {
    throw new BankParseError('El JSON no es una respuesta de movimientos de la API de ICBC');
  }
  const { elements, hasMoreElements, totalElementCount } = response.data.body;
  if (hasMoreElements || totalElementCount !== elements.length) {
    throw new BankParseError(
      `La respuesta está incompleta: ${elements.length} de ${totalElementCount} movimientos`
    );
  }
  if (elements.length === 0) throw new BankParseError('La respuesta no tiene movimientos');

  const parsed = elements.map((raw, i) => {
    const element = ElementSchema.safeParse(raw);
    if (!element.success) {
      throw new BankParseError(`Movimiento ${i + 1} con formato inesperado`);
    }
    return { raw: raw as Record<string, unknown>, data: element.data };
  });

  const accounts = new Set(parsed.map((p) => p.data.accountNumber));
  if (accounts.size !== 1) throw new BankParseError('El JSON mezcla movimientos de varias cuentas');
  const ids = new Set(parsed.map((p) => p.data.transactionNumber));
  if (ids.size !== parsed.length) throw new BankParseError('transactionNumber repetido en el JSON');

  const rows: BankRowInput[] = parsed
    .map(({ raw, data }) => ({
      transactionNumber: Number(data.transactionNumber),
      contentHash: movementHash(raw),
      date: localIso(data.accountantDate).slice(0, 10),
      valueDate: data.dateValue ? localIso(data.dateValue).slice(0, 10) : null,
      operatedAt: data.dateHourOp ? localIso(data.dateHourOp) : null,
      concept: data.concept.trim(),
      conceptCode: clean(data.transactionCode),
      ticket: clean(data.ticketNumber),
      amount: data.amount,
      balance: parseBankAmount(data.transactionBalance),
      channel: clean(data.channel),
      counterpartName: clean(data.beneficiary),
      counterpartTaxId: data.docNumber?.replace(/\D/g, '') || null,
      counterpartCbu: clean(data.cbu),
      counterpartBank: clean(data.bankOrdOut),
      reasonCode: clean(data.reasonCode),
      reason: clean(data.reason),
      raw: JSON.stringify(raw),
    }))
    .sort((a, b) => a.transactionNumber - b.transactionNumber);

  // Each balance must be the previous one plus its amount, also across holes.
  const gaps: ParsedBankFile['gaps'] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const row = rows[i]!;
    if (row.transactionNumber !== prev.transactionNumber + 1) {
      gaps.push({ after: prev.transactionNumber, before: row.transactionNumber });
    }
    if (toCents(prev.balance) + toCents(row.amount) !== toCents(row.balance)) {
      throw new BankParseError(
        `Los saldos no encadenan entre los movimientos ${prev.transactionNumber} y ${row.transactionNumber}`
      );
    }
  }
  const dates = rows.map((r) => r.date).sort();

  return {
    source: response.data._converted ? 'icbc_pdf_converted' : 'icbc_api',
    account: parsed[0]!.data.accountNumber,
    periodFrom: dates[0]!,
    periodTo: dates.at(-1)!,
    rows,
    gaps,
  };
}
