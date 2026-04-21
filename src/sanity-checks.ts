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
 * Fail-fast on any of:
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
        // has no way to reach users who haven't spoken to it first). Wrap
        // the original error with a hint; `describeError` will unroll the
        // cause chain so the operator sees both the hint and the real
        // network reason (DNS, routing, TLS, ...) in one line.
        throw new Error(
          'ensure the owner has DMed the bot at least once so Telegram knows the chat exists',
          { cause: error },
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
    return { check, message: describeError(error) };
  }
}

/**
 * Flatten an error and every unwrappable cause into a single `a → b → c`
 * line. Walks both the standard `Error.cause` and grammY's non-standard
 * `HttpError.error` (which predates `cause` being widely available and
 * never got retrofitted). Without this, a Telegram outage surfaces as the
 * generic "Network request for 'getMe' failed!" with the real reason
 * (ENOTFOUND, ETIMEDOUT, TLS, ...) discarded one level down.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message) {
        parts.push(current.message);
      }
      const next =
        (current as { cause?: unknown }).cause ??
        (current as { error?: unknown }).error;
      current = next;
    } else {
      parts.push(String(current));
      current = undefined;
    }
  }
  return parts.join(' → ');
}
