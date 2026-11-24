/**
 * Imports bank sources into bronze: ICBC monthly statement (PDF) and the JSON
 * of its home banking API. The format is detected from the content.
 */

import { createHash } from 'crypto';
import pdf from 'pdf-parse';
import { checkCompanyCuit } from '../config/company.js';
import { BankRepository, type BankImportResult } from '../database/repositories/bank.js';
import { parseIcbcApiJson } from '../parsers/icbc-api.js';
import { parseIcbcStatementText } from '../parsers/icbc-pdf.js';
import { BankParseError, type ParsedBankFile } from '../parsers/icbc-types.js';

/** Detects the format and parses; throws BankParseError when it is not usable. */
export async function parseBankFile(bytes: Buffer): Promise<ParsedBankFile> {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    let text: string;
    try {
      ({ text } = await pdf(bytes));
    } catch {
      throw new BankParseError('No se pudo leer el PDF');
    }
    return parseIcbcStatementText(text);
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf-8'));
  } catch {
    throw new BankParseError('Formato no soportado: se espera el PDF mensual o el JSON de la API');
  }
  return parseIcbcApiJson(json);
}

export class BankImportService {
  constructor(private repo: BankRepository = new BankRepository()) {}

  async importFile(bytes: Buffer, filename: string): Promise<BankImportResult> {
    const parsed = await parseBankFile(bytes);
    if (parsed.holderCuit) {
      const check = checkCompanyCuit(parsed.holderCuit);
      if (!check.ok) throw new BankParseError(check.error.replace('El Excel', 'El resumen'));
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return this.repo.insertFile(parsed, filename, sha256);
  }
}
