import type { Tool, ToolCall } from '@mariozechner/pi-ai';
import { Type } from '@mariozechner/pi-ai';

import type { Logger } from '../logging.js';
import type {
  MediaDetails,
  OverseerrClient,
  OverseerrMediaType,
  SearchCandidate,
} from '../overseerr/client.js';
import {
  OverseerrError,
  OverseerrNotFoundError,
  OverseerrTimeoutError,
} from '../overseerr/errors.js';

/** Tools exposed to the LLM. Load-bearing for the security model — see AGENTS.md. */
export type ToolName = 'search_media' | 'get_media_details' | 'request_media';

/** Top-N cap applied to search results after popularity sort. */
const DEFAULT_MAX_SEARCH_RESULTS = 3;

export interface SearchMediaOutput {
  candidates: SearchCandidate[];
}

export interface GetMediaDetailsOutput {
  details: MediaDetails;
}

export type RequestMediaStatus =
  | 'requested'
  | 'already_requested'
  | 'already_available';

export interface RequestMediaOutput {
  status: RequestMediaStatus;
  tmdbId: number;
  mediaType: OverseerrMediaType;
  title: string;
  year: string | null;
  posterUrl: string | null;
  message: string;
}

export interface ToolOutputMap {
  search_media: SearchMediaOutput;
  get_media_details: GetMediaDetailsOutput;
  request_media: RequestMediaOutput;
}

/**
 * Distributed over `ToolName` so `name` acts as a proper discriminant:
 * narrowing with `result.name === 'search_media'` reveals
 * `output: SearchMediaOutput` to callers.
 */
export type ToolDispatchSuccess = {
  [N in ToolName]: {
    isError: false;
    name: N;
    output: ToolOutputMap[N];
    /** JSON-serialised representation of `output`, forwarded to the LLM as text. */
    text: string;
  };
}[ToolName];

/** Terse error codes the LLM has been prompted to recognise. */
export type ToolErrorCode =
  | 'not_found'
  | 'timeout'
  | 'invalid_arguments'
  | 'unknown_tool'
  | 'error';

export interface ToolDispatchFailure {
  isError: true;
  name: ToolName | 'unknown';
  code: ToolErrorCode;
  message: string;
  /** JSON-serialised error payload, forwarded to the LLM as text. */
  text: string;
}

export type ToolDispatchResult = ToolDispatchSuccess | ToolDispatchFailure;

export interface ToolDispatchContext {
  telegramUserId: number;
  signal?: AbortSignal;
}

export interface ToolDispatcher {
  tools: Tool[];
  dispatch(
    call: ToolCall,
    ctx: ToolDispatchContext,
  ): Promise<ToolDispatchResult>;
}

export interface CreateToolDispatcherOptions {
  overseerr: OverseerrClient;
  logger: Logger;
  /** Defaults to 3 — see plan.md. */
  maxSearchResults?: number;
}

const searchMediaTool: Tool = {
  description:
    'Search Overseerr for up to 3 top matching movie or TV candidates by a free-text query. Returns tmdbId, title, year, mediaType, posterUrl, overview, popularity, and availability status.',
  name: 'search_media',
  parameters: Type.Object({
    mediaType: Type.Optional(
      Type.Union([Type.Literal('movie'), Type.Literal('tv')], {
        description: 'Filter to movies or TV only. Omit to return both.',
      }),
    ),
    query: Type.String({
      description:
        'The free-text title the user asked about, e.g. "The Batman".',
      minLength: 1,
    }),
  }),
};

const getMediaDetailsTool: Tool = {
  description:
    'Fetch rich metadata for a specific tmdbId (cast, director/creator, genres, runtime, networks) to answer clarifying questions. Call this only after search_media.',
  name: 'get_media_details',
  parameters: Type.Object({
    mediaType: Type.Union([Type.Literal('movie'), Type.Literal('tv')]),
    tmdbId: Type.Integer({
      description: 'The tmdbId from a prior search_media result.',
    }),
  }),
};

const requestMediaTool: Tool = {
  description:
    'Submit a media request to Overseerr by tmdbId. Idempotent: refuses when the title is already available or requested. TV requests default to the full series.',
  name: 'request_media',
  parameters: Type.Object({
    mediaType: Type.Union([Type.Literal('movie'), Type.Literal('tv')]),
    tmdbId: Type.Integer({
      description: 'The tmdbId from a prior search_media result.',
    }),
  }),
};

const TOOLS: Tool[] = [searchMediaTool, getMediaDetailsTool, requestMediaTool];

interface SearchMediaArgs {
  query: string;
  mediaType?: OverseerrMediaType;
}

function parseSearchMediaArgs(
  raw: Record<string, unknown>,
): SearchMediaArgs | null {
  if (typeof raw.query !== 'string' || raw.query.trim().length === 0) {
    return null;
  }
  const mediaType = raw.mediaType;
  if (mediaType !== undefined && mediaType !== 'movie' && mediaType !== 'tv') {
    return null;
  }
  const args: SearchMediaArgs = { query: raw.query };
  if (mediaType !== undefined) {
    args.mediaType = mediaType;
  }
  return args;
}

interface TmdbIdArgs {
  tmdbId: number;
  mediaType: OverseerrMediaType;
}

function parseTmdbIdArgs(raw: Record<string, unknown>): TmdbIdArgs | null {
  const tmdbId = raw.tmdbId;
  const mediaType = raw.mediaType;
  if (typeof tmdbId !== 'number' || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return null;
  }
  if (mediaType !== 'movie' && mediaType !== 'tv') {
    return null;
  }
  return { mediaType, tmdbId };
}

function invalidArguments(
  name: ToolName,
  message: string,
): ToolDispatchFailure {
  const payload = { code: 'invalid_arguments', error: message };
  return {
    code: 'invalid_arguments',
    isError: true,
    message,
    name,
    text: JSON.stringify(payload),
  };
}

function overseerrFailure(name: ToolName, error: unknown): ToolDispatchFailure {
  let code: ToolErrorCode = 'error';
  let message: string;
  if (error instanceof OverseerrNotFoundError) {
    code = 'not_found';
    message = 'Overseerr has no record of that tmdbId.';
  } else if (error instanceof OverseerrTimeoutError) {
    code = 'timeout';
    message = 'Overseerr did not respond in time.';
  } else if (error instanceof OverseerrError) {
    message = error.message;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = 'Unknown error calling Overseerr.';
  }
  return {
    code,
    isError: true,
    message,
    name,
    text: JSON.stringify({ code, error: message }),
  };
}

function unknownTool(name: string): ToolDispatchFailure {
  const message = `Unknown tool "${name}".`;
  return {
    code: 'unknown_tool',
    isError: true,
    message,
    name: 'unknown',
    text: JSON.stringify({ code: 'unknown_tool', error: message }),
  };
}

function success<N extends ToolName>(
  name: N,
  output: ToolOutputMap[N],
): ToolDispatchSuccess {
  // The cast is safe: `name` and `output` are constrained by the generic to
  // match one branch of the distributed union, but TS can't prove it.
  return {
    isError: false,
    name,
    output,
    text: JSON.stringify(output),
  } as ToolDispatchSuccess;
}

export function createToolDispatcher(
  options: CreateToolDispatcherOptions,
): ToolDispatcher {
  const maxSearch = options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;

  async function handleSearchMedia(
    call: ToolCall,
    ctx: ToolDispatchContext,
  ): Promise<ToolDispatchResult> {
    const args = parseSearchMediaArgs(call.arguments);
    if (args === null) {
      const failure = invalidArguments(
        'search_media',
        'search_media requires { query: string, mediaType?: "movie" | "tv" }.',
      );
      logToolError('search_media', ctx.telegramUserId, failure);
      return failure;
    }

    const signal = ctx.signal;
    let raw: SearchCandidate[];
    try {
      raw = await options.overseerr.search(
        args.query,
        signal ? { signal } : undefined,
      );
    } catch (error) {
      const failure = overseerrFailure('search_media', error);
      logToolError('search_media', ctx.telegramUserId, failure);
      return failure;
    }

    const filtered =
      args.mediaType === undefined
        ? raw
        : raw.filter(c => c.mediaType === args.mediaType);
    const sorted = [...filtered].sort((a, b) => b.popularity - a.popularity);
    const candidates = sorted.slice(0, maxSearch);

    options.logger.info(
      {
        args: { mediaType: args.mediaType, query: args.query },
        resultCount: candidates.length,
        telegramUserId: ctx.telegramUserId,
        toolName: 'search_media',
      },
      'tool_call',
    );

    return success('search_media', { candidates });
  }

  function logToolError(
    toolName: ToolName,
    telegramUserId: number,
    failure: ToolDispatchFailure,
  ): void {
    options.logger.warn(
      { err: failure.message, telegramUserId, toolName },
      'tool_error',
    );
  }

  function buildRequestMediaOutput(
    args: TmdbIdArgs,
    details: MediaDetails,
    status: RequestMediaStatus,
    message: string,
  ): RequestMediaOutput {
    return {
      mediaType: args.mediaType,
      message,
      posterUrl: details.posterUrl,
      status,
      title: details.title,
      tmdbId: args.tmdbId,
      year: details.year,
    };
  }

  async function handleRequestMedia(
    call: ToolCall,
    ctx: ToolDispatchContext,
  ): Promise<ToolDispatchResult> {
    const args = parseTmdbIdArgs(call.arguments);
    if (args === null) {
      const failure = invalidArguments(
        'request_media',
        'request_media requires { tmdbId: positive integer, mediaType: "movie" | "tv" }.',
      );
      logToolError('request_media', ctx.telegramUserId, failure);
      return failure;
    }

    const signal = ctx.signal;
    const callOpts = signal ? { signal } : undefined;

    let details: MediaDetails;
    try {
      details = await options.overseerr.getMediaDetails(args, callOpts);
    } catch (error) {
      const failure = overseerrFailure('request_media', error);
      logToolError('request_media', ctx.telegramUserId, failure);
      return failure;
    }

    // Idempotency: if Overseerr already knows this title is available or in
    // flight, don't re-submit. Treat PARTIALLY_AVAILABLE the same as
    // AVAILABLE (plan.md: home bot doesn't do per-season granularity).
    const duplicateStatus: RequestMediaStatus | null =
      details.status === 'AVAILABLE' || details.status === 'PARTIALLY_AVAILABLE'
        ? 'already_available'
        : details.status === 'PENDING' || details.status === 'PROCESSING'
          ? 'already_requested'
          : null;
    if (duplicateStatus !== null) {
      options.logger.info(
        {
          status: details.status,
          telegramUserId: ctx.telegramUserId,
          title: details.title,
          tmdbId: args.tmdbId,
        },
        'request_duplicate',
      );
      const message =
        duplicateStatus === 'already_available'
          ? `${details.title} is already available on the server.`
          : `${details.title} has already been requested.`;
      return success(
        'request_media',
        buildRequestMediaOutput(args, details, duplicateStatus, message),
      );
    }

    try {
      await options.overseerr.createRequest(args, callOpts);
    } catch (error) {
      // Overseerr's "already exists" race: 409/errorCode 40149. Map to the
      // idempotent already_requested outcome instead of surfacing an error.
      if (
        error instanceof OverseerrError &&
        error.status === 409 &&
        error.errorCode === 40149
      ) {
        options.logger.info(
          {
            status: 'already_requested',
            telegramUserId: ctx.telegramUserId,
            title: details.title,
            tmdbId: args.tmdbId,
          },
          'request_duplicate',
        );
        return success(
          'request_media',
          buildRequestMediaOutput(
            args,
            details,
            'already_requested',
            `${details.title} has already been requested.`,
          ),
        );
      }
      const failure = overseerrFailure('request_media', error);
      logToolError('request_media', ctx.telegramUserId, failure);
      return failure;
    }

    options.logger.info(
      {
        mediaType: args.mediaType,
        telegramUserId: ctx.telegramUserId,
        title: details.title,
        tmdbId: args.tmdbId,
      },
      'request_submitted',
    );
    return success(
      'request_media',
      buildRequestMediaOutput(
        args,
        details,
        'requested',
        `Requested ${details.title}.`,
      ),
    );
  }

  async function handleGetMediaDetails(
    call: ToolCall,
    ctx: ToolDispatchContext,
  ): Promise<ToolDispatchResult> {
    const args = parseTmdbIdArgs(call.arguments);
    if (args === null) {
      const failure = invalidArguments(
        'get_media_details',
        'get_media_details requires { tmdbId: positive integer, mediaType: "movie" | "tv" }.',
      );
      logToolError('get_media_details', ctx.telegramUserId, failure);
      return failure;
    }

    const signal = ctx.signal;
    try {
      const details = await options.overseerr.getMediaDetails(
        args,
        signal ? { signal } : undefined,
      );
      options.logger.info(
        {
          args,
          telegramUserId: ctx.telegramUserId,
          toolName: 'get_media_details',
        },
        'tool_call',
      );
      return success('get_media_details', { details });
    } catch (error) {
      const failure = overseerrFailure('get_media_details', error);
      logToolError('get_media_details', ctx.telegramUserId, failure);
      return failure;
    }
  }

  return {
    dispatch(call, ctx) {
      switch (call.name) {
        case 'search_media':
          return handleSearchMedia(call, ctx);
        case 'get_media_details':
          return handleGetMediaDetails(call, ctx);
        case 'request_media':
          return handleRequestMedia(call, ctx);
        default: {
          // Log with the offending tool name (not the dispatcher's sentinel
          // 'unknown') so logs point at what the LLM actually tried to call.
          const failure = unknownTool(call.name);
          options.logger.warn(
            {
              err: failure.message,
              telegramUserId: ctx.telegramUserId,
              toolName: call.name,
            },
            'tool_error',
          );
          return Promise.resolve(failure);
        }
      }
    },
    tools: TOOLS,
  };
}
