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
 * Throws `SanityCheckError` collecting every failure, so the operator sees
 * all issues at once instead of fixing them one at a time.
 */
export async function runSanityChecks(deps: SanityCheckDeps): Promise<void> {
  const issues: SanityCheckIssue[] = [];

  // 1. DB.
  try {
    await deps.db.selectNoFrom(eb => eb.lit(1).as('one')).executeTakeFirst();
  } catch (error) {
    issues.push({
      check: 'db_select',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // 2. Overseerr.
  try {
    await deps.overseerr.getStatus({
      signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
    });
  } catch (error) {
    issues.push({
      check: 'overseerr_status',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // 3. Telegram getMe.
  try {
    await deps.bot.api.getMe();
  } catch (error) {
    issues.push({
      check: 'telegram_get_me',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // 4. Telegram getChat(owner). Without this we'd happily start a bot whose
  // owner can't be DM'd, so access requests would silently fail at runtime.
  try {
    await deps.bot.api.getChat(deps.ownerTelegramUserId);
  } catch (error) {
    issues.push({
      check: 'telegram_get_owner_chat',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (issues.length > 0) {
    throw new SanityCheckError(issues);
  }
}
