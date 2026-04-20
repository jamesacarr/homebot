import { describe, expect, it } from 'vitest';

import {
  checkCostCap,
  formatCappedReply,
  hoursUntilUtcMidnight,
} from '../../src/telegram/cost-cap.js';

describe('checkCostCap', () => {
  it('allows a non-owner under the cap', () => {
    expect(
      checkCostCap({
        capUsd: 1.0,
        dailyCostUsd: 0.5,
        isOwner: false,
      }),
    ).toEqual({ kind: 'allow' });
  });

  it('blocks a non-owner at the cap', () => {
    // At-or-above the cap is the bound; the next call would pile on cost
    // already over budget.
    expect(
      checkCostCap({
        capUsd: 1.0,
        dailyCostUsd: 1.0,
        isOwner: false,
      }),
    ).toEqual({ kind: 'block' });
  });

  it('blocks a non-owner above the cap', () => {
    expect(
      checkCostCap({
        capUsd: 1.0,
        dailyCostUsd: 1.5,
        isOwner: false,
      }),
    ).toEqual({ kind: 'block' });
  });

  it('always allows the owner even when over cap, so they cannot lock themselves out', () => {
    expect(
      checkCostCap({
        capUsd: 1.0,
        dailyCostUsd: 100.0,
        isOwner: true,
      }),
    ).toEqual({ kind: 'allow' });
  });
});

describe('hoursUntilUtcMidnight', () => {
  it('rounds up so a 1h6m remaining shows as 2h not 1h', () => {
    // 22:54 UTC → 1h6m remaining → ceil to 2h.
    const t = Date.UTC(2026, 3, 20, 22, 54, 0);
    expect(hoursUntilUtcMidnight(t)).toBe(2);
  });

  it('returns 1 when there is less than an hour left', () => {
    // 23:30 UTC → 0.5h → ceil to 1.
    const t = Date.UTC(2026, 3, 20, 23, 30, 0);
    expect(hoursUntilUtcMidnight(t)).toBe(1);
  });

  it('returns 24 at exactly UTC midnight (no time has elapsed yet)', () => {
    const t = Date.UTC(2026, 3, 20, 0, 0, 0);
    expect(hoursUntilUtcMidnight(t)).toBe(24);
  });
});

describe('formatCappedReply', () => {
  it('embeds the rounded hours-remaining figure for clarity', () => {
    expect(formatCappedReply(3)).toMatch(/3h/);
    expect(formatCappedReply(3)).toMatch(/UTC/);
  });

  it('mentions the cap so the user understands why they are being refused', () => {
    expect(formatCappedReply(3)).toMatch(/cap/i);
  });
});
