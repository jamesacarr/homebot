import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { createDb, runMigrations } from '../../src/db/index.js';

describe('runMigrations', () => {
  it('is idempotent: running twice on the same DB is a no-op', async () => {
    const db = createDb(':memory:');
    try {
      await runMigrations(db);
      await runMigrations(db);

      // The only way to prove both calls succeeded without reintroducing DDL
      // is that the schema still queries correctly afterwards.
      await db
        .insertInto('users')
        .values({
          decidedAt: null,
          decidedBy: null,
          lastRequestAt: 1,
          requestedAt: 1,
          status: 'pending',
          telegramUserId: 1,
          telegramUsername: null,
        })
        .execute();
      const user = await db.selectFrom('users').selectAll().executeTakeFirst();
      expect(user?.telegramUserId).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  it('enables SQLite foreign key enforcement on the connection', async () => {
    const db = createDb(':memory:');
    try {
      await runMigrations(db);
      // CamelCasePlugin rewrites the result key; assert on the camelCase form.
      const { rows } = await sql<{
        foreignKeys: number;
      }>`PRAGMA foreign_keys`.execute(db);
      expect(rows[0]?.foreignKeys).toBe(1);
    } finally {
      await db.destroy();
    }
  });
});
