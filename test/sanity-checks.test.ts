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

function grammyNetworkFailure(method: 'getMe' | 'getChat'): HttpError {
  // Mirror the shape node's fetch produces: a generic "fetch failed" with
  // the low-level reason (DNS, connection refused, etc.) hanging off
  // `.cause`. grammY then wraps the fetch rejection in an HttpError whose
  // `.error` property is the original fetch error.
  const dnsError = new Error('getaddrinfo ENOTFOUND api.telegram.org');
  const fetchError = new Error('fetch failed', { cause: dnsError });
  return new HttpError(`Network request for '${method}' failed!`, fetchError);
}

describe('runSanityChecks', () => {
  it('surfaces the underlying fetch cause when grammY reports a network failure on getMe', async () => {
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
      return (
        issue.message.includes("Network request for 'getMe' failed!") &&
        issue.message.includes('fetch failed') &&
        issue.message.includes('getaddrinfo ENOTFOUND api.telegram.org')
      );
    });
  });

  it('preserves the underlying network cause alongside the owner-chat hint', async () => {
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
        issue.message.includes('getaddrinfo ENOTFOUND api.telegram.org')
      );
    });
  });
});
