import type { AppDb } from '../../src/db/index.js';
import { createDb, runMigrations } from '../../src/db/index.js';

export async function createTestDb(): Promise<AppDb> {
  const db = createDb(':memory:');
  await runMigrations(db);
  return db;
}
