import type { UserStatus } from '../db/types.js';
import type { User } from '../db/users.js';

/**
 * Decision for an inbound 1:1 message from `senderTelegramUserId`.
 *
 * - `proceed`: hand off to the orchestrator (the user is approved or owner).
 * - `prompt_for_access`: unknown user — reply with the "Request access" button.
 * - `drop_silently`: user is in a non-approved state (pending / denied /
 *   revoked); log at debug and ignore. Plan.md is explicit that denied is
 *   permanent and there is no rate-limit cooldown — the status IS the gate.
 *
 * The owner is identified by `ownerTelegramUserId` from config, not by their
 * `users` row. They can therefore never lock themselves out by editing the DB.
 */
export type AccessDecision =
  | { kind: 'proceed' }
  | { kind: 'prompt_for_access' }
  | { kind: 'drop_silently'; status: UserStatus };

export interface DecideAccessInput {
  senderTelegramUserId: number;
  ownerTelegramUserId: number;
  userRow: User | null;
}

export function decideAccess(input: DecideAccessInput): AccessDecision {
  if (input.senderTelegramUserId === input.ownerTelegramUserId) {
    return { kind: 'proceed' };
  }
  if (input.userRow === null) {
    return { kind: 'prompt_for_access' };
  }
  if (input.userRow.status === 'approved') {
    return { kind: 'proceed' };
  }
  return { kind: 'drop_silently', status: input.userRow.status };
}

/**
 * Whether an inbound callback tap (picker, access_request, etc.) from
 * `senderTelegramUserId` should be processed.
 *
 * Stricter than the text-message policy: unknown users are rejected outright
 * rather than prompted. A user only gets a button from the bot AFTER they've
 * made it through `decideAccess`, so an unknown sender tapping a button
 * means either a stale tap after DB loss, or a leaked callback_data used by
 * someone who bypassed the text-message gate. Neither should proceed.
 */
export function allowCallback(input: DecideAccessInput): boolean {
  return decideAccess(input).kind === 'proceed';
}
