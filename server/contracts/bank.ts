/**
 * Contracts for /api/bank (bronze bank statements).
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
});

export type BankMovementsQuery = z.infer<typeof BankMovementsQuerySchema>;
