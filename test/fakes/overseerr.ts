import type {
  CallOptions,
  CreateRequestInput,
  DetailsRequestInput,
  MediaDetails,
  OverseerrClient,
  OverseerrStatus,
  SearchCandidate,
} from '../../src/overseerr/client.js';

export interface SearchCall {
  query: string;
}
export interface DetailsCall {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
}
export interface CreateCall {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
}

export interface FakeOverseerrOptions {
  status?: OverseerrStatus;
  searchResults?: SearchCandidate[] | Map<string, SearchCandidate[]>;
  detailsByTmdbId?: Map<number, MediaDetails>;
  /**
   * Per-call override hooks. When set, the hook replaces the default
   * behaviour — useful for error injection (timeouts, not-found, etc.).
   */
  onSearch?: (
    query: string,
    options?: CallOptions,
  ) => Promise<SearchCandidate[]>;
  onGetMediaDetails?: (
    input: DetailsRequestInput,
    options?: CallOptions,
  ) => Promise<MediaDetails>;
  onCreateRequest?: (
    input: CreateRequestInput,
    options?: CallOptions,
  ) => Promise<void>;
}

export interface FakeOverseerr extends OverseerrClient {
  searchCalls: SearchCall[];
  detailsCalls: DetailsCall[];
  createCalls: CreateCall[];
}

export function createFakeOverseerr(
  options: FakeOverseerrOptions = {},
): FakeOverseerr {
  const searchCalls: SearchCall[] = [];
  const detailsCalls: DetailsCall[] = [];
  const createCalls: CreateCall[] = [];

  const resolveSearchResults = (query: string): SearchCandidate[] => {
    const src = options.searchResults;
    if (src instanceof Map) {
      return src.get(query) ?? [];
    }
    return src ?? [];
  };

  return {
    createCalls,
    createRequest(input, callOptions) {
      createCalls.push({ mediaType: input.mediaType, tmdbId: input.tmdbId });
      if (options.onCreateRequest) {
        return options.onCreateRequest(input, callOptions);
      }
      return Promise.resolve();
    },
    detailsCalls,
    getMediaDetails(input, callOptions) {
      detailsCalls.push({
        mediaType: input.mediaType,
        tmdbId: input.tmdbId,
      });
      if (options.onGetMediaDetails) {
        return options.onGetMediaDetails(input, callOptions);
      }
      const match = options.detailsByTmdbId?.get(input.tmdbId);
      if (!match) {
        return Promise.reject(
          new Error(
            `FakeOverseerr: no details registered for tmdbId=${input.tmdbId}`,
          ),
        );
      }
      return Promise.resolve(match);
    },
    getStatus(_callOptions) {
      return Promise.resolve(options.status ?? { version: '0.0.0-fake' });
    },
    search(query, callOptions) {
      searchCalls.push({ query });
      if (options.onSearch) {
        return options.onSearch(query, callOptions);
      }
      return Promise.resolve(resolveSearchResults(query));
    },
    searchCalls,
  };
}
