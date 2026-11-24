/**
 * Imports bank files (ICBC monthly PDF or API JSON) into bronze.
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

async function main(): Promise<number> {
  console.info(save ? `DB: ${DB_PATH}\n` : 'Validate only (use --save to store)\n');
  const service = new BankImportService();
  let failed = 0;
  for (const path of files) {
    const name = basename(path);
    try {
      const bytes = readFileSync(path);
      if (!save) {
        const p = await parseBankFile(bytes);
        console.info(`${name}: ${p.source} ${p.periodFrom}..${p.periodTo} ${p.rows.length} rows`);
        continue;
      }
      const r = await service.importFile(bytes, name);
      console.info(
        r.alreadyImported
          ? `${name}: already imported (#${r.import.id})`
          : `${name}: ${r.newRows} new, ${r.knownRows} known, ${r.changedRows} changed`
      );
    } catch (error) {
      failed++;
      console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failed;
}

process.exit((await main()) > 0 ? 1 : 0);
