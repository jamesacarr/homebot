import type {
  AssistantMessage,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@mariozechner/pi-ai';

import { recordTurn } from '../db/conversations.js';
import type { AppDb } from '../db/index.js';
import type { Reply } from '../llm/orchestrator.js';
import type { ToolDispatcher } from '../llm/tools.js';
import type { Logger } from '../logging.js';
import type { OverseerrMediaType } from '../overseerr/client.js';

export interface SelectionInput {
  pick: { tmdbId: number; mediaType: OverseerrMediaType };
  telegramUserId: number;
  now: number;
  dispatcher: ToolDispatcher;
  logger: Logger;
  db: AppDb;
  maxTurnsInHistory: number;
}

export interface SelectionOutput {
  replies: Reply[];
  /**
   * Persistence callback — the caller invokes it only after sends succeed.
   * Matches the contract `runTextTurn` uses so `bot.ts` can treat both
   * flows identically: send, then commit on success.
   *
   * The persisted turn has four messages:
   *   user("Selected ...") → assistant(toolCall request_media)
   *     → toolResult(...) → assistant(text confirmation).
   * The synthetic user message gives the LLM a recognisable marker; the
   * trailing assistant text closes the request/result pair so the next user
   * message starts cleanly.
   */
  commit: () => Promise<void>;
}

const FAUX_API = 'homebot-selection';
const FAUX_PROVIDER = 'homebot';
const FAUX_MODEL_ID = 'selection-callback';

const ZERO_USAGE = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
};

/**
 * Synthesise the assistant + tool messages a real LLM call would have
 * produced, so the persisted turn is shape-compatible with the orchestrator's
 * own output. Lets a follow-up user message be served by the orchestrator
 * with no special-cased history handling.
 */
function syntheticToolCall(
  pick: SelectionInput['pick'],
  now: number,
): { assistant: AssistantMessage; toolCall: ToolCall } {
  const toolCall: ToolCall = {
    arguments: { mediaType: pick.mediaType, tmdbId: pick.tmdbId },
    id: `selection_cb_${pick.tmdbId}`,
    name: 'request_media',
    type: 'toolCall',
  };
  const assistant: AssistantMessage = {
    api: FAUX_API,
    content: [toolCall],
    model: FAUX_MODEL_ID,
    provider: FAUX_PROVIDER,
    role: 'assistant',
    stopReason: 'toolUse',
    timestamp: now,
    usage: ZERO_USAGE,
  };
  return { assistant, toolCall };
}

function syntheticConfirmation(text: string, now: number): AssistantMessage {
  const content: TextContent[] = [{ text, type: 'text' }];
  return {
    api: FAUX_API,
    content,
    model: FAUX_MODEL_ID,
    provider: FAUX_PROVIDER,
    role: 'assistant',
    stopReason: 'stop',
    timestamp: now,
    usage: ZERO_USAGE,
  };
}

function userSelectionMessage(
  pick: SelectionInput['pick'],
  now: number,
): UserMessage {
  // Phrasing is parseable by humans reading the DB and gives the LLM a clear
  // marker on follow-up turns. tmdbId is included so the LLM can re-call
  // tools without re-searching.
  return {
    content: `[Selected via picker: ${pick.mediaType} tmdbId=${pick.tmdbId}]`,
    role: 'user',
    timestamp: now,
  };
}

export async function handleSelection(
  input: SelectionInput,
): Promise<SelectionOutput> {
  const { assistant, toolCall } = syntheticToolCall(input.pick, input.now);
  const dispatchResult = await input.dispatcher.dispatch(toolCall, {
    telegramUserId: input.telegramUserId,
  });

  const toolResult: ToolResultMessage = {
    content: [{ text: dispatchResult.text, type: 'text' }],
    isError: dispatchResult.isError,
    role: 'toolResult',
    timestamp: input.now,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  };

  const userMsg = userSelectionMessage(input.pick, input.now);

  // Build the user-facing replies + the assistant text we synthesise to
  // close the turn out cleanly.
  let assistantText: string;
  let replies: Reply[];

  if (dispatchResult.isError || dispatchResult.name !== 'request_media') {
    assistantText =
      "I couldn't request that one — try again in a moment, or pick a different option.";
    input.logger.warn(
      {
        err:
          dispatchResult.isError === true
            ? dispatchResult.message
            : 'unexpected dispatch result',
        telegramUserId: input.telegramUserId,
        tmdbId: input.pick.tmdbId,
      },
      'tool_error',
    );
    replies = [{ kind: 'text', text: assistantText }];
  } else {
    const out = dispatchResult.output;
    const titleWithYear = out.year ? `${out.title} (${out.year})` : out.title;
    if (out.status === 'requested') {
      assistantText = `Requested *${titleWithYear}*. \u2713`;
      const r: Reply[] = [{ kind: 'text', text: assistantText }];
      if (out.posterUrl !== null) {
        r.push({ caption: '', kind: 'photo', posterUrl: out.posterUrl });
      }
      replies = r;
    } else if (out.status === 'already_available') {
      assistantText = `*${titleWithYear}* is already available on the server.`;
      replies = [{ kind: 'text', text: assistantText }];
    } else {
      // already_requested
      assistantText = `*${titleWithYear}* has already been requested \u2014 it's on its way.`;
      replies = [{ kind: 'text', text: assistantText }];
    }
  }

  const confirmation = syntheticConfirmation(assistantText, input.now);
  const turnToPersist = [userMsg, assistant, toolResult, confirmation];

  const commit = async (): Promise<void> => {
    await recordTurn(input.db, {
      maxTurns: input.maxTurnsInHistory,
      messages: turnToPersist,
      now: input.now,
      telegramUserId: input.telegramUserId,
    });
  };

  return { commit, replies };
}
