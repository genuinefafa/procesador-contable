/**
 * Converts ICBC monthly statements (PDF) to the JSON shape of the API
 * (get_transactions_paged), to seed bronze with what is older than the API's
 * one-year window. Run once; the app only imports JSON.
 *
 * - Statements must be consecutive: each closing balance opens the next one.
 * - Movements after --until are left out (the API already has them).
 * - transactionNumber is invented: counting back from --next (the first number
 *   the API returned), in statement order. The envelope says `_converted` and
 *   every element keeps its PDF line in `_pdf`, so nobody mistakes it for bank data.
 *
 * Usage:
 *   bun scripts/icbc-pdf-to-json.ts --until 2025-11-10 --next 12159 --out seed.json <pdf>...
 *
 * The output has real data: keep it out of git (scripts/seed-data/ is ignored).
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import pdf from 'pdf-parse';
import { parseIcbcStatementText, type ParsedStatement } from '../parsers/icbc-pdf.js';
import { formatBankAmount, toCents } from '../parsers/icbc-types.js';

function option(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`Falta --${name}`);
  return value;
}

/** Midnight in Argentina (UTC-3) as epoch ms, like the API. */
const epoch = (date: string): number => Date.parse(`${date}T03:00:00.000Z`);
const ddmmyyyy = (date: string): string => date.split('-').reverse().join('/');

async function main(): Promise<void> {
  const until = option('until');
  const next = Number(option('next'));
  const out = option('out');
  const paths = process.argv
    .slice(2)
    .filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));

  const statements: Array<ParsedStatement & { file: string; sha256: string }> = [];
  for (const path of paths) {
    const bytes = readFileSync(path);
    const { text } = await pdf(bytes);
    statements.push({
      ...parseIcbcStatementText(text),
      file: basename(path),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  statements.sort((a, b) => a.periodFrom.localeCompare(b.periodFrom));
  if (new Set(statements.map((s) => s.account)).size !== 1) {
    throw new Error('Los resúmenes son de cuentas distintas');
  }
  for (let i = 1; i < statements.length; i++) {
    const prev = statements[i - 1]!;
    const cur = statements[i]!;
    if (toCents(prev.closingBalance) !== toCents(cur.openingBalance)) {
      throw new Error(
        `${prev.file} cierra en ${prev.closingBalance} y ${cur.file} abre en ${cur.openingBalance}`
      );
    }
  }

  const lines = statements.flatMap((s) =>
    s.lines.filter((l) => l.date <= until).map((l) => ({ ...l, file: s.file }))
  );
  const first = next - lines.length;
  const elements = lines.map((l, i) => ({
    transactionNumber: String(first + i),
    accountNumber: statements[0]!.account,
    accountantDate: epoch(l.date),
    date: epoch(l.date),
    dateCsv: ddmmyyyy(l.date),
    dateValue: l.valueDate ? epoch(l.valueDate) : null,
    dateHourOp: null,
    concept: l.concept,
    transactionCode: null,
    ticketNumber: l.ticket,
    amount: l.amount,
    transactionAmount: formatBankAmount(l.amount),
    transactionBalance: formatBankAmount(l.balance),
    channel: l.channel,
    beneficiary: null,
    docNumber: null,
    cbu: null,
    bankOrdOut: null,
    reasonCode: null,
    reason: null,
    _pdf: { file: l.file, origin: l.origin, line: l.raw },
  }));

  const output = {
    _converted: {
      from: 'icbc_pdf',
      note: 'transactionNumber is invented (counted back from the first one of the API)',
      until,
      next,
      files: statements.map((s) => ({
        file: s.file,
        sha256: s.sha256,
        period: `${s.periodFrom}..${s.periodTo}`,
      })),
    },
    state: 'OK',
    body: { elements, hasMoreElements: false, totalElementCount: elements.length },
  };
  writeFileSync(out, JSON.stringify(output, null, 2) + '\n');
  const last = lines.at(-1);
  console.info(
    `${out}: ${elements.length} movements, #${first}..${next - 1}, ${lines[0]?.date}..${last?.date}, final balance ${last?.balance}`
  );
}

await main();
