/**
 * Imports ICBC API JSON files (or PDFs converted with icbc-pdf-to-json.ts) into bronze.
 *
 * Usage:
 *   bun run bank:import -- <file>...        # parse and validate only
 *   bun run bank:import -- --save <file>... # store in the DB
 *
 * Honors DB_PATH (to run against a copy or inside the container).
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { DB_PATH } from '../database/db.js';
import { BankImportService, parseBankFile } from '../services/bank-import.service.js';

const save = process.argv.includes('--save');
const files = process.argv.slice(2).filter((a) => a !== '--save');

function main(): number {
  console.info(save ? `DB: ${DB_PATH}\n` : 'Validate only (use --save to store)\n');
  const service = new BankImportService();
  let failed = 0;
  for (const path of files) {
    const name = basename(path);
    try {
      const bytes = readFileSync(path);
      if (!save) {
        const p = parseBankFile(bytes);
        const span = `${p.rows[0]!.transactionNumber}..${p.rows.at(-1)!.transactionNumber}`;
        console.info(
          `${name}: ${p.source} ${p.periodFrom}..${p.periodTo} #${span} ${p.rows.length} rows`
        );
        continue;
      }
      const r = service.importFile(bytes, name);
      console.info(
        r.alreadyImported
          ? `${name}: already imported (#${r.import.id})`
          : `${name}: ${r.newRows} new, ${r.knownRows} known, ${r.changedRows} changed`
      );
      for (const w of r.warnings) console.warn(`  ! ${w}`);
    } catch (error) {
      failed++;
      console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failed;
}

process.exit(main() > 0 ? 1 : 0);
