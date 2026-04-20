import { describe, expect, it } from 'vitest';

import type { User } from '../../src/db/users.js';
import { decideAccess } from '../../src/telegram/access.js';

const OWNER_ID = 11111;

function makeUser(overrides: Partial<User> = {}): User {
  return {
    decidedAt: null,
    decidedBy: null,
    lastRequestAt: null,
    requestedAt: 0,
    status: 'approved',
    telegramUserId: 22222,
    telegramUsername: 'someone',
    ...overrides,
  };
}

describe('decideAccess', () => {
  it('lets the owner through even if they have no users-table row', () => {
    expect(
      decideAccess({
        ownerTelegramUserId: OWNER_ID,
        senderTelegramUserId: OWNER_ID,
        userRow: null,
      }),
    ).toEqual({ kind: 'proceed' });
  });

  it('lets the owner through even if their row is somehow denied', () => {
    // Owner status is config-driven, not DB-driven. A stray DB row should
    // never lock the owner out of their own bot.
    expect(
      decideAccess({
        ownerTelegramUserId: OWNER_ID,
        senderTelegramUserId: OWNER_ID,
        userRow: makeUser({ status: 'denied', telegramUserId: OWNER_ID }),
      }),
    ).toEqual({ kind: 'proceed' });
  });

  it('lets approved non-owner users through', () => {
    expect(
      decideAccess({
        ownerTelegramUserId: OWNER_ID,
        senderTelegramUserId: 22222,
        userRow: makeUser({ status: 'approved' }),
      }),
    ).toEqual({ kind: 'proceed' });
  });

  it('returns prompt_for_access when the user is unknown', () => {
    expect(
      decideAccess({
        ownerTelegramUserId: OWNER_ID,
        senderTelegramUserId: 22222,
        userRow: null,
      }),
    ).toEqual({ kind: 'prompt_for_access' });
  });

  it('silently drops a user with status=pending', () => {
    expect(
      decideAccess({
        ownerTelegramUserId: OWNER_ID,
        senderTelegramUserId: 22222,
        userRow: makeUser({ status: 'pending' }),
      }),
    ).toEqual({ kind: 'drop_silently', status: 'pending' });
  });

  it('silently drops a user with status=denied', () => {
    expect(
      decideAccess({
        ownerTelegramUserId: OWNER_ID,
        senderTelegramUserId: 22222,
        userRow: makeUser({ status: 'denied' }),
      }),
    ).toEqual({ kind: 'drop_silently', status: 'denied' });
  });

  it('silently drops a user with status=revoked', () => {
    expect(
      decideAccess({
        ownerTelegramUserId: OWNER_ID,
        senderTelegramUserId: 22222,
        userRow: makeUser({ status: 'revoked' }),
      }),
    ).toEqual({ kind: 'drop_silently', status: 'revoked' });
  });
});
