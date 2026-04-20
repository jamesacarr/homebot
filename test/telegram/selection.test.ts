import type { Message } from '@mariozechner/pi-ai';
import { describe, expect, it } from 'vitest';

import { createToolDispatcher } from '../../src/llm/tools.js';
import { silentLogger } from '../../src/logging.js';
import { handleSelection } from '../../src/telegram/selection.js';
import { createFakeOverseerr } from '../fakes/overseerr.js';

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

  it('dispatches request_media and returns a confirmation text + poster reply', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([[414906, movieDetails]]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await handleSelection({
      dispatcher,
      logger: silentLogger,
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
      dispatcher,
      logger: silentLogger,
      now: 1_700_000_000_000,
      pick: { mediaType: 'movie', tmdbId: 414906 },
      telegramUserId: 42,
    });

    expect(overseerr.createCalls).toEqual([]);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.kind).toBe('text');
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
      dispatcher,
      logger: silentLogger,
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
      dispatcher,
      logger: silentLogger,
      now: 1_700_000_000_000,
      pick: { mediaType: 'movie', tmdbId: 414906 },
      telegramUserId: 42,
    });

    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.kind).toBe('text');
    if (result.replies[0]?.kind !== 'text') {
      throw new Error('unreachable');
    }
    expect(result.replies[0].text).toMatch(/couldn'?t/i);
  });

  it('persists a synthetic turn so the LLM sees the selection on the next message', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([[414906, movieDetails]]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await handleSelection({
      dispatcher,
      logger: silentLogger,
      now: 1_700_000_000_000,
      pick: { mediaType: 'movie', tmdbId: 414906 },
      telegramUserId: 42,
    });

    const messages: Message[] = result.turnToPersist;
    // Shape: pseudo-user (the selection) + assistant(toolCall) +
    // toolResult(request_media) + assistant(confirmation text).
    expect(messages.map(m => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);

    // The user message stores a marker the LLM can recognise so a follow-up
    // turn can refer back ("the one you just requested" \u2192 the picked title).
    const userMsg = messages[0];
    if (userMsg?.role !== 'user' || typeof userMsg.content !== 'string') {
      throw new Error('expected a user message with string content');
    }
    expect(userMsg.content).toContain('414906');
    expect(userMsg.content).toMatch(/[Ss]elected/);
  });
});
