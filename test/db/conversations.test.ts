import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadRecentTurnMessages,
  recordTurn,
} from '../../src/db/conversations.js';
import type { AppDb } from '../../src/db/index.js';
import { createTestDb } from './helper.js';

const ALICE = 42;
const BOB = 99;

describe('conversations', () => {
  let db: AppDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('loadRecentTurnMessages returns [] for a user with no history', async () => {
    expect(await loadRecentTurnMessages(db, ALICE, 15)).toEqual([]);
  });

  it('round-trips a single turn: recordTurn then loadRecentTurnMessages', async () => {
    const messages = [
      { content: 'add The Bear', role: 'user' },
      { content: 'Sure!', role: 'assistant' },
    ];
    await recordTurn(db, {
      maxTurns: 15,
      messages,
      now: 1700000000,
      telegramUserId: ALICE,
    });

    expect(await loadRecentTurnMessages(db, ALICE, 15)).toEqual(messages);
  });

  it('concatenates multiple turns in chronological order', async () => {
    await recordTurn(db, {
      maxTurns: 15,
      messages: [{ content: 'first', role: 'user' }],
      now: 1700000000,
      telegramUserId: ALICE,
    });
    await recordTurn(db, {
      maxTurns: 15,
      messages: [{ content: 'second', role: 'user' }],
      now: 1700000100,
      telegramUserId: ALICE,
    });

    const messages = await loadRecentTurnMessages(db, ALICE, 15);
    expect(messages).toEqual([
      { content: 'first', role: 'user' },
      { content: 'second', role: 'user' },
    ]);
  });

  it('isolates turns per user', async () => {
    await recordTurn(db, {
      maxTurns: 15,
      messages: [{ content: 'from alice', role: 'user' }],
      now: 1700000000,
      telegramUserId: ALICE,
    });
    await recordTurn(db, {
      maxTurns: 15,
      messages: [{ content: 'from bob', role: 'user' }],
      now: 1700000000,
      telegramUserId: BOB,
    });

    expect(await loadRecentTurnMessages(db, ALICE, 15)).toEqual([
      { content: 'from alice', role: 'user' },
    ]);
    expect(await loadRecentTurnMessages(db, BOB, 15)).toEqual([
      { content: 'from bob', role: 'user' },
    ]);
  });

  it('trims a user to the most recent maxTurns turns on insert', async () => {
    // Insert 5 turns with maxTurns=3. Oldest 2 should be discarded.
    for (let i = 0; i < 5; i++) {
      await recordTurn(db, {
        maxTurns: 3,
        messages: [{ content: `turn-${i}`, role: 'user' }],
        now: 1700000000 + i,
        telegramUserId: ALICE,
      });
    }

    const messages = await loadRecentTurnMessages(db, ALICE, 15);
    expect(messages).toEqual([
      { content: 'turn-2', role: 'user' },
      { content: 'turn-3', role: 'user' },
      { content: 'turn-4', role: 'user' },
    ]);
  });

  it('loadRecentTurnMessages respects its maxTurns limit even if more rows exist', async () => {
    for (let i = 0; i < 5; i++) {
      await recordTurn(db, {
        maxTurns: 100, // no trim
        messages: [{ content: `turn-${i}`, role: 'user' }],
        now: 1700000000 + i,
        telegramUserId: ALICE,
      });
    }

    const messages = await loadRecentTurnMessages(db, ALICE, 2);
    expect(messages).toEqual([
      { content: 'turn-3', role: 'user' },
      { content: 'turn-4', role: 'user' },
    ]);
  });

  it('silently skips rows whose version envelope is not v:1', async () => {
    // Seed one valid turn via the public API.
    await recordTurn(db, {
      maxTurns: 15,
      messages: [{ content: 'good', role: 'user' }],
      now: 1700000000,
      telegramUserId: ALICE,
    });
    // Seed a future-version row directly.
    await db
      .insertInto('conversationTurns')
      .values({
        createdAt: 1700000100,
        messagesJson: JSON.stringify({
          messages: [{ content: 'future', role: 'user' }],
          v: 99,
        }),
        telegramUserId: ALICE,
      })
      .execute();

    // The valid row's content should be present; the unknown-version row should
    // be dropped without crashing the loader.
    expect(await loadRecentTurnMessages(db, ALICE, 15)).toEqual([
      { content: 'good', role: 'user' },
    ]);
  });
});
