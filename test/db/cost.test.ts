import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addCost, getDailyCost } from '../../src/db/cost.js';
import type { AppDb } from '../../src/db/index.js';
import { createTestDb } from './helper.js';

describe('cost', () => {
  let db: AppDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('getDailyCost returns 0 for a day with no recorded spend', async () => {
    expect(await getDailyCost(db, '2026-04-20')).toBe(0);
  });

  it('addCost creates a row when the day has no spend yet', async () => {
    await addCost(db, '2026-04-20', 0.003);
    expect(await getDailyCost(db, '2026-04-20')).toBeCloseTo(0.003);
  });

  it('addCost accumulates on subsequent calls for the same day', async () => {
    await addCost(db, '2026-04-20', 0.003);
    await addCost(db, '2026-04-20', 0.005);
    await addCost(db, '2026-04-20', 0.002);
    expect(await getDailyCost(db, '2026-04-20')).toBeCloseTo(0.01);
  });

  it('different days are tracked independently', async () => {
    await addCost(db, '2026-04-19', 0.5);
    await addCost(db, '2026-04-20', 0.1);

    expect(await getDailyCost(db, '2026-04-19')).toBeCloseTo(0.5);
    expect(await getDailyCost(db, '2026-04-20')).toBeCloseTo(0.1);
  });
});
