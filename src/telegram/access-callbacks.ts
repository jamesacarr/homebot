import { encodeAccessDecisionCallback } from '../callbacks.js';
import type { AppDb } from '../db/index.js';
import {
  approveUser,
  denyUser,
  findUser,
  recordAccessRequest,
} from '../db/users.js';
import type { Reply } from '../llm/orchestrator.js';
import type { Logger } from '../logging.js';

/**
 * Outbound DM surface for the access flow. Narrowed down so the handlers stay
 * grammY-agnostic and unit-testable. The grammY adapter implements this by
 * delegating to `renderReplies(api, chatId, replies)`.
 */
export interface AccessAdapter {
  send(chatId: number, replies: Reply[]): Promise<void>;
}

export interface HandleAccessRequestInput {
  requesterTelegramUserId: number;
  requesterUsername: string | null;
  ownerTelegramUserId: number;
  now: number;
  db: AppDb;
  adapter: AccessAdapter;
  logger: Logger;
}

/**
 * Handle a tap on the "Request access" button by an unknown user.
 *
 * Idempotent: if the user already has a row we silently no-op — re-DM-ing
 * the owner on every stale tap would be a spam vector (a denied user who
 * still has the button in their scroll history could chain taps). The
 * status-gated silent-drop on text messages + one-shot owner notification
 * here are sufficient per plan.md.
 */
export async function handleAccessRequest(
  input: HandleAccessRequestInput,
): Promise<void> {
  const log = input.logger.child({
    telegramUserId: input.requesterTelegramUserId,
  });

  const existing = await findUser(input.db, input.requesterTelegramUserId);
  if (existing !== null) {
    log.debug({ status: existing.status }, 'access_request_ignored_existing');
    return;
  }

  await recordAccessRequest(input.db, {
    now: input.now,
    telegramUserId: input.requesterTelegramUserId,
    telegramUsername: input.requesterUsername,
  });

  log.info(
    { telegramUsername: input.requesterUsername },
    'access_request_received',
  );

  // Display name in the owner DM. Use the username if we have one, otherwise
  // the numeric id so the owner has something to identify the requester by.
  const display = input.requesterUsername
    ? `@${input.requesterUsername}`
    : `user`;

  await input.adapter.send(input.ownerTelegramUserId, [
    {
      kind: 'text',
      text: `${display} (\`${input.requesterTelegramUserId}\`) is requesting access.`,
    },
    {
      buttons: [
        {
          data: encodeAccessDecisionCallback(
            'approve',
            input.requesterTelegramUserId,
          ),
          label: '✓ Approve',
        },
        {
          data: encodeAccessDecisionCallback(
            'deny',
            input.requesterTelegramUserId,
          ),
          label: '✗ Deny',
        },
      ],
      kind: 'keyboard',
      text: 'Decide:',
    },
  ]);

  await input.adapter.send(input.requesterTelegramUserId, [
    {
      kind: 'text',
      text: "Your request has been sent. I'll message you once it's decided.",
    },
  ]);
}

export interface HandleAccessDecisionInput {
  decision: 'approve' | 'deny';
  requesterTelegramUserId: number;
  /** Telegram user id of whoever tapped the button — must equal the owner. */
  fromTelegramUserId: number;
  ownerTelegramUserId: number;
  now: number;
  db: AppDb;
  adapter: AccessAdapter;
  logger: Logger;
}

export type AccessDecisionResult =
  | 'applied'
  | 'noop_already_decided'
  | 'rejected_not_owner';

/**
 * Handle the owner tapping ✓ Approve / ✗ Deny on a pending access request.
 *
 * Defensive `from === owner` check per plan.md: even though the prompt is
 * DM'd to the owner only, an attacker who learned the callback_data format
 * must not be able to self-approve.
 *
 * The DB layer's `approveUser` / `denyUser` are themselves idempotent (they
 * only flip rows that are still pending), so a stale tap on an already-
 * decided user is a silent no-op rather than a re-DM storm.
 */
export async function handleAccessDecision(
  input: HandleAccessDecisionInput,
): Promise<AccessDecisionResult> {
  if (input.fromTelegramUserId !== input.ownerTelegramUserId) {
    input.logger.warn(
      {
        decision: input.decision,
        fromTelegramUserId: input.fromTelegramUserId,
        telegramUserId: input.requesterTelegramUserId,
      },
      'access_decision_rejected_not_owner',
    );
    return 'rejected_not_owner';
  }

  const before = await findUser(input.db, input.requesterTelegramUserId);
  if (before === null || before.status !== 'pending') {
    return 'noop_already_decided';
  }

  if (input.decision === 'approve') {
    await approveUser(input.db, {
      decidedBy: input.fromTelegramUserId,
      now: input.now,
      telegramUserId: input.requesterTelegramUserId,
    });
    input.logger.info(
      {
        decidedBy: input.fromTelegramUserId,
        telegramUserId: input.requesterTelegramUserId,
      },
      'access_approved',
    );
    await input.adapter.send(input.requesterTelegramUserId, [
      {
        kind: 'text',
        text: 'Access granted. Try asking me to add something.',
      },
    ]);
  } else {
    await denyUser(input.db, {
      decidedBy: input.fromTelegramUserId,
      now: input.now,
      telegramUserId: input.requesterTelegramUserId,
    });
    input.logger.info(
      {
        decidedBy: input.fromTelegramUserId,
        telegramUserId: input.requesterTelegramUserId,
      },
      'access_denied',
    );
    await input.adapter.send(input.requesterTelegramUserId, [
      { kind: 'text', text: 'Access denied.' },
    ]);
  }

  return 'applied';
}
