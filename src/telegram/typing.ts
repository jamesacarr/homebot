import type { Logger } from '../logging.js';

/**
 * Minimal surface the typing helpers need from grammY's `Api`. Narrow on
 * purpose — keeps `typing.ts` easy to fake in unit tests and prevents
 * accidental coupling to other API methods.
 *
 * grammY's `Api['sendChatAction']` accepts `(chat_id: number | string,
 * action: string, ...)` and returns `Promise<true>`, so it satisfies this
 * interface structurally.
 */
export interface TypingApi {
  sendChatAction(chatId: number, action: 'typing'): Promise<unknown>;
}

export interface TypingHeartbeat {
  stop(): void;
}

/**
 * Telegram's typing indicator displays for up to 5 seconds or until the next
 * outbound message. 4s gives a 1s safety buffer against the 5s expiry so the
 * user never sees the indicator flicker off mid-think.
 */
const HEARTBEAT_INTERVAL_MS = 4_000;

/**
 * Post a single "typing..." chat action. Fire-and-forget semantics from the
 * caller's perspective — errors are swallowed and logged at `debug` because
 * the indicator is cosmetic and a failure (user blocked the bot, 429, network
 * blip) must never propagate into the real reply path.
 */
export async function sendTypingOnce(
  api: TypingApi,
  chatId: number,
  logger: Logger,
): Promise<void> {
  try {
    await api.sendChatAction(chatId, 'typing');
  } catch (error) {
    logger.debug({ err: error }, 'typing_action_failed');
  }
}

/**
 * Repeatedly post "typing..." every {@link HEARTBEAT_INTERVAL_MS} until the
 * returned `stop()` is called. Fires once immediately so the indicator
 * appears to the user as soon as possible (e.g. before the first LLM round
 * trip returns).
 *
 * Errors from each ping are swallowed and logged at `debug` — same rationale
 * as `sendTypingOnce`. The heartbeat keeps running after a failed ping; a
 * transient rate-limit shouldn't kill the indicator for the rest of the turn.
 */
export function startTypingHeartbeat(
  api: TypingApi,
  chatId: number,
  logger: Logger,
): TypingHeartbeat {
  const fire = (): void => {
    api.sendChatAction(chatId, 'typing').catch((error: unknown) => {
      logger.debug({ err: error }, 'typing_action_failed');
    });
  };
  fire();
  const timer = setInterval(fire, HEARTBEAT_INTERVAL_MS);
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
