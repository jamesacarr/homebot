import type { AppDb } from './index.js';
import type { UserStatus } from './types.js';

export interface User {
  telegramUserId: number;
  telegramUsername: string | null;
  status: UserStatus;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: number | null;
  lastRequestAt: number | null;
}

export async function findUser(
  db: AppDb,
  telegramUserId: number,
): Promise<User | null> {
  const row = await db
    .selectFrom('users')
    .selectAll()
    .where('telegramUserId', '=', telegramUserId)
    .executeTakeFirst();
  return row ?? null;
}

export interface RecordAccessRequestInput {
  telegramUserId: number;
  telegramUsername: string | null;
  now: number;
}

export async function recordAccessRequest(
  db: AppDb,
  input: RecordAccessRequestInput,
): Promise<void> {
  await db
    .insertInto('users')
    .values({
      decidedAt: null,
      decidedBy: null,
      lastRequestAt: input.now,
      requestedAt: input.now,
      status: 'pending',
      telegramUserId: input.telegramUserId,
      telegramUsername: input.telegramUsername,
    })
    .execute();
}

export interface DecideUserInput {
  telegramUserId: number;
  decidedBy: number;
  now: number;
}

async function decide(
  db: AppDb,
  input: DecideUserInput,
  nextStatus: 'approved' | 'denied',
): Promise<void> {
  // Only flip the row if it is still pending. Stale approve/deny callbacks on
  // an already-decided user must not overwrite the earlier decision.
  await db
    .updateTable('users')
    .set({
      decidedAt: input.now,
      decidedBy: input.decidedBy,
      status: nextStatus,
    })
    .where('telegramUserId', '=', input.telegramUserId)
    .where('status', '=', 'pending')
    .execute();
}

export function approveUser(db: AppDb, input: DecideUserInput): Promise<void> {
  return decide(db, input, 'approved');
}

export function denyUser(db: AppDb, input: DecideUserInput): Promise<void> {
  return decide(db, input, 'denied');
}

export interface TouchLastRequestAtInput {
  telegramUserId: number;
  now: number;
}

export async function touchLastRequestAt(
  db: AppDb,
  input: TouchLastRequestAtInput,
): Promise<void> {
  await db
    .updateTable('users')
    .set({ lastRequestAt: input.now })
    .where('telegramUserId', '=', input.telegramUserId)
    .execute();
}
