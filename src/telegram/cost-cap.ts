/**
 * Cost-cap pre-check for the LLM call. Lives outside the orchestrator on
 * purpose: the orchestrator stays pure LLM logic, the caller owns
 * DB reads, the cost cap, and the owner-bypass exemption.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface CostCapInput {
  /** Current accumulated cost for the UTC day, from `daily_cost`. */
  dailyCostUsd: number;
  /** Configured cap (`DAILY_COST_CAP_USD`). */
  capUsd: number;
  /** Owner bypasses the cap so they can never lock themselves out. */
  isOwner: boolean;
}

export type CostCapDecision = { kind: 'allow' } | { kind: 'block' };

export function checkCostCap(input: CostCapInput): CostCapDecision {
  if (input.isOwner) {
    return { kind: 'allow' };
  }
  if (input.dailyCostUsd >= input.capUsd) {
    return { kind: 'block' };
  }
  return { kind: 'allow' };
}

/**
 * Hours until the next UTC midnight, rounded up so the displayed figure is
 * never less than the actual wait. At exactly midnight, returns 24 (the cap
 * is calculated UTC-day so the user has the full new day ahead of them).
 */
export function hoursUntilUtcMidnight(nowMs: number): number {
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const elapsed = nowMs - dayStart;
  if (elapsed === 0) {
    return 24;
  }
  const remaining = DAY_MS - elapsed;
  return Math.ceil(remaining / HOUR_MS);
}

/**
 * User-facing capped message. Includes a concrete hours-remaining figure
 * rather than a vague "try tomorrow" \u2014 we explicitly want a
 * timezone-unambiguous reset time.
 */
export function formatCappedReply(hoursRemaining: number): string {
  return `I've hit today's cost cap. Try again in about ${hoursRemaining}h (resets at UTC midnight).`;
}
