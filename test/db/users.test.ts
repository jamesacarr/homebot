import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppDb } from '../../src/db/index.js';
import {
  approveUser,
  denyUser,
  findUser,
  recordAccessRequest,
  touchLastRequestAt,
} from '../../src/db/users.js';
import { createTestDb } from './helper.js';

const OWNER = 1;
const ALICE = 42;

describe('users', () => {
  let db: AppDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('findUser returns null for a user that has never contacted the bot', async () => {
    expect(await findUser(db, 999)).toBeNull();
  });

  it('recordAccessRequest creates a new pending user with timestamps', async () => {
    await recordAccessRequest(db, {
      now: 1700000000,
      telegramUserId: ALICE,
      telegramUsername: 'alice',
    });

    const user = await findUser(db, ALICE);
    expect(user).toEqual({
      decidedAt: null,
      decidedBy: null,
      lastRequestAt: 1700000000,
      requestedAt: 1700000000,
      status: 'pending',
      telegramUserId: ALICE,
      telegramUsername: 'alice',
    });
  });

  it('approveUser flips a pending user to approved and records approver + timestamp', async () => {
    await recordAccessRequest(db, {
      now: 1700000000,
      telegramUserId: ALICE,
      telegramUsername: 'alice',
    });

    await approveUser(db, {
      decidedBy: OWNER,
      now: 1700000100,
      telegramUserId: ALICE,
    });

    const user = await findUser(db, ALICE);
    expect(user?.status).toBe('approved');
    expect(user?.decidedAt).toBe(1700000100);
    expect(user?.decidedBy).toBe(OWNER);
  });

  it('denyUser flips a pending user to denied', async () => {
    await recordAccessRequest(db, {
      now: 1700000000,
      telegramUserId: ALICE,
      telegramUsername: 'alice',
    });

    await denyUser(db, {
      decidedBy: OWNER,
      now: 1700000100,
      telegramUserId: ALICE,
    });

    const user = await findUser(db, ALICE);
    expect(user?.status).toBe('denied');
    expect(user?.decidedAt).toBe(1700000100);
    expect(user?.decidedBy).toBe(OWNER);
  });

  it('approveUser is a no-op for a user whose status is already decided', async () => {
    await recordAccessRequest(db, {
      now: 1700000000,
      telegramUserId: ALICE,
      telegramUsername: 'alice',
    });
    await denyUser(db, {
      decidedBy: OWNER,
      now: 1700000100,
      telegramUserId: ALICE,
    });
    // A stale approve click must not overwrite a denial.
    await approveUser(db, {
      decidedBy: OWNER,
      now: 1700000200,
      telegramUserId: ALICE,
    });

    const user = await findUser(db, ALICE);
    expect(user?.status).toBe('denied');
    expect(user?.decidedAt).toBe(1700000100);
  });

  it('touchLastRequestAt updates the timestamp in place', async () => {
    await recordAccessRequest(db, {
      now: 1700000000,
      telegramUserId: ALICE,
      telegramUsername: 'alice',
    });

    await touchLastRequestAt(db, { now: 1700000500, telegramUserId: ALICE });

    const user = await findUser(db, ALICE);
    expect(user?.lastRequestAt).toBe(1700000500);
    expect(user?.requestedAt).toBe(1700000000);
  });
});
