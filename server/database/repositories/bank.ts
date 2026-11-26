/**
 * Bronze bank movements: append-only. See the schema comment for the model.
 */

import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '../db.js';
import {
  bankImports,
  bankMovements,
  type BankImport,
  type BankMovement,
  type BankSource,
} from '../schema.js';
import { BankParseError, toCents, type ParsedBankFile } from '../../parsers/icbc-types.js';

export interface BankImportResult {
  import: BankImport;
  /** The same file (by hash) had already been imported: nothing was written. */
  alreadyImported: boolean;
  newRows: number;
  /** Rows identical to the latest stored version. */
  knownRows: number;
  /** New versions of rows the bank changed. */
  changedRows: number;
  /** Not blocking: holes in the numbering or balances that do not chain with stored rows. */
  warnings: string[];
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

function latest(tx: Tx, account: string, transactionNumber: number): BankMovement | undefined {
  return tx
    .select()
    .from(bankMovements)
    .where(
      and(
        eq(bankMovements.account, account),
        eq(bankMovements.transactionNumber, transactionNumber)
      )
    )
    .orderBy(desc(bankMovements.version))
    .limit(1)
    .get();
}

export class BankRepository {
  /** Stores a parsed file. Stored rows are never touched; changed ones get a new version. */
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
          warnings: [],
        };
      }

      const other = tx
        .select({ account: bankImports.account })
        .from(bankImports)
        .where(sql`${bankImports.account} <> ${parsed.account}`)
        .limit(1)
        .get();
      if (other) {
        throw new BankParseError(
          `El archivo es de la cuenta ${parsed.account} y ya hay movimientos de la ${other.account}`
        );
      }

      const warnings = parsed.gaps.map(
        (g) => `Faltan los movimientos entre ${g.after} y ${g.before}`
      );
      const pending: Array<{ row: ParsedBankFile['rows'][number]; version: number }> = [];
      let known = 0;
      let changed = 0;
      for (const row of parsed.rows) {
        const stored = latest(tx, parsed.account, row.transactionNumber);
        if (stored && stored.source !== parsed.source) {
          throw new BankParseError(
            `El movimiento ${row.transactionNumber} ya está cargado desde otra fuente (${stored.source})`
          );
        }
        if (stored?.contentHash === row.contentHash) {
          known++;
          continue;
        }
        if (stored) changed++;
        pending.push({ row, version: (stored?.version ?? 0) + 1 });
      }

      // Chain with what is already stored around the file.
      const first = parsed.rows[0]!;
      const last = parsed.rows.at(-1)!;
      const before = latest(tx, parsed.account, first.transactionNumber - 1);
      if (before && toCents(before.balance) + toCents(first.amount) !== toCents(first.balance)) {
        warnings.push(
          `El saldo no encadena con el movimiento ${before.transactionNumber} ya cargado`
        );
      }
      const after = latest(tx, parsed.account, last.transactionNumber + 1);
      if (after && toCents(last.balance) + toCents(after.amount) !== toCents(after.balance)) {
        warnings.push(
          `El saldo no encadena con el movimiento ${after.transactionNumber} ya cargado`
        );
      }

      const created = tx
        .insert(bankImports)
        .values({
          source: parsed.source,
          filename,
          sha256,
          account: parsed.account,
          periodFrom: parsed.periodFrom,
          periodTo: parsed.periodTo,
          rowCount: parsed.rows.length,
          newCount: pending.length,
        })
        .returning()
        .get();
      for (const { row, version } of pending) {
        tx.insert(bankMovements)
          .values({
            ...row,
            version,
            importId: created.id,
            source: parsed.source,
            account: parsed.account,
          })
          .run();
      }

      return {
        import: created,
        alreadyImported: false,
        newRows: pending.length - changed,
        knownRows: known,
        changedRows: changed,
        warnings,
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

  /** Movements in bank order; only the latest version of each unless `allVersions`. */
  listMovements(
    filters: {
      from?: string;
      to?: string;
      source?: BankSource;
      importId?: number;
      allVersions?: boolean;
    } = {}
  ): BankMovement[] {
    const conditions = [];
    if (filters.from) conditions.push(gte(bankMovements.date, filters.from));
    if (filters.to) conditions.push(lte(bankMovements.date, filters.to));
    if (filters.source) conditions.push(eq(bankMovements.source, filters.source));
    if (filters.importId) conditions.push(eq(bankMovements.importId, filters.importId));
    if (!filters.allVersions) {
      conditions.push(
        sql`${bankMovements.version} = (SELECT MAX(v.version) FROM bank_movements v
          WHERE v.account = ${bankMovements.account}
            AND v.transaction_number = ${bankMovements.transactionNumber})`
      );
    }
    return getDb()
      .select()
      .from(bankMovements)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        asc(bankMovements.account),
        asc(bankMovements.transactionNumber),
        asc(bankMovements.version)
      )
      .all();
  }
}
