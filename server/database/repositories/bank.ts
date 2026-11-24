/**
 * Bronze bank statements: append-only. See the schema comment for the model.
 */

import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { getDb } from '../db.js';
import {
  bankImports,
  bankMovements,
  type BankImport,
  type BankMovement,
  type BankSource,
} from '../schema.js';
import type { ParsedBankFile } from '../../parsers/icbc-types.js';

export interface BankImportResult {
  import: BankImport;
  /** The same file (by hash) had already been imported: nothing was written. */
  alreadyImported: boolean;
  newRows: number;
  /** Rows that were already in bronze, from an earlier import. */
  knownRows: number;
  /** New versions of rows whose content changed at the bank. */
  changedRows: number;
}

export class BankRepository {
  /** Stores a parsed file. Existing rows are never touched. */
  insertFile(parsed: ParsedBankFile, filename: string, sha256: string): BankImportResult {
    return getDb().transaction((tx) => {
      const previous = tx.select().from(bankImports).where(eq(bankImports.sha256, sha256)).get();
      if (previous) {
        return {
          import: previous,
          alreadyImported: true,
          newRows: 0,
          knownRows: parsed.rows.length,
          changedRows: 0,
        };
      }

      const known = tx
        .select({ rowKey: bankMovements.rowKey, contentHash: bankMovements.contentHash })
        .from(bankMovements)
        .where(
          and(eq(bankMovements.source, parsed.source), eq(bankMovements.account, parsed.account))
        )
        .all();
      const knownRows = new Set(known.map((k) => `${k.rowKey}|${k.contentHash}`));
      const knownKeys = new Set(known.map((k) => k.rowKey));
      const fresh = parsed.rows.filter((r) => !knownRows.has(`${r.rowKey}|${r.contentHash}`));

      const created = tx
        .insert(bankImports)
        .values({
          source: parsed.source,
          filename,
          sha256,
          account: parsed.account,
          periodFrom: parsed.periodFrom,
          periodTo: parsed.periodTo,
          openingBalance: parsed.openingBalance,
          closingBalance: parsed.closingBalance,
          rowCount: parsed.rows.length,
          newCount: fresh.length,
        })
        .returning()
        .get();
      for (const row of fresh) {
        tx.insert(bankMovements)
          .values({
            ...row,
            importId: created.id,
            source: parsed.source,
            account: parsed.account,
          })
          .run();
      }

      return {
        import: created,
        alreadyImported: false,
        newRows: fresh.length,
        knownRows: parsed.rows.length - fresh.length,
        changedRows: fresh.filter((r) => knownKeys.has(r.rowKey)).length,
      };
    });
  }

  listImports(): BankImport[] {
    return getDb()
      .select()
      .from(bankImports)
      .orderBy(asc(bankImports.periodFrom), asc(bankImports.id))
      .all();
  }

  listMovements(
    filters: { from?: string; to?: string; source?: BankSource; importId?: number } = {}
  ): BankMovement[] {
    const conditions = [];
    if (filters.from) conditions.push(gte(bankMovements.date, filters.from));
    if (filters.to) conditions.push(lte(bankMovements.date, filters.to));
    if (filters.source) conditions.push(eq(bankMovements.source, filters.source));
    if (filters.importId) conditions.push(eq(bankMovements.importId, filters.importId));
    return getDb()
      .select()
      .from(bankMovements)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(bankMovements.date), asc(bankMovements.source), asc(bankMovements.id))
      .all();
  }
}
