import {
  OverseerrError,
  OverseerrNotFoundError,
  OverseerrTimeoutError,
  OverseerrUnauthorizedError,
} from './errors.js';

// 10s default — Overseerr usually answers in <1s.
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

// w342 is the chosen poster size for Telegram inline cards.
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

export interface DetailsRequestInput {
  tmdbId: number;
  mediaType: OverseerrMediaType;
}

export interface CastMember {
  name: string;
  character: string | null;
}

/**
 * LLM-friendly projection of Overseerr `/movie/{id}` or `/tv/{id}` responses.
 * The orchestrator forwards this shape to the model as a tool result, so it is
 * deliberately small — just the fields needed to answer clarifying questions
 * ("is that the Bale one?", "what's the runtime?").
 */
export interface MediaDetails {
  tmdbId: number;
  mediaType: OverseerrMediaType;
  title: string;
  year: string | null;
  overview: string | null;
  posterUrl: string | null;
  releaseDate: string | null;
  runtime: number | null;
  status: MediaStatus | null;
  genres: string[];
  directors: string[];
  createdBy: string[];
  networks: string[];
  cast: CastMember[];
  voteAverage: number | null;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface OverseerrClient {
  getStatus(options?: CallOptions): Promise<OverseerrStatus>;
  search(query: string, options?: CallOptions): Promise<SearchCandidate[]>;
  createRequest(
    input: CreateRequestInput,
    options?: CallOptions,
  ): Promise<void>;
  getMediaDetails(
    input: DetailsRequestInput,
    options?: CallOptions,
  ): Promise<MediaDetails>;
}

export interface CreateOverseerrClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractYear(date: unknown): string | null {
  if (typeof date !== 'string' || date.length < 4) {
    return null;
  }
  return date.slice(0, 4);
}

function mapStatus(mediaInfo: unknown): MediaStatus | null {
  const info = asRecord(mediaInfo);
  const code = info?.status;
  if (typeof code !== 'number') {
    return null;
  }
  return MEDIA_STATUS_BY_CODE[code] ?? null;
}

// Cap so tool-result payloads stay small; the LLM does not need the full
// cast for a disambiguation reply.
const MAX_CAST_MEMBERS = 10;

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record !== null) {
      out.push(record);
    }
  }
  return out;
}

function extractNames(entries: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry.name === 'string') {
      out.push(entry.name);
    }
  }
  return out;
}

function extractDirectors(crew: unknown): string[] {
  const out: string[] = [];
  for (const entry of asRecordArray(crew)) {
    if (entry.job === 'Director' && typeof entry.name === 'string') {
      out.push(entry.name);
    }
  }
  return out;
}

function extractCast(cast: unknown): CastMember[] {
  const entries = asRecordArray(cast);
  // Sort by TMDB `order` (billing order); low order = top billed.
  entries.sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : Number.POSITIVE_INFINITY;
    const bo = typeof b.order === 'number' ? b.order : Number.POSITIVE_INFINITY;
    return ao - bo;
  });
  const out: CastMember[] = [];
  for (const entry of entries.slice(0, MAX_CAST_MEMBERS)) {
    if (typeof entry.name !== 'string') {
      continue;
    }
    out.push({
      character: typeof entry.character === 'string' ? entry.character : null,
      name: entry.name,
    });
  }
  return out;
}

function stringFieldOrNull(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function toDetails(raw: unknown, input: DetailsRequestInput): MediaDetails {
  const r = asRecord(raw);
  if (r === null) {
    throw new OverseerrError(
      `Overseerr ${input.mediaType} details response was not an object`,
    );
  }

  const credits = asRecord(r.credits);
  const cast = extractCast(credits?.cast);
  const directors = extractDirectors(credits?.crew);
  const genres = extractNames(asRecordArray(r.genres));
  const createdBy = extractNames(asRecordArray(r.createdBy));
  const networks = extractNames(asRecordArray(r.networks));

  // Overseerr uses TMDB-native field names: movies expose `title` + `releaseDate`,
  // TV exposes `name` + `firstAirDate`.
  const title =
    input.mediaType === 'movie'
      ? stringFieldOrNull(r, 'title')
      : stringFieldOrNull(r, 'name');
  if (title === null) {
    throw new OverseerrError(
      `Overseerr ${input.mediaType} details response missing title`,
    );
  }

  const releaseDate =
    input.mediaType === 'movie'
      ? stringFieldOrNull(r, 'releaseDate')
      : stringFieldOrNull(r, 'firstAirDate');

  return {
    cast,
    createdBy,
    directors,
    genres,
    mediaType: input.mediaType,
    networks,
    overview: typeof r.overview === 'string' ? r.overview : null,
    posterUrl:
      typeof r.posterPath === 'string'
        ? `${TMDB_IMAGE_BASE}${r.posterPath}`
        : null,
    releaseDate,
    runtime: typeof r.runtime === 'number' ? r.runtime : null,
    status: mapStatus(r.mediaInfo),
    title,
    tmdbId: input.tmdbId,
    voteAverage: typeof r.voteAverage === 'number' ? r.voteAverage : null,
    year: extractYear(releaseDate),
  };
}

function toCandidate(raw: unknown): SearchCandidate | null {
  const r = asRecord(raw);
  if (r === null) {
    return null;
  }

  const mediaType = r.mediaType;
  if (mediaType !== 'movie' && mediaType !== 'tv') {
    return null;
  }

  const tmdbId = r.id;
  if (typeof tmdbId !== 'number') {
    return null;
  }

  const title = mediaType === 'movie' ? r.title : r.name;
  if (typeof title !== 'string') {
    return null;
  }

  const dateField = mediaType === 'movie' ? r.releaseDate : r.firstAirDate;

  return {
    mediaType,
    overview: typeof r.overview === 'string' ? r.overview : null,
    popularity: typeof r.popularity === 'number' ? r.popularity : 0,
    posterUrl:
      typeof r.posterPath === 'string'
        ? `${TMDB_IMAGE_BASE}${r.posterPath}`
        : null,
    status: mapStatus(r.mediaInfo),
    title,
    tmdbId,
    year: extractYear(dateField),
  };
}

interface ErrorMeta {
  errorCode?: number;
  message?: string;
}

function extractErrorMeta(body: unknown): ErrorMeta {
  const r = asRecord(body);
  if (r === null) {
    return {};
  }
  const result: ErrorMeta = {};
  if (typeof r.errorCode === 'number') {
    result.errorCode = r.errorCode;
  }
  if (typeof r.message === 'string') {
    result.message = r.message;
  }
  return result;
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function buildErrorFromResponse(
  response: Response,
  path: string,
): Promise<OverseerrError> {
  const body = await readErrorBody(response);
  const meta = extractErrorMeta(body);
  const baseMessage = `Overseerr returned ${response.status} for ${path}`;
  const message = meta.message
    ? `${baseMessage}: ${meta.message}`
    : baseMessage;

  switch (response.status) {
    case 401:
      return new OverseerrUnauthorizedError(message, meta.errorCode, body);
    case 404:
      return new OverseerrNotFoundError(message, meta.errorCode, body);
    default:
      return new OverseerrError(message, response.status, meta.errorCode, body);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
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
    let bodyString: string | undefined;
    if (reqOptions.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyString = JSON.stringify(reqOptions.body);
    }

    const internalSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = reqOptions.signal
      ? AbortSignal.any([internalSignal, reqOptions.signal])
      : internalSignal;

    const init: RequestInit = { headers, method, signal: combinedSignal };
    if (bodyString !== undefined) {
      init.body = bodyString;
    }

    let response: Response;
    try {
      response = await fetchFn(`${base}/api/v1${path}`, init);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        // External signal wins if both are aborted: respect the caller's intent.
        if (reqOptions.signal?.aborted) {
          throw reqOptions.signal.reason ?? error;
        }
        throw new OverseerrTimeoutError(
          `Overseerr request to ${path} exceeded ${timeoutMs}ms`,
        );
      }
      throw error;
    }

    if (!response.ok) {
      throw await buildErrorFromResponse(response, path);
    }
    return response.json();
  };

  return {
    async createRequest(input, callOptions) {
      // Default TV requests to the full series.
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
      await request('/request', {
        body,
        method: 'POST',
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      });
    },
    async getMediaDetails(input, callOptions) {
      const data = await request(`/${input.mediaType}/${input.tmdbId}`, {
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      });
      return toDetails(data, input);
    },

    async getStatus(callOptions) {
      const data = (await request('/status', {
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      })) as { version?: unknown };
      if (typeof data.version !== 'string') {
        throw new OverseerrError('Overseerr status response missing version');
      }
      return { version: data.version };
    },

    async search(query, callOptions) {
      // Overseerr's query validator rejects `+` as a space encoding and
      // requires percent-escapes. `URLSearchParams.toString()` produces
      // `+` per application/x-www-form-urlencoded, which is valid for
      // form bodies but not for Overseerr's strict URL parser. Use
      // `encodeURIComponent` so spaces become `%20`.
      const data = (await request(
        `/search?query=${encodeURIComponent(query)}`,
        {
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        },
      )) as { results?: unknown };
      if (!Array.isArray(data.results)) {
        return [];
      }
      const candidates: SearchCandidate[] = [];
      for (const raw of data.results) {
        const candidate = toCandidate(raw);
        if (candidate !== null) {
          candidates.push(candidate);
        }
      }
      return candidates;
    },
  };
}
