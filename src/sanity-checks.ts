import type { Bot } from 'grammy';
import { HttpError } from 'grammy';

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
 * line.
 *
 * grammY's `HttpError` gets special handling: its `.message` is the
 * token-safe text grammY deliberately crafted (per `sensitiveLogs: false`
 * default), and its `.error` property holds the raw fetch rejection
 * whose message embeds the `/bot<TOKEN>/` URL. We surface only the
 * structured system code (`.code` / `.errno`) from the wrapped error,
 * never its message, and do not traverse further. See grammY's
 * ApiClientOptions docs on `sensitiveLogs` for the rationale.
 *
 * For other errors we walk both the standard `Error.cause` and any
 * `.error` fallback (some libraries predate `cause` and never migrated),
 * since no bot token is embedded in those chains.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof HttpError) {
      parts.push(current.message);
      const code = extractSystemCode(current.error);
      if (code) {
        parts.push(`[${code}]`);
      }
      current = undefined;
    } else if (current instanceof Error) {
      const label = labelError(current);
      if (label) {
        parts.push(label);
      }
      current =
        (current as { cause?: unknown }).cause ??
        (current as { error?: unknown }).error;
    } else {
      parts.push(String(current));
      current = undefined;
    }
  }
  return parts.join(' → ');
}

/**
 * Build a human label for a single Error. Prefers `.message`; falls back
 * to system-error `.code` / `.errno` when message is empty, and appends
 * `.code` if it's present but not already in the message.
 */
function labelError(error: Error): string {
  const code = (error as { code?: unknown }).code;
  const errno = (error as { errno?: unknown }).errno;
  const codeStr = typeof code === 'string' && code ? code : null;
  const errnoStr = typeof errno === 'number' ? `errno ${errno}` : null;
  if (error.message) {
    if (codeStr && !error.message.includes(codeStr)) {
      return `${error.message} [${codeStr}]`;
    }
    return error.message;
  }
  return codeStr ?? errnoStr ?? '';
}

/**
 * Walk up to a few cause levels looking for a string `.code` (e.g.
 * `ENOTFOUND`, `ETIMEDOUT`). Never reads `.message` — that's what may
 * contain the bot token URL when the wrapped error is a fetch rejection.
 */
function extractSystemCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!(current instanceof Error)) {
      return null;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
    if (current === undefined || current === null) {
      return null;
    }
  }
  return null;
}
