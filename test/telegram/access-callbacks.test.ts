import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppDb } from '../../src/db/index.js';
import { findUser, recordAccessRequest } from '../../src/db/users.js';
import type { Reply } from '../../src/llm/orchestrator.js';
import { silentLogger } from '../../src/logging.js';
import {
  handleAccessDecision,
  handleAccessRequest,
} from '../../src/telegram/access-callbacks.js';
import { createTestDb } from '../db/helper.js';

const OWNER_ID = 11111;
const REQUESTER_ID = 22222;
const STRANGER_ID = 33333;

interface SentDm {
  chatId: number;
  replies: Reply[];
}

function makeAdapter(): {
  adapter: { send: (chatId: number, replies: Reply[]) => Promise<void> };
  sent: SentDm[];
} {
  const sent: SentDm[] = [];
  const adapter = {
    send: (chatId: number, replies: Reply[]) => {
      sent.push({ chatId, replies });
      return Promise.resolve();
    },
  };
  return { adapter, sent };
}

let db: AppDb;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.destroy();
});

describe('handleAccessRequest', () => {
  it('records a pending users row, DMs the owner, and confirms to the requester', async () => {
    const { adapter, sent } = makeAdapter();

    await handleAccessRequest({
      adapter,
      db,
      logger: silentLogger,
      now: 1234,
      ownerTelegramUserId: OWNER_ID,
      requesterTelegramUserId: REQUESTER_ID,
      requesterUsername: 'jane',
    });

    const row = await findUser(db, REQUESTER_ID);
    expect(row?.status).toBe('pending');
    expect(row?.telegramUsername).toBe('jane');

    // Owner gets a DM with approve/deny buttons.
    const ownerDm = sent.find(s => s.chatId === OWNER_ID);
    expect(ownerDm).toBeDefined();
    const keyboard = ownerDm?.replies.find(r => r.kind === 'keyboard');
    if (keyboard?.kind !== 'keyboard') {
      throw new Error('expected a keyboard reply for the owner');
    }
    expect(keyboard.buttons.map(b => b.data)).toEqual([
      `approve:${REQUESTER_ID}`,
      `deny:${REQUESTER_ID}`,
    ]);

    // Requester gets a confirmation.
    const requesterDm = sent.find(s => s.chatId === REQUESTER_ID);
    expect(requesterDm).toBeDefined();
    if (requesterDm?.replies[0]?.kind !== 'text') {
      throw new Error('expected text confirmation for requester');
    }
    expect(requesterDm.replies[0].text).toMatch(/sent|requested/i);
  });

  it('silently ignores a re-tap by an already-recorded user to avoid spamming the owner', async () => {
    // First tap.
    const first = makeAdapter();
    await handleAccessRequest({
      adapter: first.adapter,
      db,
      logger: silentLogger,
      now: 1000,
      ownerTelegramUserId: OWNER_ID,
      requesterTelegramUserId: REQUESTER_ID,
      requesterUsername: 'jane',
    });

    // Second tap (same user) — must NOT re-DM owner or requester. The first
    // notification is sufficient; repeating invites owner spam (especially
    // from a denied user tapping a stale button, once #1 is fixed).
    const second = makeAdapter();
    await handleAccessRequest({
      adapter: second.adapter,
      db,
      logger: silentLogger,
      now: 2000,
      ownerTelegramUserId: OWNER_ID,
      requesterTelegramUserId: REQUESTER_ID,
      requesterUsername: 'jane',
    });

    // Still one row, still pending. No new DMs went out on the second tap.
    const rows = await db
      .selectFrom('users')
      .selectAll()
      .where('telegramUserId', '=', REQUESTER_ID)
      .execute();
    expect(rows).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
  });
});

describe('handleAccessDecision', () => {
  beforeEach(async () => {
    await recordAccessRequest(db, {
      now: 100,
      telegramUserId: REQUESTER_ID,
      telegramUsername: 'jane',
    });
  });

  it('approves the user, flips the row to approved, and DMs the requester', async () => {
    const { adapter, sent } = makeAdapter();

    const result = await handleAccessDecision({
      adapter,
      db,
      decision: 'approve',
      fromTelegramUserId: OWNER_ID,
      logger: silentLogger,
      now: 999,
      ownerTelegramUserId: OWNER_ID,
      requesterTelegramUserId: REQUESTER_ID,
    });

    expect(result).toBe('applied');
    const row = await findUser(db, REQUESTER_ID);
    expect(row?.status).toBe('approved');
    expect(row?.decidedBy).toBe(OWNER_ID);

    const dm = sent.find(s => s.chatId === REQUESTER_ID);
    if (dm?.replies[0]?.kind !== 'text') {
      throw new Error('expected text DM for requester');
    }
    expect(dm.replies[0].text).toMatch(/granted|approved/i);
  });

  it('denies the user, flips the row to denied, and DMs the requester', async () => {
    const { adapter, sent } = makeAdapter();

    await handleAccessDecision({
      adapter,
      db,
      decision: 'deny',
      fromTelegramUserId: OWNER_ID,
      logger: silentLogger,
      now: 999,
      ownerTelegramUserId: OWNER_ID,
      requesterTelegramUserId: REQUESTER_ID,
    });

    const row = await findUser(db, REQUESTER_ID);
    expect(row?.status).toBe('denied');

    const dm = sent.find(s => s.chatId === REQUESTER_ID);
    if (dm?.replies[0]?.kind !== 'text') {
      throw new Error('expected text DM for requester');
    }
    expect(dm.replies[0].text).toMatch(/denied/i);
  });

  it('rejects a decision tap from anyone other than the owner without writing or DM-ing', async () => {
    // Defensive belt-and-braces per plan.md — even though the message is
    // DM'd to owner only, an attacker who learned the callback_data format
    // must not be able to approve themselves.
    const { adapter, sent } = makeAdapter();

    const result = await handleAccessDecision({
      adapter,
      db,
      decision: 'approve',
      fromTelegramUserId: STRANGER_ID,
      logger: silentLogger,
      now: 999,
      ownerTelegramUserId: OWNER_ID,
      requesterTelegramUserId: REQUESTER_ID,
    });

    expect(result).toBe('rejected_not_owner');
    const row = await findUser(db, REQUESTER_ID);
    expect(row?.status).toBe('pending');
    expect(sent).toHaveLength(0);
  });

  it('is idempotent for an already-decided user (does not re-DM)', async () => {
    // First approval.
    const first = makeAdapter();
    await handleAccessDecision({
      adapter: first.adapter,
      db,
      decision: 'approve',
      fromTelegramUserId: OWNER_ID,
      logger: silentLogger,
      now: 999,
      ownerTelegramUserId: OWNER_ID,
      requesterTelegramUserId: REQUESTER_ID,
    });

    // Second approval — should be a no-op since status is no longer pending.
    const second = makeAdapter();
    const result = await handleAccessDecision({
      adapter: second.adapter,
      db,
      decision: 'approve',
      fromTelegramUserId: OWNER_ID,
      logger: silentLogger,
      now: 1000,
      ownerTelegramUserId: OWNER_ID,
      requesterTelegramUserId: REQUESTER_ID,
    });

    expect(result).toBe('noop_already_decided');
    expect(second.sent).toHaveLength(0);
  });
});
