import { loadRecentTurnMessages, recordTurn } from '../db/conversations.js';
import { addCost, getDailyCost, utcDayKey } from '../db/cost.js';
import type { AppDb } from '../db/index.js';
import { findUser, touchLastRequestAt } from '../db/users.js';
import type {
  Orchestrator,
  OrchestratorOutput,
  Reply,
} from '../llm/orchestrator.js';
import type { Logger } from '../logging.js';
import { decideAccess } from './access.js';
import {
  checkCostCap,
  formatCappedReply,
  hoursUntilUtcMidnight,
} from './cost-cap.js';

/**
 * Default budget for the orchestrator's master `AbortSignal` — the per-message
 * ceiling from plan.md. The caller can override for tests.
 */
const DEFAULT_PER_MESSAGE_TIMEOUT_MS = 120_000;

export interface RunTextTurnInput {
  telegramUserId: number;
  /** Optional username — stored on the users row when an unknown user later taps Request access. */
  telegramUsername?: string;
  incomingText: string;
  now: number;

  db: AppDb;
  orchestrate: Orchestrator;
  logger: Logger;

  ownerTelegramUserId: number;
  capUsd: number;
  maxTurnsInHistory: number;

  /**
   * Optional master signal. When omitted, an internal 120s ceiling is used.
   * Tests pass an already-resolved/never-firing signal to avoid timer use.
   */
  abortSignal?: AbortSignal;
  /** Override the per-message timeout (default 120s). */
  perMessageTimeoutMs?: number;
}

export interface ReplyResult {
  kind: 'replies';
  replies: Reply[];
  /**
   * Persistence callback. Caller invokes it ONLY after all sends in `replies`
   * succeed (plan.md: send first, persist on success). Absent on paths where
   * there is no orchestrator turn to persist (cost-cap rejection, etc.).
   */
  commit?: () => Promise<void>;
}

export type RunTextTurnResult =
  | ReplyResult
  | { kind: 'prompt_for_access'; replies: Reply[] }
  | { kind: 'drop_silently' };

/**
 * Drives one inbound user text message end-to-end:
 *
 *   access check → cost cap → load history → orchestrate → record cost
 *
 * Returns replies for the adapter to send, plus an optional `commit()` the
 * caller invokes after sends succeed to persist the turn. This split enforces
 * plan.md's persistence ordering: "send first, persist on success" — if sends
 * fail the caller skips commit() and the user's retry starts cleanly.
 *
 * Cost recording happens BEFORE we return: the LLM call has already been
 * billed by the time the orchestrator resolves, so a downstream send failure
 * must not refund the day's budget.
 */
export async function runTextTurn(
  input: RunTextTurnInput,
): Promise<RunTextTurnResult> {
  const log = input.logger.child({ telegramUserId: input.telegramUserId });

  // 1. Access decision.
  const userRow = await findUser(input.db, input.telegramUserId);
  const access = decideAccess({
    ownerTelegramUserId: input.ownerTelegramUserId,
    senderTelegramUserId: input.telegramUserId,
    userRow,
  });

  if (access.kind === 'drop_silently') {
    log.debug({ status: access.status }, 'access_dropped_silently');
    return { kind: 'drop_silently' };
  }
  if (access.kind === 'prompt_for_access') {
    return {
      kind: 'prompt_for_access',
      replies: [
        {
          kind: 'text',
          text: "Hi — I don't recognise you. Tap below to request access from the owner.",
        },
      ],
    };
  }

  // 2. Cost cap pre-check.
  const today = utcDayKey(input.now);
  const dailyCost = await getDailyCost(input.db, today);
  const isOwner = input.telegramUserId === input.ownerTelegramUserId;
  const cap = checkCostCap({
    capUsd: input.capUsd,
    dailyCostUsd: dailyCost,
    isOwner,
  });
  if (cap.kind === 'block') {
    log.warn({ capUsd: input.capUsd, dailyCostUsd: dailyCost }, 'cost_cap_hit');
    return {
      kind: 'replies',
      replies: [
        {
          kind: 'text',
          text: formatCappedReply(hoursUntilUtcMidnight(input.now)),
        },
      ],
    };
  }

  // 3. Load history.
  const priorMessages = await loadRecentTurnMessages(
    input.db,
    input.telegramUserId,
    input.maxTurnsInHistory,
  );

  // 4. Orchestrate.
  const timeoutMs = input.perMessageTimeoutMs ?? DEFAULT_PER_MESSAGE_TIMEOUT_MS;
  const internalSignal = AbortSignal.timeout(timeoutMs);
  const abortSignal =
    input.abortSignal === undefined
      ? internalSignal
      : AbortSignal.any([internalSignal, input.abortSignal]);

  let output: OrchestratorOutput;
  try {
    output = await input.orchestrate({
      abortSignal,
      incomingText: input.incomingText,
      now: input.now,
      priorMessages,
      telegramUserId: input.telegramUserId,
    });
  } catch (error) {
    log.error({ err: error }, 'llm_call_failed');
    return {
      kind: 'replies',
      replies: [
        {
          kind: 'text',
          text: 'Something went wrong — try again in a moment?',
        },
      ],
    };
  }

  // 5. Record cost immediately. The LLM call has been billed; a downstream
  // send failure must not refund the day budget.
  if (output.costDeltaUsd > 0) {
    await addCost(input.db, today, output.costDeltaUsd);
  }

  // 6. Hand the caller a commit() that persists the turn on successful send.
  const commit = async (): Promise<void> => {
    await recordTurn(input.db, {
      maxTurns: input.maxTurnsInHistory,
      messages: output.turnToPersist,
      now: input.now,
      telegramUserId: input.telegramUserId,
    });
    await touchLastRequestAt(input.db, {
      now: input.now,
      telegramUserId: input.telegramUserId,
    });
  };

  return { commit, kind: 'replies', replies: output.replies };
}
