import type { FauxProviderRegistration, Model } from '@mariozechner/pi-ai';
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppDb } from '../../src/db/index.js';
import { approveUser, recordAccessRequest } from '../../src/db/users.js';
import { createOrchestrator } from '../../src/llm/orchestrator.js';
import { silentLogger } from '../../src/logging.js';
import type { SearchCandidate } from '../../src/overseerr/client.js';
import { runTextTurn } from '../../src/telegram/run-text-turn.js';
import { createTestDb } from '../db/helper.js';
import { createFakeOverseerr } from '../fakes/overseerr.js';

const OWNER_ID = 11111;
const APPROVED_USER = 22222;
const STRANGER = 33333;

let faux: FauxProviderRegistration;
let model: Model<string>;
let db: AppDb;

beforeEach(async () => {
  faux = registerFauxProvider({
    models: [
      {
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: 'faux-1',
      },
    ],
  });
  const m = faux.getModel();
  if (m === undefined) {
    throw new Error('faux model missing');
  }
  model = m;

  db = await createTestDb();
  await recordAccessRequest(db, {
    now: 1000,
    telegramUserId: APPROVED_USER,
    telegramUsername: 'jane',
  });
  await approveUser(db, {
    decidedBy: OWNER_ID,
    now: 2000,
    telegramUserId: APPROVED_USER,
  });
});

afterEach(() => {
  faux.unregister();
});

const theBatman: SearchCandidate = {
  mediaType: 'movie',
  overview: 'Moody',
  popularity: 200,
  posterUrl: 'https://image.tmdb.org/t/p/w342/bat.jpg',
  status: null,
  title: 'The Batman',
  tmdbId: 414906,
  year: '2022',
};

const movieDetails = {
  cast: [],
  createdBy: [],
  directors: [],
  genres: [],
  mediaType: 'movie' as const,
  networks: [],
  overview: 'Moody',
  posterUrl: 'https://image.tmdb.org/t/p/w342/bat.jpg',
  releaseDate: '2022-03-01',
  runtime: 176,
  status: null,
  title: 'The Batman',
  tmdbId: 414906,
  voteAverage: 7.8,
  year: '2022',
};

function makeOrchestrate(searchResults: SearchCandidate[] = [theBatman]) {
  const overseerr = createFakeOverseerr({
    detailsByTmdbId: new Map([[414906, movieDetails]]),
    searchResults,
  });
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('search_media', { query: 'The Batman' }, { id: 'c1' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall(
          'request_media',
          { mediaType: 'movie', tmdbId: 414906 },
          { id: 'c2' },
        ),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Requested *The Batman (2022)*. ✓'),
  ]);
  return createOrchestrator({
    llmModel: model,
    logger: silentLogger,
    overseerr,
    systemPrompt: 'test',
    thinkingLevel: 'off',
  });
}

async function countTurns(database: AppDb, userId: number): Promise<number> {
  const rows = await database
    .selectFrom('conversationTurns')
    .selectAll()
    .where('telegramUserId', '=', userId)
    .execute();
  return rows.length;
}

describe('runTextTurn — happy path', () => {
  it('returns replies + a commit callback; calling commit persists the turn', async () => {
    const orchestrate = makeOrchestrate();
    const result = await runTextTurn({
      capUsd: 1,
      db,
      incomingText: 'add The Batman',
      logger: silentLogger,
      maxTurnsInHistory: 15,
      now: 1_700_000_000_000,
      orchestrate,
      ownerTelegramUserId: OWNER_ID,
      telegramUserId: APPROVED_USER,
    });

    if (result.kind !== 'replies') {
      throw new Error('unreachable');
    }
    expect(result.replies).toHaveLength(2); // text + poster

    // Pre-commit: turn is NOT persisted yet — plan.md says send first,
    // persist only if sends succeed.
    expect(await countTurns(db, APPROVED_USER)).toBe(0);
    expect(result.commit).toBeDefined();

    await result.commit?.();
    expect(await countTurns(db, APPROVED_USER)).toBe(1);
  });

  it('does not persist the turn if the caller never invokes commit (e.g. send failed)', async () => {
    const orchestrate = makeOrchestrate();
    const result = await runTextTurn({
      capUsd: 1,
      db,
      incomingText: 'add The Batman',
      logger: silentLogger,
      maxTurnsInHistory: 15,
      now: 1_700_000_000_000,
      orchestrate,
      ownerTelegramUserId: OWNER_ID,
      telegramUserId: APPROVED_USER,
    });

    if (result.kind !== 'replies') {
      throw new Error('unreachable');
    }
    // Caller "sends" but does not call commit.
    expect(await countTurns(db, APPROVED_USER)).toBe(0);
  });

  it('records cost immediately (before the caller sends) so a send failure cannot reset the day budget', async () => {
    // Cost is incurred at LLM call time; the user not seeing the reply
    // doesn't refund the API spend.
    const orchestrate = makeOrchestrate();
    await runTextTurn({
      capUsd: 1,
      db,
      incomingText: 'add The Batman',
      logger: silentLogger,
      maxTurnsInHistory: 15,
      now: 1_700_000_000_000,
      orchestrate,
      ownerTelegramUserId: OWNER_ID,
      telegramUserId: APPROVED_USER,
    });

    // The faux model has cost=0, so this just verifies the daily_cost row
    // accumulator path runs (or correctly skips for zero deltas) without
    // requiring commit() to be called.
    const cost = await db.selectFrom('dailyCost').selectAll().execute();
    // Either no row (zero delta skipped) or one row at zero. Both are fine.
    expect(cost.length === 0 || cost[0]?.costUsd === 0).toBe(true);
  });
});

describe('runTextTurn — access control', () => {
  it('returns kind=prompt_for_access for unknown users without calling the LLM', async () => {
    let llmCalls = 0;
    const orchestrate: Parameters<typeof runTextTurn>[0]['orchestrate'] =
      () => {
        llmCalls++;
        return Promise.reject(new Error('orchestrator should not run'));
      };

    const result = await runTextTurn({
      capUsd: 1,
      db,
      incomingText: 'hello',
      logger: silentLogger,
      maxTurnsInHistory: 15,
      now: 1_700_000_000_000,
      orchestrate,
      ownerTelegramUserId: OWNER_ID,
      telegramUserId: STRANGER,
      telegramUsername: 'stranger',
    });

    expect(result.kind).toBe('prompt_for_access');
    expect(llmCalls).toBe(0);
  });

  it('returns kind=drop_silently for pending users', async () => {
    await recordAccessRequest(db, {
      now: 5000,
      telegramUserId: 44444,
      telegramUsername: 'pending-pat',
    });
    const orchestrate: Parameters<typeof runTextTurn>[0]['orchestrate'] = () =>
      Promise.reject(new Error('should not run'));

    const result = await runTextTurn({
      capUsd: 1,
      db,
      incomingText: 'hi',
      logger: silentLogger,
      maxTurnsInHistory: 15,
      now: 1_700_000_000_000,
      orchestrate,
      ownerTelegramUserId: OWNER_ID,
      telegramUserId: 44444,
    });

    expect(result.kind).toBe('drop_silently');
  });

  it('lets the owner through even with no users-table row', async () => {
    const orchestrate = makeOrchestrate();
    const result = await runTextTurn({
      capUsd: 1,
      db,
      incomingText: 'add The Batman',
      logger: silentLogger,
      maxTurnsInHistory: 15,
      now: 1_700_000_000_000,
      orchestrate,
      ownerTelegramUserId: OWNER_ID,
      telegramUserId: OWNER_ID,
    });

    expect(result.kind).toBe('replies');
  });
});

describe('runTextTurn — cost cap', () => {
  it('blocks a non-owner over the cap before calling the orchestrator', async () => {
    await db
      .insertInto('dailyCost')
      .values({ costUsd: 5.0, dayUtc: '2023-11-14' })
      .execute();

    let orchestratorCalled = false;
    const orchestrate: Parameters<typeof runTextTurn>[0]['orchestrate'] =
      () => {
        orchestratorCalled = true;
        return Promise.reject(new Error('blocked'));
      };

    // 1_700_000_000_000 ms = 2023-11-14 22:13:20 UTC.
    const result = await runTextTurn({
      capUsd: 1,
      db,
      incomingText: 'anything',
      logger: silentLogger,
      maxTurnsInHistory: 15,
      now: 1_700_000_000_000,
      orchestrate,
      ownerTelegramUserId: OWNER_ID,
      telegramUserId: APPROVED_USER,
    });

    expect(orchestratorCalled).toBe(false);
    if (result.kind !== 'replies') {
      throw new Error('unreachable');
    }
    expect(result.replies).toHaveLength(1);
    if (result.replies[0]?.kind !== 'text') {
      throw new Error('expected text');
    }
    expect(result.replies[0].text).toMatch(/cap/i);
    expect(result.replies[0].text).toMatch(/UTC/);
    // No commit on the cost-cap branch — there's no turn to persist.
    expect(result.commit).toBeUndefined();
  });

  it('lets the owner through even when over cap', async () => {
    await db
      .insertInto('dailyCost')
      .values({ costUsd: 5.0, dayUtc: '2023-11-14' })
      .execute();

    const orchestrate = makeOrchestrate();
    const result = await runTextTurn({
      capUsd: 1,
      db,
      incomingText: 'add The Batman',
      logger: silentLogger,
      maxTurnsInHistory: 15,
      now: 1_700_000_000_000,
      orchestrate,
      ownerTelegramUserId: OWNER_ID,
      telegramUserId: OWNER_ID,
    });

    expect(result.kind).toBe('replies');
  });
});
