import { sql } from 'kysely';

import type { AppDb } from './index.js';

/**
 * Format a millisecond timestamp as the UTC-day key used by `daily_cost`.
 * Always returns `YYYY-MM-DD`. Centralised here so any future change to the
 * day-bucket convention only updates one place.
 */
export function utcDayKey(nowMs: number): string {
  const d = new Date(nowMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

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
  // Note: the raw SQL below references `cost_usd` in snake_case because it
  // bypasses the CamelCasePlugin. If the column is ever renamed via a
  // migration, update this reference too — kysely's builder won't catch it.
  await db
    .insertInto('dailyCost')
    .values({ costUsd: deltaUsd, dayUtc })
    .onConflict(oc =>
      oc.column('dayUtc').doUpdateSet({ costUsd: sql`cost_usd + ${deltaUsd}` }),
    )
    .execute();
}
