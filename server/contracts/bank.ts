/**
 * Contracts for /api/bank (bronze bank movements).
 */

import * as z from 'zod';
import { BANK_SOURCES } from '../database/schema.js';
import { dateStringSchema } from './schemas.js';

export const BankMovementsQuerySchema = z.object({
  /** Inclusive, YYYY-MM-DD */
  from: dateStringSchema.optional(),
  /** Inclusive, YYYY-MM-DD */
  to: dateStringSchema.optional(),
  source: z.enum(BANK_SOURCES).optional(),
  importId: z.coerce.number().int().positive().optional(),
  /** `all` also returns the versions the bank replaced */
  versions: z.enum(['latest', 'all']).optional(),
});

export type BankMovementsQuery = z.infer<typeof BankMovementsQuerySchema>;
