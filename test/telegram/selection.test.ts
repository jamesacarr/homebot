import type { Message } from '@mariozechner/pi-ai';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppDb } from '../../src/db/index.js';
import { createToolDispatcher } from '../../src/llm/tools.js';
import { silentLogger } from '../../src/logging.js';
import { handleSelection } from '../../src/telegram/selection.js';
import { createTestDb } from '../db/helper.js';
import { createFakeOverseerr } from '../fakes/overseerr.js';

const MAX_TURNS = 15;

describe('handleSelection', () => {
  const movieDetails = {
    cast: [],
    createdBy: [],
    directors: [],
    genres: [],
    mediaType: 'movie' as const,
    networks: [],
    overview: 'Moody noir reboot',
    posterUrl: 'https://image.tmdb.org/t/p/w342/bat2022.jpg',
    releaseDate: '2022-03-01',
    runtime: 176,
    status: null,
    title: 'The Batman',
    tmdbId: 414906,
    voteAverage: 7.8,
    year: '2022',
  };

  let db: AppDb;
  beforeEach(async () => {
    db = await createTestDb();
  });

  async function turnCount(userId = 42): Promise<number> {
    const rows = await db
      .selectFrom('conversationTurns')
      .selectAll()
      .where('telegramUserId', '=', userId)
      .execute();
    return rows.length;
  }

  it('dispatches request_media and returns a confirmation text + poster reply', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([[414906, movieDetails]]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await handleSelection({
      db,
      dispatcher,
      logger: silentLogger,
      maxTurnsInHistory: MAX_TURNS,
      now: 1_700_000_000_000,
      pick: { mediaType: 'movie', tmdbId: 414906 },
      telegramUserId: 42,
    });

    expect(overseerr.createCalls).toEqual([
      { mediaType: 'movie', tmdbId: 414906 },
    ]);
    expect(result.replies).toEqual([
      { kind: 'text', text: 'Requested *The Batman (2022)*. ✓' },
      {
        caption: '',
        kind: 'photo',
        posterUrl: 'https://image.tmdb.org/t/p/w342/bat2022.jpg',
      },
    ]);
  });

  it('still confirms without a photo reply when the requested title has no posterUrl', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([
        [414906, { ...movieDetails, posterUrl: null }],
      ]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await handleSelection({
      db,
      dispatcher,
      logger: silentLogger,
      maxTurnsInHistory: MAX_TURNS,
      now: 1_700_000_000_000,
      pick: { mediaType: 'movie', tmdbId: 414906 },
      telegramUserId: 42,
    });

    expect(overseerr.createCalls).toEqual([
      { mediaType: 'movie', tmdbId: 414906 },
    ]);
    expect(result.replies).toHaveLength(1);
    if (result.replies[0]?.kind !== 'text') {
      throw new Error('unreachable');
    }
    expect(result.replies[0].text).toMatch(/Requested/);
  });

  it('reports an already-available title without a request and without a poster', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([
        [414906, { ...movieDetails, status: 'AVAILABLE' as const }],
      ]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await handleSelection({
      db,
      dispatcher,
      logger: silentLogger,
      maxTurnsInHistory: MAX_TURNS,
      now: 1_700_000_000_000,
      pick: { mediaType: 'movie', tmdbId: 414906 },
      telegramUserId: 42,
    });

    expect(overseerr.createCalls).toEqual([]);
    expect(result.replies).toHaveLength(1);
    if (result.replies[0]?.kind !== 'text') {
      throw new Error('unreachable');
    }
    expect(result.replies[0].text).toMatch(/already.*available/i);
  });

  it('reports an already-requested title clearly', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([
        [414906, { ...movieDetails, status: 'PENDING' as const }],
      ]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await handleSelection({
      db,
      dispatcher,
      logger: silentLogger,
      maxTurnsInHistory: MAX_TURNS,
      now: 1_700_000_000_000,
      pick: { mediaType: 'movie', tmdbId: 414906 },
      telegramUserId: 42,
    });

    if (result.replies[0]?.kind !== 'text') {
      throw new Error('unreachable');
    }
    expect(result.replies[0].text).toMatch(/already.*requested/i);
  });

  it('returns an apologetic reply when the request fails (not_found / timeout / error)', async () => {
    const overseerr = createFakeOverseerr({
      onGetMediaDetails: () =>
        Promise.reject(new Error('Overseerr is having a bad day')),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await handleSelection({
      db,
      dispatcher,
      logger: silentLogger,
      maxTurnsInHistory: MAX_TURNS,
      now: 1_700_000_000_000,
      pick: { mediaType: 'movie', tmdbId: 414906 },
      telegramUserId: 42,
    });

    expect(result.replies).toHaveLength(1);
    if (result.replies[0]?.kind !== 'text') {
      throw new Error('unreachable');
    }
    expect(result.replies[0].text).toMatch(/couldn'?t/i);
  });

  it('returns a commit() callback; persistence happens only when invoked', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([[414906, movieDetails]]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await handleSelection({
      db,
      dispatcher,
      logger: silentLogger,
      maxTurnsInHistory: MAX_TURNS,
      now: 1_700_000_000_000,
      pick: { mediaType: 'movie', tmdbId: 414906 },
      telegramUserId: 42,
    });

    // Pre-commit: nothing persisted yet (plan.md: send first, persist on success).
    expect(await turnCount()).toBe(0);

    await result.commit();
    expect(await turnCount()).toBe(1);
  });

  it('does not persist if the caller never invokes commit() (e.g. send failed)', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([[414906, movieDetails]]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    await handleSelection({
      db,
      dispatcher,
      logger: silentLogger,
      maxTurnsInHistory: MAX_TURNS,
      now: 1_700_000_000_000,
      pick: { mediaType: 'movie', tmdbId: 414906 },
      telegramUserId: 42,
    });

    expect(await turnCount()).toBe(0);
  });

  it('persists a four-message synthetic turn so the LLM has full context on the next message', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([[414906, movieDetails]]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await handleSelection({
      db,
      dispatcher,
      logger: silentLogger,
      maxTurnsInHistory: MAX_TURNS,
      now: 1_700_000_000_000,
      pick: { mediaType: 'movie', tmdbId: 414906 },
      telegramUserId: 42,
    });
    await result.commit();

    const rows = await db
      .selectFrom('conversationTurns')
      .selectAll()
      .where('telegramUserId', '=', 42)
      .execute();
    expect(rows).toHaveLength(1);
    const envelope = JSON.parse(rows[0]?.messagesJson ?? '{}') as {
      v: number;
      messages: Message[];
    };
    expect(envelope.messages.map(m => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
    // The synthetic user message stores a marker the LLM can recognise on
    // follow-up turns ("the one you just requested" → the picked title).
    const userMsg = envelope.messages[0];
    if (userMsg?.role !== 'user' || typeof userMsg.content !== 'string') {
      throw new Error('expected a user message with string content');
    }
    expect(userMsg.content).toContain('414906');
    expect(userMsg.content).toMatch(/[Ss]elected/);
  });
});
