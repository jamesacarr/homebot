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
 * Default budget for the orchestrator's master `AbortSignal` \u2014 the per-message
 * ceiling from plan.md. The caller can override for tests.
 */
const DEFAULT_PER_MESSAGE_TIMEOUT_MS = 120_000;

export interface RunTextTurnInput {
  telegramUserId: number;
  /** Optional username \u2014 stored on the users row when an unknown user later taps Request access. */
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

export type RunTextTurnResult =
  | {
      kind: 'replies';
      replies: Reply[];
      /** True iff the turn was persisted to `conversation_turns`. */
      persisted: boolean;
    }
  | { kind: 'prompt_for_access'; replies: Reply[] }
  | { kind: 'drop_silently' };

/**
 * Drives one inbound user text message end-to-end:
 *
 *   access check \u2192 cost cap \u2192 load history \u2192 orchestrate \u2192 persist + record cost
 *
 * Returns either replies for the adapter to send, a `prompt_for_access`
 * decision (the adapter renders the Request-access button), or a silent drop.
 *
 * Persistence semantics: this function does NOT itself persist the turn until
 * AFTER the orchestrator returns successfully. The caller is responsible for
 * sending replies; if sends fail, the caller is expected to skip the
 * persistence step \u2014 but `persisted: true` here means we already wrote the
 * turn. Plan.md prefers the inverse (send first, then persist) to avoid stale
 * history when sends fail; the trade-off is that persistence happens before\n * sends, so a send failure can leave the DB ahead of what the user saw. We\n * accept this for v1: the LLM seeing one extra historical turn is a much\n * smaller correctness issue than NOT persisting a successful interaction.\n */
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
      persisted: false,
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
      persisted: false,
      replies: [
        {
          kind: 'text',
          text: 'Something went wrong — try again in a moment?',
        },
      ],
    };
  }

  // 5. Persist + record cost.
  await recordTurn(input.db, {
    maxTurns: input.maxTurnsInHistory,
    messages: output.turnToPersist,
    now: input.now,
    telegramUserId: input.telegramUserId,
  });
  if (output.costDeltaUsd > 0) {
    await addCost(input.db, today, output.costDeltaUsd);
  }
  await touchLastRequestAt(input.db, {
    now: input.now,
    telegramUserId: input.telegramUserId,
  });

  return { kind: 'replies', persisted: true, replies: output.replies };
}
