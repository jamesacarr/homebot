import { describe, expect, it } from 'vitest';

import { createOverseerrClient } from '../../src/overseerr/client.js';
import {
  OverseerrError,
  OverseerrNotFoundError,
  OverseerrTimeoutError,
  OverseerrUnauthorizedError,
} from '../../src/overseerr/errors.js';

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function makeFetchFake(responder: (call: CapturedCall) => Response): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : '';
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    }
    const body = typeof init?.body === 'string' ? init.body : null;
    const call: CapturedCall = { body, headers, method, url };
    calls.push(call);
    return Promise.resolve(responder(call));
  };
  return { calls, fetch: fetchFn };
}

describe('OverseerrClient.getStatus', () => {
  it('sends a GET to /api/v1/status with the API key header and returns the version', async () => {
    const { calls, fetch } = makeFetchFake(
      () =>
        new Response(JSON.stringify({ version: '1.33.0' }), { status: 200 }),
    );

    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    const status = await client.getStatus();

    expect(status).toEqual({ version: '1.33.0' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://overseerr:5055/api/v1/status');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['x-api-key']).toBe('secret');
  });

  it('throws OverseerrError when the server returns a non-2xx response', async () => {
    const { fetch } = makeFetchFake(
      () => new Response(JSON.stringify({ message: 'nope' }), { status: 500 }),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    await expect(client.getStatus()).rejects.toThrow(/500/);
  });

  it('throws OverseerrUnauthorizedError on a 401 response', async () => {
    const { fetch } = makeFetchFake(() => new Response('', { status: 401 }));
    const client = createOverseerrClient({
      apiKey: 'bad',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    await expect(client.getStatus()).rejects.toBeInstanceOf(
      OverseerrUnauthorizedError,
    );
  });

  it('throws OverseerrNotFoundError on a 404 response', async () => {
    const { fetch } = makeFetchFake(() => new Response('', { status: 404 }));
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    await expect(client.getStatus()).rejects.toBeInstanceOf(
      OverseerrNotFoundError,
    );
  });

  it('throws OverseerrError when the response lacks a version field', async () => {
    const { fetch } = makeFetchFake(
      () => new Response(JSON.stringify({ not: 'version' }), { status: 200 }),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    await expect(client.getStatus()).rejects.toThrow(/missing version/);
  });
});

describe('OverseerrClient.search', () => {
  const searchResponse = {
    page: 1,
    results: [
      {
        id: 414906,
        mediaInfo: { status: 5 },
        mediaType: 'movie',
        overview: 'Moody noir reboot',
        popularity: 200,
        posterPath: '/bat2022.jpg',
        releaseDate: '2022-03-01',
        title: 'The Batman',
      },
      {
        firstAirDate: '2025-10-01',
        id: 123,
        mediaInfo: { status: 2 },
        mediaType: 'tv',
        name: 'Batman: The Animated Series',
        overview: 'Animated',
        popularity: 80,
        posterPath: '/batas.jpg',
      },
      {
        id: 999,
        mediaType: 'person',
        name: 'Christian Bale',
      },
      {
        id: 272,
        // no mediaInfo => Overseerr hasn't seen this title
        mediaType: 'movie',
        overview: 'Nolan origin',
        popularity: 150,
        posterPath: null,
        releaseDate: '2005-06-15',
        title: 'Batman Begins',
      },
    ],
    totalPages: 1,
    totalResults: 4,
  };

  it('returns movie and TV candidates with full poster URLs, numeric status mapped to a name', async () => {
    const { calls, fetch } = makeFetchFake(
      () => new Response(JSON.stringify(searchResponse), { status: 200 }),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    const results = await client.search('The Batman');

    expect(results).toEqual([
      {
        mediaType: 'movie',
        overview: 'Moody noir reboot',
        popularity: 200,
        posterUrl: 'https://image.tmdb.org/t/p/w342/bat2022.jpg',
        status: 'AVAILABLE',
        title: 'The Batman',
        tmdbId: 414906,
        year: '2022',
      },
      {
        mediaType: 'tv',
        overview: 'Animated',
        popularity: 80,
        posterUrl: 'https://image.tmdb.org/t/p/w342/batas.jpg',
        status: 'PENDING',
        title: 'Batman: The Animated Series',
        tmdbId: 123,
        year: '2025',
      },
      {
        mediaType: 'movie',
        overview: 'Nolan origin',
        popularity: 150,
        posterUrl: null,
        status: null,
        title: 'Batman Begins',
        tmdbId: 272,
        year: '2005',
      },
    ]);
    // Overseerr's query validator rejects `+` as a space encoding and
    // demands percent-escapes. `URLSearchParams` produces `+` for space,
    // so the search client must use `encodeURIComponent` instead.
    expect(calls[0]?.url).toBe(
      'http://overseerr:5055/api/v1/search?query=The%20Batman',
    );
  });

  it('percent-encodes reserved characters in the query so Overseerr accepts it', async () => {
    const { calls, fetch } = makeFetchFake(
      () => new Response(JSON.stringify(searchResponse), { status: 200 }),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    await client.search('Rock & Roll?');

    expect(calls[0]?.url).toBe(
      'http://overseerr:5055/api/v1/search?query=Rock%20%26%20Roll%3F',
    );
  });
});

describe('OverseerrClient.getMediaDetails', () => {
  const movieDetails = {
    credits: {
      cast: [
        {
          character: 'Batman / Bruce Wayne',
          id: 3894,
          name: 'Christian Bale',
          order: 0,
          profilePath: '/bale.jpg',
        },
        {
          character: 'Henri Ducard',
          id: 1,
          name: 'Liam Neeson',
          order: 1,
          profilePath: null,
        },
      ],
      crew: [
        {
          department: 'Directing',
          id: 525,
          job: 'Director',
          name: 'Christopher Nolan',
        },
        {
          department: 'Writing',
          id: 525,
          job: 'Writer',
          name: 'Christopher Nolan',
        },
        { department: 'Editing', id: 999, job: 'Editor', name: 'Lee Smith' },
      ],
    },
    genres: [
      { id: 28, name: 'Action' },
      { id: 80, name: 'Crime' },
    ],
    id: 272,
    mediaInfo: { status: 5 },
    overview: 'A young Bruce Wayne travels to the East...',
    posterPath: '/bale.jpg',
    releaseDate: '2005-06-15',
    runtime: 140,
    title: 'Batman Begins',
    voteAverage: 7.7,
  };

  it('maps /movie/{id} into a trimmed detail projection with posterUrl, director, cast, and genres', async () => {
    const { calls, fetch } = makeFetchFake(
      () => new Response(JSON.stringify(movieDetails), { status: 200 }),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    const details = await client.getMediaDetails({
      mediaType: 'movie',
      tmdbId: 272,
    });

    expect(calls[0]?.url).toBe('http://overseerr:5055/api/v1/movie/272');
    expect(details).toEqual({
      cast: [
        { character: 'Batman / Bruce Wayne', name: 'Christian Bale' },
        { character: 'Henri Ducard', name: 'Liam Neeson' },
      ],
      createdBy: [],
      directors: ['Christopher Nolan'],
      genres: ['Action', 'Crime'],
      mediaType: 'movie',
      networks: [],
      overview: 'A young Bruce Wayne travels to the East...',
      posterUrl: 'https://image.tmdb.org/t/p/w342/bale.jpg',
      releaseDate: '2005-06-15',
      runtime: 140,
      status: 'AVAILABLE',
      title: 'Batman Begins',
      tmdbId: 272,
      voteAverage: 7.7,
      year: '2005',
    });
  });

  it('caps cast at the top 10 entries ordered by `order`', async () => {
    const manyCast = Array.from({ length: 20 }, (_, i) => ({
      character: `Character ${i}`,
      id: i,
      name: `Actor ${i}`,
      order: 19 - i,
      profilePath: null,
    }));
    const { fetch } = makeFetchFake(
      () =>
        new Response(
          JSON.stringify({
            ...movieDetails,
            credits: { cast: manyCast, crew: [] },
          }),
          { status: 200 },
        ),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    const details = await client.getMediaDetails({
      mediaType: 'movie',
      tmdbId: 272,
    });

    expect(details.cast).toHaveLength(10);
    // Lowest `order` should come first (index 19 in the source array).
    expect(details.cast[0]?.name).toBe('Actor 19');
  });

  it('maps /tv/{id} into a detail projection with createdBy and networks', async () => {
    const tvDetails = {
      createdBy: [
        { id: 1, name: 'Christopher Storer' },
        { id: 2, name: 'Joanna Calo' },
      ],
      credits: {
        cast: [
          {
            character: 'Carmen',
            id: 10,
            name: 'Jeremy Allen White',
            order: 0,
            profilePath: null,
          },
        ],
        crew: [],
      },
      firstAirDate: '2022-06-23',
      genres: [{ id: 35, name: 'Comedy' }],
      id: 136315,
      mediaInfo: { status: 5 },
      name: 'The Bear',
      networks: [
        { id: 1024, name: 'FX' },
        { id: 1, name: 'Hulu' },
      ],
      overview: 'A young chef returns home...',
      posterPath: '/thebear.jpg',
      voteAverage: 8.6,
    };
    const { calls, fetch } = makeFetchFake(
      () => new Response(JSON.stringify(tvDetails), { status: 200 }),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    const details = await client.getMediaDetails({
      mediaType: 'tv',
      tmdbId: 136315,
    });

    expect(calls[0]?.url).toBe('http://overseerr:5055/api/v1/tv/136315');
    expect(details).toEqual({
      cast: [{ character: 'Carmen', name: 'Jeremy Allen White' }],
      createdBy: ['Christopher Storer', 'Joanna Calo'],
      directors: [],
      genres: ['Comedy'],
      mediaType: 'tv',
      networks: ['FX', 'Hulu'],
      overview: 'A young chef returns home...',
      posterUrl: 'https://image.tmdb.org/t/p/w342/thebear.jpg',
      releaseDate: '2022-06-23',
      runtime: null,
      status: 'AVAILABLE',
      title: 'The Bear',
      tmdbId: 136315,
      voteAverage: 8.6,
      year: '2022',
    });
  });

  it('leaves posterUrl null when Overseerr returns no posterPath', async () => {
    const { fetch } = makeFetchFake(
      () =>
        new Response(JSON.stringify({ ...movieDetails, posterPath: null }), {
          status: 200,
        }),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    const details = await client.getMediaDetails({
      mediaType: 'movie',
      tmdbId: 272,
    });

    expect(details.posterUrl).toBeNull();
  });

  it('throws OverseerrNotFoundError when the title does not exist', async () => {
    const { fetch } = makeFetchFake(() => new Response('', { status: 404 }));
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    await expect(
      client.getMediaDetails({ mediaType: 'movie', tmdbId: 404 }),
    ).rejects.toBeInstanceOf(OverseerrNotFoundError);
  });
});

describe('OverseerrClient.createRequest', () => {
  it('POSTs /request with mediaType and mediaId for a movie', async () => {
    const { calls, fetch } = makeFetchFake(
      () => new Response(JSON.stringify({ id: 77 }), { status: 201 }),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    await client.createRequest({ mediaType: 'movie', tmdbId: 414906 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://overseerr:5055/api/v1/request');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['x-api-key']).toBe('secret');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      mediaId: 414906,
      mediaType: 'movie',
    });
  });

  it("defaults TV requests to seasons: 'all' so the full series is requested", async () => {
    const { calls, fetch } = makeFetchFake(
      () => new Response(JSON.stringify({ id: 78 }), { status: 201 }),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    await client.createRequest({ mediaType: 'tv', tmdbId: 123 });

    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      mediaId: 123,
      mediaType: 'tv',
      seasons: 'all',
    });
  });

  it('throws OverseerrError on a non-2xx response from the server', async () => {
    const { fetch } = makeFetchFake(
      () =>
        new Response(JSON.stringify({ message: 'already requested' }), {
          status: 409,
        }),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    await expect(
      client.createRequest({ mediaType: 'movie', tmdbId: 1 }),
    ).rejects.toThrow(/409/);
  });

  it('surfaces errorCode and server message on the thrown OverseerrError', async () => {
    const { fetch } = makeFetchFake(
      () =>
        new Response(
          JSON.stringify({
            errorCode: 40149,
            message: 'Request already exists.',
          }),
          { status: 409 },
        ),
    );
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch,
    });

    let caught: unknown;
    try {
      await client.createRequest({ mediaType: 'movie', tmdbId: 1 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OverseerrError);
    const err = caught as OverseerrError;
    expect(err.status).toBe(409);
    expect(err.errorCode).toBe(40149);
    expect(err.message).toContain('Request already exists.');
  });
});

describe('OverseerrClient request timeouts and cancellation', () => {
  function makeHangingFetch(): typeof fetch {
    return (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
  }

  it('aborts a hanging request after timeoutMs and throws OverseerrTimeoutError', async () => {
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch: makeHangingFetch(),
      timeoutMs: 20,
    });

    await expect(client.getStatus()).rejects.toBeInstanceOf(
      OverseerrTimeoutError,
    );
  });

  it('propagates the caller-supplied abort reason when the external signal fires first', async () => {
    const client = createOverseerrClient({
      apiKey: 'secret',
      baseUrl: 'http://overseerr:5055',
      fetch: makeHangingFetch(),
      timeoutMs: 10_000,
    });

    const reason = new Error('master timeout hit');
    const external = AbortSignal.abort(reason);

    await expect(client.getStatus({ signal: external })).rejects.toBe(reason);
  });
});
