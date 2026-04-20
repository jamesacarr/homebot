import type {
  AssistantMessage,
  Context,
  FauxProviderRegistration,
  Model,
} from '@mariozechner/pi-ai';
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
} from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOrchestrator } from '../../src/llm/orchestrator.js';
import { silentLogger } from '../../src/logging.js';
import type { SearchCandidate } from '../../src/overseerr/client.js';
import { OverseerrNotFoundError } from '../../src/overseerr/errors.js';
import { createFakeOverseerr } from '../fakes/overseerr.js';

// Keep price above zero so we can verify cost accumulation is plumbed through.
const COST_PER_TOKEN = 0.000_001;

let faux: FauxProviderRegistration;
let model: Model<string>;

beforeEach(() => {
  faux = registerFauxProvider({
    models: [
      {
        cost: {
          cacheRead: COST_PER_TOKEN,
          cacheWrite: COST_PER_TOKEN,
          input: COST_PER_TOKEN,
          output: COST_PER_TOKEN,
        },
        id: 'faux-orchestrator',
      },
    ],
  });
  const m = faux.getModel();
  if (m === undefined) {
    throw new Error('faux model missing');
  }
  model = m;
});

afterEach(() => {
  faux.unregister();
});

function bareSystemPrompt(): string {
  return 'You are a test assistant.';
}

const theBatman: SearchCandidate = {
  mediaType: 'movie',
  overview: 'Moody noir reboot',
  popularity: 200,
  posterUrl: 'https://image.tmdb.org/t/p/w342/bat2022.jpg',
  status: null,
  title: 'The Batman',
  tmdbId: 414906,
  year: '2022',
};

const batmanBegins: SearchCandidate = {
  mediaType: 'movie',
  overview: 'Nolan origin',
  popularity: 150,
  posterUrl: 'https://image.tmdb.org/t/p/w342/bale.jpg',
  status: null,
  title: 'Batman Begins',
  tmdbId: 272,
  year: '2005',
};

describe('orchestrator — happy path', () => {
  it('searches, auto-requests when there is one clear match, and returns a text confirmation', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([
        [
          414906,
          {
            cast: [],
            createdBy: [],
            directors: [],
            genres: [],
            mediaType: 'movie',
            networks: [],
            overview: 'Moody noir reboot',
            releaseDate: '2022-03-01',
            runtime: 176,
            status: null,
            title: 'The Batman',
            tmdbId: 414906,
            voteAverage: 7.8,
            year: '2022',
          },
        ],
      ]),
      searchResults: [theBatman],
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

    const orchestrate = createOrchestrator({
      llmModel: model,
      logger: silentLogger,
      overseerr,
      systemPrompt: bareSystemPrompt(),
      thinkingLevel: 'off',
    });

    const result = await orchestrate({
      abortSignal: new AbortController().signal,
      incomingText: 'add The Batman',
      now: 1_700_000_000_000,
      priorMessages: [],
      telegramUserId: 42,
    });

    // Plan: confirmation + poster. Caption empty — the LLM's text is a
    // separate reply, and Telegram shows one photo uncaptioned alongside.
    expect(result.replies).toEqual([
      { kind: 'text', text: 'Requested *The Batman (2022)*. ✓' },
      {
        caption: '',
        kind: 'photo',
        posterUrl: 'https://image.tmdb.org/t/p/w342/bat2022.jpg',
      },
    ]);
    expect(overseerr.searchCalls).toEqual([{ query: 'The Batman' }]);
    expect(overseerr.createCalls).toEqual([
      { mediaType: 'movie', tmdbId: 414906 },
    ]);
    // turnToPersist should carry: user msg + 3 assistant msgs + 2 toolResults.
    const roles = (result.turnToPersist as { role: string }[]).map(m => m.role);
    expect(roles).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
      'toolResult',
      'assistant',
    ]);
    expect(result.costDeltaUsd).toBeGreaterThan(0);
  });
});

describe('orchestrator — disambiguation', () => {
  it('fans out to photo cards and a numbered keyboard when search returns multiple candidates', async () => {
    const overseerr = createFakeOverseerr({
      searchResults: [theBatman, batmanBegins],
    });

    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('search_media', { query: 'Batman' }, { id: 'c1' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Which of these did you mean?'),
    ]);

    const orchestrate = createOrchestrator({
      llmModel: model,
      logger: silentLogger,
      overseerr,
      systemPrompt: bareSystemPrompt(),
      thinkingLevel: 'off',
    });

    const result = await orchestrate({
      abortSignal: new AbortController().signal,
      incomingText: 'add Batman',
      now: 1_700_000_000_000,
      priorMessages: [],
      telegramUserId: 42,
    });

    expect(result.replies).toEqual([
      { kind: 'text', text: 'Which of these did you mean?' },
      {
        caption: '*Option 1:* The Batman (2022)\n\nMoody noir reboot',
        kind: 'photo',
        posterUrl: 'https://image.tmdb.org/t/p/w342/bat2022.jpg',
      },
      {
        caption: '*Option 2:* Batman Begins (2005)\n\nNolan origin',
        kind: 'photo',
        posterUrl: 'https://image.tmdb.org/t/p/w342/bale.jpg',
      },
      {
        buttons: [
          { data: 'pick:414906:movie', label: '1' },
          { data: 'pick:272:movie', label: '2' },
        ],
        kind: 'keyboard',
        text: 'Pick one:',
      },
    ]);
  });

  it('omits the candidates without a poster URL from the photo fan-out but keeps them on the keyboard', async () => {
    const noPoster: SearchCandidate = {
      ...batmanBegins,
      posterUrl: null,
      title: 'Batman & Robin',
      tmdbId: 999,
    };
    const overseerr = createFakeOverseerr({
      searchResults: [theBatman, noPoster],
    });

    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('search_media', { query: 'Batman' }, { id: 'c1' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Pick one:'),
    ]);

    const orchestrate = createOrchestrator({
      llmModel: model,
      logger: silentLogger,
      overseerr,
      systemPrompt: bareSystemPrompt(),
      thinkingLevel: 'off',
    });

    const result = await orchestrate({
      abortSignal: new AbortController().signal,
      incomingText: 'add Batman',
      now: 1_700_000_000_000,
      priorMessages: [],
      telegramUserId: 42,
    });

    const photos = result.replies.filter(r => r.kind === 'photo');
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({
      posterUrl: 'https://image.tmdb.org/t/p/w342/bat2022.jpg',
    });

    const keyboard = result.replies.find(r => r.kind === 'keyboard');
    if (keyboard?.kind !== 'keyboard') {
      throw new Error('expected a keyboard reply');
    }
    expect(keyboard.buttons).toHaveLength(2);
  });
});

describe('orchestrator — status-aware flows', () => {
  it('does not submit a request when the title is already AVAILABLE', async () => {
    const availableBatman: SearchCandidate = {
      ...theBatman,
      status: 'AVAILABLE',
    };
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([
        [
          414906,
          {
            cast: [],
            createdBy: [],
            directors: [],
            genres: [],
            mediaType: 'movie',
            networks: [],
            overview: 'Moody noir reboot',
            releaseDate: '2022-03-01',
            runtime: 176,
            status: 'AVAILABLE',
            title: 'The Batman',
            tmdbId: 414906,
            voteAverage: 7.8,
            year: '2022',
          },
        ],
      ]),
      searchResults: [availableBatman],
    });

    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('search_media', { query: 'The Batman' }, { id: 'c1' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        '*The Batman* is already on the server. Want me to add something else?',
      ),
    ]);

    const orchestrate = createOrchestrator({
      llmModel: model,
      logger: silentLogger,
      overseerr,
      systemPrompt: bareSystemPrompt(),
      thinkingLevel: 'off',
    });

    const result = await orchestrate({
      abortSignal: new AbortController().signal,
      incomingText: 'add The Batman',
      now: 1_700_000_000_000,
      priorMessages: [],
      telegramUserId: 42,
    });

    expect(overseerr.createCalls).toEqual([]);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.kind).toBe('text');
  });

  it('calls get_media_details to answer clarifying questions without re-searching', async () => {
    const overseerr = createFakeOverseerr({
      detailsByTmdbId: new Map([
        [
          272,
          {
            cast: [
              { character: 'Bruce Wayne', name: 'Christian Bale' },
              { character: 'Henri Ducard', name: 'Liam Neeson' },
            ],
            createdBy: [],
            directors: ['Christopher Nolan'],
            genres: ['Action'],
            mediaType: 'movie',
            networks: [],
            overview: 'Nolan origin',
            releaseDate: '2005-06-15',
            runtime: 140,
            status: null,
            title: 'Batman Begins',
            tmdbId: 272,
            voteAverage: 7.7,
            year: '2005',
          },
        ],
      ]),
    });

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'get_media_details',
            { mediaType: 'movie', tmdbId: 272 },
            { id: 'c1' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        'Yes — option 2, *Batman Begins*. Christian Bale plays Bruce Wayne.',
      ),
    ]);

    const orchestrate = createOrchestrator({
      llmModel: model,
      logger: silentLogger,
      overseerr,
      systemPrompt: bareSystemPrompt(),
      thinkingLevel: 'off',
    });

    const result = await orchestrate({
      abortSignal: new AbortController().signal,
      incomingText: 'is any of them the Christian Bale one?',
      now: 1_700_000_000_000,
      priorMessages: [],
      telegramUserId: 42,
    });

    expect(overseerr.detailsCalls).toEqual([
      { mediaType: 'movie', tmdbId: 272 },
    ]);
    expect(overseerr.searchCalls).toEqual([]);
    expect(overseerr.createCalls).toEqual([]);
    expect(result.replies).toEqual([
      {
        kind: 'text',
        text: 'Yes — option 2, *Batman Begins*. Christian Bale plays Bruce Wayne.',
      },
    ]);
  });

  it('surfaces a tool error to the LLM as isError=true so it can recover', async () => {
    const overseerr = createFakeOverseerr({
      onGetMediaDetails: () => Promise.reject(new OverseerrNotFoundError()),
    });

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'request_media',
            { mediaType: 'movie', tmdbId: 999 },
            { id: 'c1' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        'Hmm — I couldn\u2019t find that title. Want to try a different name?',
      ),
    ]);

    const orchestrate = createOrchestrator({
      llmModel: model,
      logger: silentLogger,
      overseerr,
      systemPrompt: bareSystemPrompt(),
      thinkingLevel: 'off',
    });

    const result = await orchestrate({
      abortSignal: new AbortController().signal,
      incomingText: 'add tmdb 999',
      now: 1_700_000_000_000,
      priorMessages: [],
      telegramUserId: 42,
    });

    expect(overseerr.createCalls).toEqual([]);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.kind).toBe('text');
    const toolResults = (
      result.turnToPersist as { role: string; isError?: boolean }[]
    ).filter(m => m.role === 'toolResult');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.isError).toBe(true);
  });
});

describe('orchestrator — caps and error paths', () => {
  it('bails with an apologetic text reply when the tool-round cap is hit', async () => {
    const overseerr = createFakeOverseerr({
      searchResults: [theBatman, batmanBegins],
    });

    // Feed 6 tool-calling assistant messages. The orchestrator should cap at
    // maxToolRounds=2 and stop before executing the 3rd, returning its own
    // apologetic text rather than looping forever.
    const searchAgain = (id: string): AssistantMessage =>
      fauxAssistantMessage(
        [fauxToolCall('search_media', { query: 'x' }, { id })],
        {
          stopReason: 'toolUse',
        },
      );
    faux.setResponses([
      searchAgain('c1'),
      searchAgain('c2'),
      searchAgain('c3'),
      searchAgain('c4'),
    ]);

    const orchestrate = createOrchestrator({
      llmModel: model,
      logger: silentLogger,
      maxToolRounds: 2,
      overseerr,
      systemPrompt: bareSystemPrompt(),
      thinkingLevel: 'off',
    });

    const result = await orchestrate({
      abortSignal: new AbortController().signal,
      incomingText: 'loop',
      now: 1_700_000_000_000,
      priorMessages: [],
      telegramUserId: 42,
    });

    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.kind).toBe('text');
    if (result.replies[0]?.kind !== 'text') {
      throw new Error('unreachable');
    }
    expect(result.replies[0].text).toMatch(/stuck/i);
  });

  it('returns an apologetic reply when the master abort signal fires mid-call', async () => {
    const overseerr = createFakeOverseerr({
      searchResults: [theBatman],
    });

    const controller = new AbortController();
    faux.setResponses([
      (_ctx, _opts, _state, _m): Promise<AssistantMessage> => {
        // Aborting during the LLM call triggers the pi-ai faux provider's
        // abort handling, surfacing stopReason='aborted'.
        controller.abort(new Error('master timeout hit'));
        return Promise.resolve(
          fauxAssistantMessage([fauxText('unused')], { stopReason: 'stop' }),
        );
      },
    ]);

    const orchestrate = createOrchestrator({
      llmModel: model,
      logger: silentLogger,
      overseerr,
      systemPrompt: bareSystemPrompt(),
      thinkingLevel: 'off',
    });

    const result = await orchestrate({
      abortSignal: controller.signal,
      incomingText: 'anything',
      now: 1_700_000_000_000,
      priorMessages: [],
      telegramUserId: 42,
    });

    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.kind).toBe('text');
  });
});

describe('orchestrator — context carry-through', () => {
  it('forwards prior messages and system prompt verbatim to pi-ai', async () => {
    const overseerr = createFakeOverseerr();
    const captured: Context[] = [];

    faux.setResponses([
      (ctx): AssistantMessage => {
        captured.push(structuredClone(ctx) as Context);
        return fauxAssistantMessage('hi');
      },
    ]);

    const orchestrate = createOrchestrator({
      llmModel: model,
      logger: silentLogger,
      overseerr,
      systemPrompt: 'SYSTEM_PROMPT_UNIQUE_MARKER',
      thinkingLevel: 'off',
    });

    const priorUserMessage = {
      content: 'earlier question',
      role: 'user' as const,
      timestamp: 1,
    };
    const priorAssistantMessage = {
      api: 'faux',
      content: [{ text: 'earlier answer', type: 'text' as const }],
      model: 'faux-orchestrator',
      provider: 'faux',
      role: 'assistant' as const,
      stopReason: 'stop' as const,
      timestamp: 2,
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
      },
    };

    await orchestrate({
      abortSignal: new AbortController().signal,
      incomingText: 'new question',
      now: 1_700_000_000_000,
      priorMessages: [priorUserMessage, priorAssistantMessage],
      telegramUserId: 42,
    });

    expect(captured).toHaveLength(1);
    const ctx = captured[0];
    if (!ctx) {
      throw new Error('no context captured');
    }
    expect(ctx.systemPrompt).toBe('SYSTEM_PROMPT_UNIQUE_MARKER');
    expect(ctx.messages.map(m => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(ctx.messages[2]).toMatchObject({
      content: 'new question',
      role: 'user',
    });
    expect(ctx.tools?.map(t => t.name).sort()).toEqual([
      'get_media_details',
      'request_media',
      'search_media',
    ]);
  });
});
