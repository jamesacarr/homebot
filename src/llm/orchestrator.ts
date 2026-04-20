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

import { encodePickCallback } from '../callbacks.js';
import type { ThinkingLevel } from '../config.js';
import type { Logger } from '../logging.js';
import type { OverseerrClient, SearchCandidate } from '../overseerr/client.js';
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
  /**
   * Candidates from the most recent `search_media`, ONLY if that search was
   * the last tool the LLM called this turn. If a later tool call supersedes
   * it (`get_media_details`, `request_media`), this is cleared — the LLM has
   * moved past disambiguation and the picker is no longer the right reply.
   */
  pendingPickerCandidates: SearchCandidate[] | null;
  /** Set when `request_media` returned `status='requested'` in this turn. */
  lastSuccessfulRequest: { tmdbId: number; posterUrl: string | null } | null;
}

function updateHistory(
  history: TurnToolHistory,
  result: ToolDispatchResult,
): void {
  // Any later tool call means the LLM has drilled past picker territory;
  // drop the pending candidates so the reply renderer doesn't render a stale
  // picker alongside the LLM's follow-up text.
  history.pendingPickerCandidates = null;

  if (result.isError) {
    return;
  }
  if (result.name === 'search_media') {
    history.pendingPickerCandidates = result.output.candidates;
    return;
  }
  if (result.name === 'request_media') {
    if (result.output.status === 'requested') {
      history.lastSuccessfulRequest = {
        posterUrl: result.output.posterUrl,
        tmdbId: result.output.tmdbId,
      };
    }
  }
}

type Pickable = SearchCandidate & { posterUrl: string };

function hasPoster(candidate: SearchCandidate): candidate is Pickable {
  return candidate.posterUrl !== null;
}

function buildPickerReplies(
  pickables: Pickable[],
  assistantText: string,
): Reply[] {
  const replies: Reply[] = [];
  if (assistantText.length > 0) {
    replies.push({ kind: 'text', text: assistantText });
  }
  // A candidate's number matches its index in the filtered list, so what the
  // user sees ("Option 2") lines up with what they tap ([2] → pick:<id2>).
  pickables.forEach((candidate, index) => {
    const year = candidate.year ? ` (${candidate.year})` : '';
    const overview =
      candidate.overview === null ? '' : `\n\n${candidate.overview}`;
    replies.push({
      caption: `*Option ${index + 1}:* ${candidate.title}${year}${overview}`,
      kind: 'photo',
      posterUrl: candidate.posterUrl,
    });
  });
  const buttons = pickables.map((c, index) => ({
    data: encodePickCallback({ mediaType: c.mediaType, tmdbId: c.tmdbId }),
    label: String(index + 1),
  }));
  replies.push({ buttons, kind: 'keyboard', text: 'Pick one:' });
  return replies;
}

function buildFinalReplies(
  assistantText: string,
  history: TurnToolHistory,
): Reply[] {
  if (history.lastSuccessfulRequest !== null) {
    const replies: Reply[] = [];
    if (assistantText.length > 0) {
      replies.push({ kind: 'text', text: assistantText });
    }
    const poster = history.lastSuccessfulRequest.posterUrl;
    if (poster !== null) {
      replies.push({ caption: '', kind: 'photo', posterUrl: poster });
    }
    return replies;
  }

  // Disambiguation path: the LLM's LAST tool call was a search_media that
  // returned multiple candidates. Render the picker with whatever subset has
  // posters — candidates without posters are dropped entirely so button
  // numbers never point at invisible titles.
  if (
    history.pendingPickerCandidates !== null &&
    history.pendingPickerCandidates.length > 1
  ) {
    const pickables = history.pendingPickerCandidates.filter(hasPoster);
    if (pickables.length >= 1) {
      return buildPickerReplies(pickables, assistantText);
    }
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
      lastSuccessfulRequest: null,
      pendingPickerCandidates: null,
    };

    let costDeltaUsd = 0;
    let finalAssistantMessage: AssistantMessage | null = null;

    // Shared shortcut for every early-return path so the orchestrator
    // consistently returns `{ replies, turnToPersist, costDeltaUsd }`
    // regardless of which branch bails.
    const apologise = (text: string): OrchestratorOutput => ({
      costDeltaUsd,
      replies: [{ kind: 'text', text }],
      turnToPersist: newMessages,
    });

    // `toolRound` counts how many tool-dispatch rounds have been consumed.
    // The loop alternates LLM call → maybe dispatch tools. The master cap is
    // enforced adjacent to its check: when an assistant message arrives with
    // more tool calls and we've already used `maxToolRounds`, we stop.
    let toolRound = 0;
    for (;;) {
      const context: Context = {
        messages: contextMessages,
        systemPrompt: deps.systemPrompt,
        tools: dispatcher.tools,
      };

      turnLog.info(
        { model: deps.llmModel.id, turnIndex: toolRound },
        'llm_call',
      );

      let assistant: AssistantMessage;
      try {
        assistant = await completeSimple(deps.llmModel, context, {
          ...(reasoning === undefined ? {} : { reasoning }),
          signal: input.abortSignal,
        });
      } catch (error) {
        turnLog.error({ err: error }, 'llm_call_failed');
        return apologise(
          'Something went wrong talking to the model — try again in a moment?',
        );
      }

      // Don't trust `usage.cost.total` from the provider — some providers
      // (and the faux provider in tests) leave it zero. Recompute from the
      // model's per-token rates so the cost cap sees a real number.
      costDeltaUsd += calculateCost(deps.llmModel, assistant.usage).total;
      contextMessages.push(assistant);
      newMessages.push(assistant);
      finalAssistantMessage = assistant;

      if (assistant.stopReason === 'aborted') {
        turnLog.warn({ reason: assistant.stopReason }, 'llm_call_failed');
        return apologise('That took too long — try again in a moment.');
      }
      if (assistant.stopReason === 'error') {
        turnLog.error(
          { err: assistant.errorMessage, reason: assistant.stopReason },
          'llm_call_failed',
        );
        return apologise(
          'Something went wrong talking to the model — try again in a moment?',
        );
      }

      const toolCalls = extractToolCalls(assistant);
      if (toolCalls.length === 0) {
        break;
      }
      if (toolRound >= maxToolRounds) {
        turnLog.warn({ rounds: maxToolRounds }, 'llm_tool_round_cap_hit');
        return apologise('I got stuck thinking — try rephrasing?');
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
      toolRound++;
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
