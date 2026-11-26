/**
 * Imports the ICBC API JSON (or a PDF converted to it) into bronze.
 */

import { createHash } from 'crypto';
import { BankRepository, type BankImportResult } from '../database/repositories/bank.js';
import { parseIcbcApiJson } from '../parsers/icbc-api.js';
import { BankParseError, type ParsedBankFile } from '../parsers/icbc-types.js';

/** Parses and validates; throws BankParseError when the file is not usable. */
export function parseBankFile(bytes: Buffer): ParsedBankFile {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    throw new BankParseError(
      'Los PDF no se importan: se convierten antes a JSON con scripts/icbc-pdf-to-json.ts'
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf-8'));
  } catch {
    throw new BankParseError('Formato no soportado: se espera el JSON de movimientos de ICBC');
  }
  return parseIcbcApiJson(json);
}

export class BankImportService {
  constructor(private repo: BankRepository = new BankRepository()) {}

  importFile(bytes: Buffer, filename: string): BankImportResult {
    const parsed = parseBankFile(bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return this.repo.insertFile(parsed, filename, sha256);
  }
}
