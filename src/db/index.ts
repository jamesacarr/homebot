import BetterSqlite3 from 'better-sqlite3';
import type { MigrationProvider } from 'kysely';
import { CamelCasePlugin, Kysely, Migrator, SqliteDialect } from 'kysely';

import * as migration001 from './migrations/001-initial.js';
import type { Database } from './types.js';

export type AppDb = Kysely<Database>;

export function createDb(path: string): AppDb {
  const sqlite = new BetterSqlite3(path);
  // SQLite disables FK enforcement by default. Enable it so any future
  // foreign-key declaration in a migration is actually honoured.
  sqlite.pragma('foreign_keys = ON');
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
    plugins: [new CamelCasePlugin()],
  });
}

const migrations: MigrationProvider = {
  getMigrations() {
    return Promise.resolve({
      '001-initial': migration001,
    });
  },
};

export async function runMigrations(db: AppDb): Promise<void> {
  const migrator = new Migrator({ db, provider: migrations });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    const failed = results?.find(r => r.status === 'Error');
    throw new Error(
      `Migration failed${failed ? ` at ${failed.migrationName}` : ''}: ${String(error)}`,
    );
  }
}
