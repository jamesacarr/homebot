import type { Bot } from 'grammy';

import type { AppDb } from './db/index.js';
import type { Logger } from './logging.js';
import type { OverseerrClient } from './overseerr/client.js';

const STARTUP_TIMEOUT_MS = 5_000;

export interface SanityCheckIssue {
  check: string;
  message: string;
}

export class SanityCheckError extends Error {
  constructor(public readonly issues: SanityCheckIssue[]) {
    super(
      `Startup sanity checks failed:\n${issues.map(i => `  - ${i.check}: ${i.message}`).join('\n')}`,
    );
    this.name = 'SanityCheckError';
  }
}

export interface SanityCheckDeps {
  db: AppDb;
  bot: Bot;
  overseerr: OverseerrClient;
  ownerTelegramUserId: number;
  logger: Logger;
}

/**
 * Per plan.md, fail-fast on any of:
 *  1. DB writable + migrations clean (assumed already run by caller — we
 *     just probe with a SELECT 1 here).
 *  2. Overseerr `/api/v1/status` answers within 5s.
 *  3. Telegram `getMe()` succeeds (token valid).
 *  4. Telegram `getChat(OWNER)` resolves (owner id is a real user reachable).
 *
 * Checks run in parallel and every failure is collected into one error, so
 * the operator sees all issues at once instead of fixing them one at a time.
 */
export async function runSanityChecks(deps: SanityCheckDeps): Promise<void> {
  const outcomes = await Promise.all([
    runCheck('db_select', async () => {
      await deps.db.selectNoFrom(eb => eb.lit(1).as('one')).executeTakeFirst();
    }),
    runCheck('overseerr_status', async () => {
      await deps.overseerr.getStatus({
        signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
      });
    }),
    runCheck('telegram_get_me', async () => {
      await deps.bot.api.getMe();
    }),
    runCheck('telegram_get_owner_chat', async () => {
      try {
        await deps.bot.api.getChat(deps.ownerTelegramUserId);
      } catch (error) {
        // Telegram's `getChat` needs a prior message from the owner (the bot
        // has no way to reach users who haven't spoken to it first). Add a
        // one-line hint to the error so the operator doesn't chase a
        // phantom misconfiguration.
        const base = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${base} — ensure the owner has DMed the bot at least once so Telegram knows the chat exists.`,
        );
      }
    }),
  ]);

  const issues = outcomes.filter((o): o is SanityCheckIssue => o !== null);
  if (issues.length > 0) {
    throw new SanityCheckError(issues);
  }
}

async function runCheck(
  check: string,
  fn: () => Promise<void>,
): Promise<SanityCheckIssue | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return {
      check,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
