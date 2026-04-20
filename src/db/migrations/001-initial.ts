import type { Kysely } from 'kysely';
import { sql } from 'kysely';

// biome-ignore lint/suspicious/noExplicitAny: kysely migration convention — schema unknown at migration time
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('telegramUserId', 'integer', c => c.primaryKey())
    .addColumn('telegramUsername', 'text')
    .addColumn('status', 'text', c =>
      c
        .notNull()
        // Raw SQL: the `status` column name is single-word so snake_case and
        // camelCase coincide here. If the column is ever renamed, update this
        // reference manually — kysely's builder won't track it.
        .check(sql`status IN ('pending', 'approved', 'denied', 'revoked')`),
    )
    .addColumn('requestedAt', 'integer', c => c.notNull())
    .addColumn('decidedAt', 'integer')
    .addColumn('decidedBy', 'integer')
    .addColumn('lastRequestAt', 'integer')
    .execute();

  await db.schema
    .createIndex('idx_users_status')
    .on('users')
    .column('status')
    .execute();

  await db.schema
    .createTable('conversationTurns')
    .addColumn('id', 'integer', c => c.primaryKey())
    .addColumn('telegramUserId', 'integer', c => c.notNull())
    .addColumn('messagesJson', 'text', c => c.notNull())
    .addColumn('createdAt', 'integer', c => c.notNull())
    .execute();

  await db.schema
    .createIndex('idx_turns_user_time')
    .on('conversationTurns')
    .columns(['telegramUserId', 'createdAt'])
    .execute();

  await db.schema
    .createTable('dailyCost')
    .addColumn('dayUtc', 'text', c => c.primaryKey())
    .addColumn('costUsd', 'real', c => c.notNull().defaultTo(0))
    .execute();
}

// biome-ignore lint/suspicious/noExplicitAny: kysely migration convention — schema unknown at migration time
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('dailyCost').execute();
  await db.schema.dropTable('conversationTurns').execute();
  await db.schema.dropTable('users').execute();
}
