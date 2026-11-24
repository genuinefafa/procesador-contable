import type { BankSource, NewBankMovement } from '../database/schema.js';

/** A source line ready to be stored; the import adds its own id, source and account. */
export type BankRowInput = Omit<NewBankMovement, 'id' | 'importId' | 'source' | 'account'>;

export interface ParsedBankFile {
  source: BankSource;
  account: string;
  /** 11 digits, when the source carries the holder's CUIT (PDF only). */
  holderCuit: string | null;
  periodFrom: string;
  periodTo: string;
  openingBalance: number | null;
  closingBalance: number | null;
  rows: BankRowInput[];
}

/** The file is not a valid or complete source: nothing must be imported from it. */
export class BankParseError extends Error {}

export const toCents = (amount: number): number => Math.round(amount * 100);
