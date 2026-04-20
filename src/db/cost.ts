import { sql } from 'kysely';

import type { AppDb } from './index.js';

/**
 * Returns the cumulative USD spend for the given UTC day (format YYYY-MM-DD).
 * Days with no recorded spend return 0.
 */
export async function getDailyCost(db: AppDb, dayUtc: string): Promise<number> {
  const row = await db
    .selectFrom('dailyCost')
    .select('costUsd')
    .where('dayUtc', '=', dayUtc)
    .executeTakeFirst();
  return row?.costUsd ?? 0;
}

/**
 * Adds `deltaUsd` to the given UTC day's total, creating the row if needed.
 * Uses SQLite's ON CONFLICT UPSERT so the operation is a single round-trip.
 */
export async function addCost(
  db: AppDb,
  dayUtc: string,
  deltaUsd: number,
): Promise<void> {
  await db
    .insertInto('dailyCost')
    .values({ costUsd: deltaUsd, dayUtc })
    .onConflict(oc =>
      oc.column('dayUtc').doUpdateSet({ costUsd: sql`cost_usd + ${deltaUsd}` }),
    )
    .execute();
}
