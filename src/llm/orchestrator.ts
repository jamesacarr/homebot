import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  ThinkingLevel as PiAiThinkingLevel,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@mariozechner/pi-ai';
import { calculateCost, completeSimple } from '@mariozechner/pi-ai';

import type { ThinkingLevel } from '../config.js';
import type { Logger } from '../logging.js';
import type {
  OverseerrClient,
  OverseerrMediaType,
  SearchCandidate,
} from '../overseerr/client.js';
import type { ToolDispatcher, ToolDispatchResult } from './tools.js';
import { createToolDispatcher } from './tools.js';

/** Default safety cap on LLM loop iterations per user message. See plan.md. */
const DEFAULT_MAX_TOOL_ROUNDS = 5;

/**
 * Output of the orchestrator, translated into Telegram API calls by the adapter.
 * Deliberately Telegram-agnostic so orchestrator tests never need grammY.
 */
export type Reply =
  | { kind: 'text'; text: string }
  | { kind: 'photo'; posterUrl: string; caption: string }
  | {
      kind: 'keyboard';
      text: string;
      buttons: { label: string; data: string }[];
    };

export interface OrchestratorInput {
  telegramUserId: number;
  incomingText: string;
  /** The flattened message list from `loadRecentTurnMessages`. */
  priorMessages: unknown[];
  now: number;
  /** Master abort signal — the caller's per-message ceiling (e.g. 120s). */
  abortSignal: AbortSignal;
}

export interface OrchestratorOutput {
  replies: Reply[];
  /** User message + all assistant + toolResult messages produced this turn. */
  turnToPersist: Message[];
  costDeltaUsd: number;
}

export interface CreateOrchestratorDeps {
  llmModel: Model<Api>;
  /** Config thinking level — `'off'` suppresses the reasoning option entirely. */
  thinkingLevel: ThinkingLevel;
  overseerr: OverseerrClient;
  systemPrompt: string;
  logger: Logger;
  maxToolRounds?: number;
}

export type Orchestrator = (
  input: OrchestratorInput,
) => Promise<OrchestratorOutput>;

function toPiAiReasoning(level: ThinkingLevel): PiAiThinkingLevel | undefined {
  return level === 'off' ? undefined : level;
}

function extractAssistantText(message: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    }
  }
  return parts.join('').trim();
}

function extractToolCalls(message: AssistantMessage): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const block of message.content) {
    if (block.type === 'toolCall') {
      calls.push(block);
    }
  }
  return calls;
}

function buildToolResultMessage(
  call: ToolCall,
  result: ToolDispatchResult,
  now: number,
): ToolResultMessage {
  const content: TextContent[] = [{ text: result.text, type: 'text' }];
  return {
    content,
    isError: result.isError,
    role: 'toolResult',
    timestamp: now,
    toolCallId: call.id,
    toolName: call.name,
  };
}

interface TurnToolHistory {
  lastSearchCandidates: SearchCandidate[] | null;
  hadSuccessfulRequest: boolean;
  lastRequestedTmdbId: number | null;
}

function updateHistory(
  history: TurnToolHistory,
  result: ToolDispatchResult,
): void {
  if (result.isError) {
    return;
  }
  if (result.name === 'search_media') {
    history.lastSearchCandidates = result.output.candidates;
    return;
  }
  if (result.name === 'request_media') {
    if (result.output.status === 'requested') {
      history.hadSuccessfulRequest = true;
      history.lastRequestedTmdbId = result.output.tmdbId;
    }
  }
}

function findPoster(
  candidates: SearchCandidate[] | null,
  tmdbId: number | null,
): string | null {
  if (candidates === null || tmdbId === null) {
    return null;
  }
  return candidates.find(c => c.tmdbId === tmdbId)?.posterUrl ?? null;
}

function buildPickerReplies(
  candidates: SearchCandidate[],
  assistantText: string,
): Reply[] {
  const replies: Reply[] = [];
  if (assistantText.length > 0) {
    replies.push({ kind: 'text', text: assistantText });
  }
  candidates.forEach((candidate, index) => {
    if (candidate.posterUrl === null) {
      return;
    }
    const year = candidate.year ? ` (${candidate.year})` : '';
    const overview =
      candidate.overview === null ? '' : `\n\n${candidate.overview}`;
    replies.push({
      caption: `*Option ${index + 1}:* ${candidate.title}${year}${overview}`,
      kind: 'photo',
      posterUrl: candidate.posterUrl,
    });
  });
  const buttons = candidates.map((c, index) => ({
    data: encodePickCallback(c.tmdbId, c.mediaType),
    label: String(index + 1),
  }));
  replies.push({ buttons, kind: 'keyboard', text: 'Pick one:' });
  return replies;
}

function encodePickCallback(
  tmdbId: number,
  mediaType: OverseerrMediaType,
): string {
  return `pick:${tmdbId}:${mediaType}`;
}

function buildFinalReplies(
  assistantText: string,
  history: TurnToolHistory,
): Reply[] {
  if (history.hadSuccessfulRequest) {
    const replies: Reply[] = [];
    if (assistantText.length > 0) {
      replies.push({ kind: 'text', text: assistantText });
    }
    const poster = findPoster(
      history.lastSearchCandidates,
      history.lastRequestedTmdbId,
    );
    if (poster !== null) {
      replies.push({ caption: '', kind: 'photo', posterUrl: poster });
    }
    return replies;
  }

  if (
    history.lastSearchCandidates !== null &&
    history.lastSearchCandidates.length > 1
  ) {
    return buildPickerReplies(history.lastSearchCandidates, assistantText);
  }

  if (assistantText.length === 0) {
    return [
      {
        kind: 'text',
        text: "I couldn't put together a reply — try rephrasing?",
      },
    ];
  }
  return [{ kind: 'text', text: assistantText }];
}

export function createOrchestrator(deps: CreateOrchestratorDeps): Orchestrator {
  const dispatcher: ToolDispatcher = createToolDispatcher({
    logger: deps.logger,
    overseerr: deps.overseerr,
  });
  const maxToolRounds = deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const reasoning = toPiAiReasoning(deps.thinkingLevel);

  return async function orchestrate(input) {
    const turnLog = deps.logger.child({
      telegramUserId: input.telegramUserId,
    });

    const userMessage: UserMessage = {
      content: input.incomingText,
      role: 'user',
      timestamp: input.now,
    };

    // Prior messages come from persistent storage as `unknown[]`. We trust the
    // v:1 envelope check in conversations.ts to have filtered bad shapes.
    const priorMessages = input.priorMessages as Message[];
    const contextMessages: Message[] = [...priorMessages, userMessage];
    const newMessages: Message[] = [userMessage];

    const history: TurnToolHistory = {
      hadSuccessfulRequest: false,
      lastRequestedTmdbId: null,
      lastSearchCandidates: null,
    };

    let costDeltaUsd = 0;
    let finalAssistantMessage: AssistantMessage | null = null;
    let capHit = false;

    for (let round = 0; round <= maxToolRounds; round++) {
      const context: Context = {
        messages: contextMessages,
        systemPrompt: deps.systemPrompt,
        tools: dispatcher.tools,
      };

      turnLog.info({ model: deps.llmModel.id, turnIndex: round }, 'llm_call');

      let assistant: AssistantMessage;
      try {
        assistant = await completeSimple(deps.llmModel, context, {
          ...(reasoning === undefined ? {} : { reasoning }),
          signal: input.abortSignal,
        });
      } catch (error) {
        turnLog.error({ err: error }, 'llm_call_failed');
        return {
          costDeltaUsd,
          replies: [
            {
              kind: 'text',
              text: 'Something went wrong talking to the model — try again in a moment?',
            },
          ],
          turnToPersist: newMessages,
        };
      }

      // Don't trust `usage.cost.total` from the provider — some providers
      // (and the faux provider in tests) leave it zero. Recompute from the
      // model's per-token rates so the cost cap sees a real number.
      const computed = calculateCost(deps.llmModel, assistant.usage);
      costDeltaUsd += computed.total;
      contextMessages.push(assistant);
      newMessages.push(assistant);
      finalAssistantMessage = assistant;

      if (assistant.stopReason === 'aborted') {
        turnLog.warn({ reason: assistant.stopReason }, 'llm_call_failed');
        return {
          costDeltaUsd,
          replies: [
            {
              kind: 'text',
              text: 'That took too long — try again in a moment.',
            },
          ],
          turnToPersist: newMessages,
        };
      }
      if (assistant.stopReason === 'error') {
        turnLog.error(
          { err: assistant.errorMessage, reason: assistant.stopReason },
          'llm_call_failed',
        );
        return {
          costDeltaUsd,
          replies: [
            {
              kind: 'text',
              text: 'Something went wrong talking to the model — try again in a moment?',
            },
          ],
          turnToPersist: newMessages,
        };
      }

      const toolCalls = extractToolCalls(assistant);
      if (toolCalls.length === 0) {
        break;
      }

      // Enforce the safety cap BEFORE executing the next batch of tools:
      // round starts at 0 and increments per LLM call, so `round` equals the
      // number of assistant messages received so far once we're here. If we've
      // already issued maxToolRounds calls and the model is still asking for
      // more, stop.
      if (round >= maxToolRounds) {
        capHit = true;
        break;
      }

      for (const call of toolCalls) {
        const result = await dispatcher.dispatch(call, {
          signal: input.abortSignal,
          telegramUserId: input.telegramUserId,
        });
        updateHistory(history, result);
        const toolResultMessage = buildToolResultMessage(
          call,
          result,
          input.now,
        );
        contextMessages.push(toolResultMessage);
        newMessages.push(toolResultMessage);
      }
    }

    if (capHit) {
      turnLog.warn({ rounds: maxToolRounds }, 'llm_tool_round_cap_hit');
      return {
        costDeltaUsd,
        replies: [
          {
            kind: 'text',
            text: 'I got stuck thinking — try rephrasing?',
          },
        ],
        turnToPersist: newMessages,
      };
    }

    const assistantText =
      finalAssistantMessage === null
        ? ''
        : extractAssistantText(finalAssistantMessage);

    return {
      costDeltaUsd,
      replies: buildFinalReplies(assistantText, history),
      turnToPersist: newMessages,
    };
  };
}
