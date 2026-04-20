import { describe, expect, it } from 'vitest';

import { createToolDispatcher } from '../../src/llm/tools.js';
import { silentLogger } from '../../src/logging.js';
import type {
  MediaDetails,
  SearchCandidate,
} from '../../src/overseerr/client.js';
import {
  OverseerrError,
  OverseerrNotFoundError,
  OverseerrTimeoutError,
} from '../../src/overseerr/errors.js';
import { createFakeOverseerr } from '../fakes/overseerr.js';

function toolCall(
  name: string,
  args: Record<string, unknown>,
  id = 'call_1',
): {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  type: 'toolCall';
} {
  return { arguments: args, id, name, type: 'toolCall' };
}

describe('createToolDispatcher — search_media', () => {
  const bale: SearchCandidate = {
    mediaType: 'movie',
    overview: 'Nolan origin',
    popularity: 150,
    posterUrl: 'https://image.tmdb.org/t/p/w342/bale.jpg',
    status: null,
    title: 'Batman Begins',
    tmdbId: 272,
    year: '2005',
  };
  const batman: SearchCandidate = {
    mediaType: 'movie',
    overview: 'Moody noir reboot',
    popularity: 200,
    posterUrl: 'https://image.tmdb.org/t/p/w342/bat2022.jpg',
    status: 'AVAILABLE',
    title: 'The Batman',
    tmdbId: 414906,
    year: '2022',
  };

  it('calls Overseerr.search with the query and returns candidates to the LLM', async () => {
    const overseerr = createFakeOverseerr({
      searchResults: [batman, bale],
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('search_media', { query: 'Batman' }),
      { telegramUserId: 1 },
    );

    expect(overseerr.searchCalls).toEqual([{ query: 'Batman' }]);
    if (result.isError || result.name !== 'search_media') {
      throw new Error(
        `expected search_media success, got ${JSON.stringify(result)}`,
      );
    }
    // Structured result carries the candidate list for orchestrator UI fan-out.
    expect(result.output).toEqual({ candidates: [batman, bale] });
    // Text sent to the LLM is JSON — structured but opaque to the prompt.
    expect(JSON.parse(result.text)).toEqual({ candidates: [batman, bale] });
  });

  it('filters candidates to mediaType when supplied', async () => {
    const overseerr = createFakeOverseerr({
      searchResults: [
        batman,
        {
          mediaType: 'tv',
          overview: 'Animated',
          popularity: 80,
          posterUrl: null,
          status: null,
          title: 'Batman: The Animated Series',
          tmdbId: 123,
          year: '1992',
        },
      ],
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('search_media', { mediaType: 'movie', query: 'Batman' }),
      { telegramUserId: 1 },
    );

    expect(result.isError).toBe(false);
    if (result.isError || result.name !== 'search_media') {
      throw new Error('unreachable');
    }
    expect(result.output.candidates).toHaveLength(1);
    expect(result.output.candidates[0]?.mediaType).toBe('movie');
  });

  it('caps the returned list at 3 candidates by popularity (most-popular first)', async () => {
    const candidates: SearchCandidate[] = Array.from({ length: 8 }, (_, i) => ({
      mediaType: 'movie',
      overview: null,
      popularity: i,
      posterUrl: null,
      status: null,
      title: `Title ${i}`,
      tmdbId: 1000 + i,
      year: '2020',
    }));
    const overseerr = createFakeOverseerr({ searchResults: candidates });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('search_media', { query: 'anything' }),
      { telegramUserId: 1 },
    );

    if (result.isError || result.name !== 'search_media') {
      throw new Error('unreachable');
    }
    expect(result.output.candidates).toHaveLength(3);
    expect(result.output.candidates.map(c => c.tmdbId)).toEqual([
      1007, 1006, 1005,
    ]);
  });

  it('returns an empty-results output (not an error) when Overseerr finds nothing', async () => {
    const overseerr = createFakeOverseerr({ searchResults: [] });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('search_media', { query: 'asdfqwerty' }),
      { telegramUserId: 1 },
    );

    expect(result.isError).toBe(false);
    if (result.isError || result.name !== 'search_media') {
      throw new Error('unreachable');
    }
    expect(result.output.candidates).toEqual([]);
  });
});

describe('createToolDispatcher — get_media_details', () => {
  const batmanBegins: MediaDetails = {
    cast: [
      { character: 'Bruce Wayne', name: 'Christian Bale' },
      { character: 'Henri Ducard', name: 'Liam Neeson' },
    ],
    createdBy: [],
    directors: ['Christopher Nolan'],
    genres: ['Action', 'Crime'],
    mediaType: 'movie',
    networks: [],
    overview: 'A young Bruce Wayne travels to the East...',
    releaseDate: '2005-06-15',
    runtime: 140,
    status: 'AVAILABLE',
    title: 'Batman Begins',
    tmdbId: 272,
    voteAverage: 7.7,
    year: '2005',
  };

  it('forwards {tmdbId,mediaType} to Overseerr.getMediaDetails and surfaces the projection', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([[272, batmanBegins]]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('get_media_details', { mediaType: 'movie', tmdbId: 272 }),
      { telegramUserId: 1 },
    );

    expect(overseerr.detailsCalls).toEqual([
      { mediaType: 'movie', tmdbId: 272 },
    ]);
    if (result.isError || result.name !== 'get_media_details') {
      throw new Error(`expected success, got ${JSON.stringify(result)}`);
    }
    expect(result.output.details).toEqual(batmanBegins);
    expect(JSON.parse(result.text)).toEqual({ details: batmanBegins });
  });

  it('returns an isError=not_found result when Overseerr returns 404', async () => {
    const overseerr = createFakeOverseerr({
      onGetMediaDetails: () => {
        throw new OverseerrNotFoundError(
          'Overseerr returned 404 for /movie/999',
        );
      },
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('get_media_details', { mediaType: 'movie', tmdbId: 999 }),
      { telegramUserId: 1 },
    );

    if (!result.isError) {
      throw new Error('expected error result');
    }
    expect(result.code).toBe('not_found');
    expect(result.name).toBe('get_media_details');
    expect(JSON.parse(result.text)).toMatchObject({ code: 'not_found' });
  });

  it('returns an isError=timeout result when Overseerr times out', async () => {
    const overseerr = createFakeOverseerr({
      onGetMediaDetails: () => {
        throw new OverseerrTimeoutError();
      },
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('get_media_details', { mediaType: 'movie', tmdbId: 272 }),
      { telegramUserId: 1 },
    );

    if (!result.isError) {
      throw new Error('expected error result');
    }
    expect(result.code).toBe('timeout');
    expect(result.name).toBe('get_media_details');
  });

  it('rejects calls missing tmdbId with invalid_arguments', async () => {
    const overseerr = createFakeOverseerr();
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('get_media_details', { mediaType: 'movie' }),
      { telegramUserId: 1 },
    );

    if (!result.isError) {
      throw new Error('expected error result');
    }
    expect(result.code).toBe('invalid_arguments');
    expect(overseerr.detailsCalls).toEqual([]);
  });
});

describe('createToolDispatcher — request_media', () => {
  const batmanBegins: MediaDetails = {
    cast: [],
    createdBy: [],
    directors: [],
    genres: [],
    mediaType: 'movie',
    networks: [],
    overview: 'Nolan origin',
    releaseDate: '2005-06-15',
    runtime: 140,
    status: null,
    title: 'Batman Begins',
    tmdbId: 272,
    voteAverage: null,
    year: '2005',
  };

  it('checks mediaInfo.status, submits a request, and returns status=requested', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([[272, { ...batmanBegins, status: null }]]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('request_media', { mediaType: 'movie', tmdbId: 272 }),
      { telegramUserId: 1 },
    );

    if (result.isError || result.name !== 'request_media') {
      throw new Error(`expected success, got ${JSON.stringify(result)}`);
    }
    expect(result.output.status).toBe('requested');
    expect(result.output.title).toBe('Batman Begins');
    expect(result.output.year).toBe('2005');
    expect(overseerr.createCalls).toEqual([
      { mediaType: 'movie', tmdbId: 272 },
    ]);
  });

  it('refuses to request when the title is already AVAILABLE', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([
        [272, { ...batmanBegins, status: 'AVAILABLE' }],
      ]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('request_media', { mediaType: 'movie', tmdbId: 272 }),
      { telegramUserId: 1 },
    );

    if (result.isError || result.name !== 'request_media') {
      throw new Error(`expected success, got ${JSON.stringify(result)}`);
    }
    expect(result.output.status).toBe('already_available');
    expect(overseerr.createCalls).toEqual([]);
  });

  it('refuses to request when the title is already PENDING or PROCESSING', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([[272, { ...batmanBegins, status: 'PENDING' }]]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('request_media', { mediaType: 'movie', tmdbId: 272 }),
      { telegramUserId: 1 },
    );

    if (result.isError || result.name !== 'request_media') {
      throw new Error(`expected success, got ${JSON.stringify(result)}`);
    }
    expect(result.output.status).toBe('already_requested');
    expect(overseerr.createCalls).toEqual([]);
  });

  it("treats PARTIALLY_AVAILABLE as available so we don't double-request", async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([
        [272, { ...batmanBegins, status: 'PARTIALLY_AVAILABLE' }],
      ]),
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('request_media', { mediaType: 'movie', tmdbId: 272 }),
      { telegramUserId: 1 },
    );

    if (result.isError || result.name !== 'request_media') {
      throw new Error(`expected success, got ${JSON.stringify(result)}`);
    }
    expect(result.output.status).toBe('already_available');
    expect(overseerr.createCalls).toEqual([]);
  });

  it('treats a 409 "already exists" response from createRequest as already_requested', async () => {
    // Race: status looked clear at read time, but someone else (or Overseerr
    // having stale data) caused Overseerr to reject with 409/errorCode 40149.
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([[272, { ...batmanBegins, status: null }]]),
      onCreateRequest: () => {
        throw new OverseerrError(
          'Overseerr returned 409 for /request: Request already exists.',
          409,
          40149,
          { errorCode: 40149, message: 'Request already exists.' },
        );
      },
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('request_media', { mediaType: 'movie', tmdbId: 272 }),
      { telegramUserId: 1 },
    );

    if (result.isError || result.name !== 'request_media') {
      throw new Error(`expected success, got ${JSON.stringify(result)}`);
    }
    expect(result.output.status).toBe('already_requested');
  });

  it('returns a timeout failure when Overseerr times out checking status', async () => {
    const overseerr = createFakeOverseerr({
      onGetMediaDetails: () => {
        throw new OverseerrTimeoutError();
      },
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('request_media', { mediaType: 'movie', tmdbId: 272 }),
      { telegramUserId: 1 },
    );

    if (!result.isError) {
      throw new Error('expected error result');
    }
    expect(result.code).toBe('timeout');
    expect(overseerr.createCalls).toEqual([]);
  });

  it('surfaces 404 from Overseerr as not_found without calling createRequest', async () => {
    const overseerr = createFakeOverseerr({
      onGetMediaDetails: () => {
        throw new OverseerrNotFoundError();
      },
    });
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('request_media', { mediaType: 'movie', tmdbId: 272 }),
      { telegramUserId: 1 },
    );

    if (!result.isError) {
      throw new Error('expected error result');
    }
    expect(result.code).toBe('not_found');
    expect(overseerr.createCalls).toEqual([]);
  });

  it('rejects calls with non-positive tmdbId as invalid_arguments', async () => {
    const overseerr = createFakeOverseerr();
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('request_media', { mediaType: 'movie', tmdbId: -1 }),
      { telegramUserId: 1 },
    );

    if (!result.isError) {
      throw new Error('expected error result');
    }
    expect(result.code).toBe('invalid_arguments');
    expect(overseerr.detailsCalls).toEqual([]);
    expect(overseerr.createCalls).toEqual([]);
  });
});

describe('createToolDispatcher — tool registry', () => {
  it('exposes exactly three tools: search_media, get_media_details, request_media', () => {
    const overseerr = createFakeOverseerr();
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    expect(dispatcher.tools.map(t => t.name).sort()).toEqual([
      'get_media_details',
      'request_media',
      'search_media',
    ]);
  });

  it('rejects unknown tool names with code=unknown_tool', async () => {
    const overseerr = createFakeOverseerr();
    const dispatcher = createToolDispatcher({
      logger: silentLogger,
      overseerr,
    });

    const result = await dispatcher.dispatch(
      toolCall('do_something_bad', { x: 1 }),
      { telegramUserId: 1 },
    );

    if (!result.isError) {
      throw new Error('expected error result');
    }
    expect(result.code).toBe('unknown_tool');
    expect(result.name).toBe('unknown');
  });
});

// Placeholder to suppress unused-import on SearchCandidate until the later
// tests reference it. Keeping the import so subsequent cycles only extend.
const _unused: SearchCandidate | undefined = undefined;
void _unused;
