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
    expect(calls[0]?.url).toBe(
      'http://overseerr:5055/api/v1/search?query=The+Batman',
    );
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
