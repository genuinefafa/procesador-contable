/**
 * Hono router for /api/bank: bronze bank statements (ICBC PDF and API JSON).
 */

import { Hono } from 'hono';

import { BankMovementsQuerySchema } from '../../contracts/bank';
import { formatZodError } from '../../contracts';
import { BankRepository } from '../../database/repositories/bank';
import { BankParseError } from '../../parsers/icbc-types';
import { BankImportService } from '../../services/bank-import.service';

export const bankRouter = new Hono();

// POST /api/bank/imports (multipart: file)
bankRouter.post('/imports', async (c) => {
  const formData = await c.req.formData().catch(() => null);
  const file = formData?.get('file');
  if (!file || typeof file === 'string') {
    return c.json({ success: false, error: 'No se proporcionó archivo' }, 400);
  }
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await new BankImportService().importFile(bytes, file.name);
    return c.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof BankParseError) {
      return c.json({ success: false, error: error.message }, 400);
    }
    throw error;
  }
});

// GET /api/bank/imports
bankRouter.get('/imports', (c) => {
  const imports = new BankRepository().listImports();
  return c.json({ success: true, count: imports.length, imports });
});

// GET /api/bank/movements?from=&to=&source=&importId=
bankRouter.get('/movements', (c) => {
  const parsed = BankMovementsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }
  const movements = new BankRepository().listMovements(parsed.data);
  return c.json({ success: true, count: movements.length, movements });
});
