import type { Bot } from 'grammy';
import { HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';

import { silentLogger } from '../src/logging.js';
import { runSanityChecks, SanityCheckError } from '../src/sanity-checks.js';
import { createTestDb } from './db/helper.js';
import { createFakeOverseerr } from './fakes/overseerr.js';

// `runSanityChecks` only touches `bot.api.getMe` and `bot.api.getChat`.
// Rather than stand up a real grammY Bot (which would require a token and
// a network boundary we'd then have to mock), we hand it a narrow stub and
// cast. If the real surface grows, the cast will start failing and we
// revisit.
interface FakeBotApi {
  getMe: () => Promise<unknown>;
  getChat: () => Promise<unknown>;
}
function asBot(api: FakeBotApi): Bot {
  return { api } as unknown as Bot;
}

/**
 * Approximate the shape grammY hands us on a real network failure:
 * `HttpError.message` is the safe, token-free text grammY crafted
 * (`sensitiveLogs: false` is the default). `HttpError.error` holds the
 * raw fetch rejection, whose `.message` embeds the full request URL —
 * including the `/bot<TOKEN>/` path segment. `.code` on the fetch error
 * (or its cause, depending on node-fetch vs native fetch) carries the
 * system-level reason (`ENOTFOUND`, `ETIMEDOUT`, ...).
 */
function grammyNetworkFailure(method: 'getMe' | 'getChat'): HttpError {
  const fetchError = Object.assign(
    new Error(
      `request to https://api.telegram.org/bot123:SECRET/${method} failed, reason: `,
    ),
    { code: 'ENOTFOUND' },
  );
  return new HttpError(`Network request for '${method}' failed!`, fetchError);
}

describe('runSanityChecks', () => {
  it('surfaces the system error code from a grammY HttpError without leaking the wrapped URL', async () => {
    const db = await createTestDb();
    const overseerr = createFakeOverseerr();
    const bot = asBot({
      getChat: () => Promise.resolve({}),
      getMe: () => Promise.reject(grammyNetworkFailure('getMe')),
    });

    await expect(
      runSanityChecks({
        bot,
        db,
        logger: silentLogger,
        overseerr,
        ownerTelegramUserId: 42,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof SanityCheckError)) {
        return false;
      }
      const issue = error.issues.find(i => i.check === 'telegram_get_me');
      if (!issue) {
        return false;
      }
      // Outer grammY message is safe; system code is the useful diagnostic.
      // The wrapped fetch error's `.message` embeds the bot token URL and
      // must never appear.
      return (
        issue.message.includes("Network request for 'getMe' failed!") &&
        issue.message.includes('ENOTFOUND') &&
        !issue.message.includes('SECRET') &&
        !issue.message.includes('bot123:')
      );
    });
  });

  it('preserves the owner-chat hint alongside the system error code without leaking the wrapped URL', async () => {
    const db = await createTestDb();
    const overseerr = createFakeOverseerr();
    const bot = asBot({
      getChat: () => Promise.reject(grammyNetworkFailure('getChat')),
      getMe: () => Promise.resolve({ id: 1, is_bot: true }),
    });

    await expect(
      runSanityChecks({
        bot,
        db,
        logger: silentLogger,
        overseerr,
        ownerTelegramUserId: 42,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof SanityCheckError)) {
        return false;
      }
      const issue = error.issues.find(
        i => i.check === 'telegram_get_owner_chat',
      );
      if (!issue) {
        return false;
      }
      return (
        /DMed the bot/.test(issue.message) &&
        issue.message.includes("Network request for 'getChat' failed!") &&
        issue.message.includes('ENOTFOUND') &&
        !issue.message.includes('SECRET') &&
        !issue.message.includes('bot123:')
      );
    });
  });

  it('walks the full cause chain for non-grammY errors', async () => {
    const db = await createTestDb();
    // Overseerr errors are not grammY HttpErrors, so the full chain is
    // safe to surface — no secrets are embedded in Overseerr error
    // messages. Confirms the grammY-specific redaction path doesn't
    // accidentally gate the generic traversal.
    const overseerr = createFakeOverseerr();
    overseerr.getStatus = () =>
      Promise.reject(
        new Error('overseerr unreachable', {
          cause: new Error('connect ECONNREFUSED 10.0.0.5:5055'),
        }),
      );
    const bot = asBot({
      getChat: () => Promise.resolve({}),
      getMe: () => Promise.resolve({ id: 1, is_bot: true }),
    });

    await expect(
      runSanityChecks({
        bot,
        db,
        logger: silentLogger,
        overseerr,
        ownerTelegramUserId: 42,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof SanityCheckError)) {
        return false;
      }
      const issue = error.issues.find(i => i.check === 'overseerr_status');
      if (!issue) {
        return false;
      }
      return (
        issue.message.includes('overseerr unreachable') &&
        issue.message.includes('ECONNREFUSED')
      );
    });
  });
});
