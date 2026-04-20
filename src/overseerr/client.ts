import {
  OverseerrError,
  OverseerrNotFoundError,
  OverseerrTimeoutError,
  OverseerrUnauthorizedError,
} from './errors.js';

// 10s default per plan.md — Overseerr usually answers in <1s.
const DEFAULT_TIMEOUT_MS = 10_000;

export type MediaStatus =
  | 'UNKNOWN'
  | 'PENDING'
  | 'PROCESSING'
  | 'PARTIALLY_AVAILABLE'
  | 'AVAILABLE'
  | 'DELETED';

const MEDIA_STATUS_BY_CODE: Record<number, MediaStatus> = {
  1: 'UNKNOWN',
  2: 'PENDING',
  3: 'PROCESSING',
  4: 'PARTIALLY_AVAILABLE',
  5: 'AVAILABLE',
  6: 'DELETED',
};

// See plan.md — w342 is the chosen poster size for Telegram inline cards.
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';

export interface OverseerrStatus {
  version: string;
}

export type OverseerrMediaType = 'movie' | 'tv';

export interface SearchCandidate {
  tmdbId: number;
  mediaType: OverseerrMediaType;
  title: string;
  year: string | null;
  overview: string | null;
  posterUrl: string | null;
  popularity: number;
  status: MediaStatus | null;
}

export interface CreateRequestInput {
  tmdbId: number;
  mediaType: OverseerrMediaType;
  is4k?: boolean;
}

export interface OverseerrClient {
  getStatus(): Promise<OverseerrStatus>;
  search(query: string): Promise<SearchCandidate[]>;
  createRequest(input: CreateRequestInput): Promise<void>;
}

export interface CreateOverseerrClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface RawSearchResultBase {
  id?: unknown;
  mediaType?: unknown;
  popularity?: unknown;
  posterPath?: unknown;
  overview?: unknown;
  mediaInfo?: { status?: unknown } | null;
}

interface RawMovieResult extends RawSearchResultBase {
  title?: unknown;
  releaseDate?: unknown;
}

interface RawTvResult extends RawSearchResultBase {
  name?: unknown;
  firstAirDate?: unknown;
}

type RawSearchResult = RawMovieResult & RawTvResult & { mediaType?: unknown };

interface RawSearchResponse {
  results?: unknown;
}

function extractYear(date: unknown): string | null {
  if (typeof date !== 'string' || date.length < 4) {
    return null;
  }
  return date.slice(0, 4);
}

function mapStatus(raw: RawSearchResult): MediaStatus | null {
  const code = raw.mediaInfo?.status;
  if (typeof code !== 'number') {
    return null;
  }
  return MEDIA_STATUS_BY_CODE[code] ?? null;
}

function toCandidate(raw: RawSearchResult): SearchCandidate | null {
  if (raw.mediaType !== 'movie' && raw.mediaType !== 'tv') {
    return null;
  }
  if (typeof raw.id !== 'number') {
    return null;
  }

  const isMovie = raw.mediaType === 'movie';
  const title = isMovie ? raw.title : raw.name;
  if (typeof title !== 'string') {
    return null;
  }

  return {
    mediaType: raw.mediaType,
    overview: typeof raw.overview === 'string' ? raw.overview : null,
    popularity: typeof raw.popularity === 'number' ? raw.popularity : 0,
    posterUrl:
      typeof raw.posterPath === 'string'
        ? `${TMDB_IMAGE_BASE}${raw.posterPath}`
        : null,
    status: mapStatus(raw),
    title,
    tmdbId: raw.id,
    year: extractYear(isMovie ? raw.releaseDate : raw.firstAirDate),
  };
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
}

export function createOverseerrClient(
  options: CreateOverseerrClientOptions,
): OverseerrClient {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const request = async (
    path: string,
    reqOptions: RequestOptions = {},
  ): Promise<unknown> => {
    const method = reqOptions.method ?? 'GET';
    const headers: Record<string, string> = { 'X-Api-Key': options.apiKey };
    let body: string | undefined;
    if (reqOptions.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(reqOptions.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const init: RequestInit = { headers, method, signal: controller.signal };
    if (body !== undefined) {
      init.body = body;
    }
    let response: Response;
    try {
      response = await fetchFn(`${base}/api/v1${path}`, init);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OverseerrTimeoutError(
          `Overseerr request to ${path} exceeded ${timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) {
      throw new OverseerrUnauthorizedError();
    }
    if (response.status === 404) {
      throw new OverseerrNotFoundError();
    }
    if (!response.ok) {
      throw new OverseerrError(
        `Overseerr returned ${response.status} for ${path}`,
        response.status,
      );
    }

    return response.json();
  };

  return {
    async createRequest(input: CreateRequestInput): Promise<void> {
      // Default TV requests to the full series per plan.md.
      const body: Record<string, unknown> = {
        mediaId: input.tmdbId,
        mediaType: input.mediaType,
      };
      if (input.mediaType === 'tv') {
        body.seasons = 'all';
      }
      if (input.is4k === true) {
        body.is4k = true;
      }
      await request('/request', { body, method: 'POST' });
    },
    async getStatus(): Promise<OverseerrStatus> {
      const data = (await request('/status')) as { version?: unknown };
      if (typeof data.version !== 'string') {
        throw new OverseerrError('Overseerr status response missing version');
      }
      return { version: data.version };
    },

    async search(query: string): Promise<SearchCandidate[]> {
      const params = new URLSearchParams({ query });
      const data = (await request(
        `/search?${params.toString()}`,
      )) as RawSearchResponse;
      if (!Array.isArray(data.results)) {
        return [];
      }
      const candidates: SearchCandidate[] = [];
      for (const raw of data.results as RawSearchResult[]) {
        const candidate = toCandidate(raw);
        if (candidate !== null) {
          candidates.push(candidate);
        }
      }
      return candidates;
    },
  };
}
