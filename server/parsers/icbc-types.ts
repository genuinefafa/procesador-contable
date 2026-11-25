import type { BankSource, NewBankMovement } from '../database/schema.js';

/** A movement ready to be stored; the import adds its id, source, account and version. */
export type BankRowInput = Omit<
  NewBankMovement,
  'id' | 'importId' | 'source' | 'account' | 'version'
>;

export interface ParsedBankFile {
  source: BankSource;
  account: string;
  periodFrom: string;
  periodTo: string;
  /** Ascending by transaction number; the balance chain is already checked. */
  rows: BankRowInput[];
  /** Holes in the numbering: the balance chain is checked across them anyway. */
  gaps: Array<{ after: number; before: number }>;
}

/** The file is not a valid or complete source: nothing must be imported from it. */
export class BankParseError extends Error {}

export const toCents = (amount: number): number => Math.round(amount * 100);

/** Bank amounts as text: 1.234,56 with the sign before or after (-1.234,56 / 1.234,56-). */
export function parseBankAmount(text: string): number {
  const negative = text.trim().startsWith('-') || text.trim().endsWith('-');
  const value = Number(text.replaceAll('-', '').replaceAll('.', '').replace(',', '.').trim());
  if (!Number.isFinite(value)) throw new BankParseError(`Importe inválido: "${text}"`);
  return negative ? -value : value;
}

/** Formats like the API (1.234,56; negatives with a leading minus). */
export function formatBankAmount(amount: number): string {
  const [int, dec] = Math.abs(amount).toFixed(2).split('.') as [string, string];
  return `${amount < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}
