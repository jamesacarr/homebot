import type { Context } from 'grammy';
import { Bot } from 'grammy';

import {
  decodeCallbackData,
  encodeRequestAccessCallback,
} from '../callbacks.js';
import { createUserLock } from '../concurrency.js';
import type { AppDb } from '../db/index.js';
import { findUser } from '../db/users.js';
import type { Orchestrator } from '../llm/orchestrator.js';
import type { ToolDispatcher } from '../llm/tools.js';
import type { Logger } from '../logging.js';
import type { OverseerrClient } from '../overseerr/client.js';
import { allowCallback } from './access.js';
import type { AccessAdapter } from './access-callbacks.js';
import {
  handleAccessDecision,
  handleAccessRequest,
} from './access-callbacks.js';
import { asTelegramOutboundApi } from './adapter.js';
import { renderReplies } from './render.js';
import { runTextTurn } from './run-text-turn.js';
import { handleSelection } from './selection.js';

export interface CreateBotDeps {
  token: string;
  db: AppDb;
  orchestrate: Orchestrator;
  toolDispatcher: ToolDispatcher;
  /** Currently unused at the bot layer but plumbed for future use. */
  overseerr: OverseerrClient;
  logger: Logger;
  ownerTelegramUserId: number;
  capUsd: number;
  maxTurnsInHistory: number;
  /** Test seam: defaults to `Date.now`. */
  now?: () => number;
}

export function createBot(deps: CreateBotDeps): Bot {
  const bot = new Bot(deps.token);
  const log = deps.logger.child({ module: 'telegram' });
  const now = deps.now ?? ((): number => Date.now());
  // One lock instance per bot. Per-user mutex serialises that user's
  // messages and callbacks against each other; different users run in
  // parallel.
  const userLock = createUserLock();

  // Middleware: 1:1 DMs only. Belt-and-braces against group chats even if
  // BotFather privacy mode is on. We answer once, leave, and stop processing.
  bot.use(async (ctx: Context, next: () => Promise<void>) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
      log.info(
        { chatId: ctx.chat.id, chatType: ctx.chat.type },
        'group_chat_rejected',
      );
      await ctx.reply('I only work in direct messages.');
      try {
        await ctx.leaveChat();
      } catch (error) {
        log.warn({ err: error }, 'leave_chat_failed');
      }
      return;
    }
    await next();
  });

  bot.on('message:text', async ctx => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (userId === undefined || chatId === undefined) {
      return;
    }
    const username = ctx.from?.username ?? null;
    const text = ctx.message.text;

    await userLock.acquire(userId, async () => {
      const result = await runTextTurn({
        capUsd: deps.capUsd,
        db: deps.db,
        incomingText: text,
        logger: log,
        maxTurnsInHistory: deps.maxTurnsInHistory,
        now: now(),
        orchestrate: deps.orchestrate,
        ownerTelegramUserId: deps.ownerTelegramUserId,
        telegramUserId: userId,
        ...(username === null ? {} : { telegramUsername: username }),
      });

      if (result.kind === 'drop_silently') {
        return;
      }
      if (result.kind === 'prompt_for_access') {
        const replies = [
          ...result.replies,
          {
            buttons: [
              {
                data: encodeRequestAccessCallback(),
                label: 'Request access',
              },
            ],
            kind: 'keyboard' as const,
            text: 'Tap to send the request:',
          },
        ];
        try {
          await renderReplies(asTelegramOutboundApi(ctx.api), chatId, replies);
        } catch (error) {
          log.error({ err: error, telegramUserId: userId }, 'render_failed');
        }
        return;
      }

      // kind === 'replies'. Send first; only persist (commit) if every send
      // succeeded — plan.md's preferred ordering. A persist that races ahead
      // of a failed send leaves the LLM's history out of sync with what the
      // user actually saw on their retry.
      try {
        await renderReplies(
          asTelegramOutboundApi(ctx.api),
          chatId,
          result.replies,
        );
      } catch (error) {
        log.error({ err: error, telegramUserId: userId }, 'render_failed');
        return;
      }
      if (result.commit) {
        try {
          await result.commit();
        } catch (error) {
          log.error({ err: error, telegramUserId: userId }, 'persist_failed');
        }
      }
    });
  });

  bot.on('callback_query:data', async ctx => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (fromId === undefined || chatId === undefined) {
      return;
    }
    const decoded = decodeCallbackData(ctx.callbackQuery.data);
    // Always answer the callback query to clear the spinner on the user's
    // end, even if we're going to drop the tap afterwards.
    await ctx.answerCallbackQuery();
    if (decoded === null) {
      return;
    }

    // Access gate: a user we've silently dropped on the text path must not
    // be able to sneak in via a stale button. `access_request` is the one
    // tap unknown users are allowed to make — the handler itself enforces
    // idempotency so re-taps after decision don't re-notify.
    if (decoded.kind !== 'access_request') {
      const userRow = await findUser(deps.db, fromId);
      if (
        !allowCallback({
          ownerTelegramUserId: deps.ownerTelegramUserId,
          senderTelegramUserId: fromId,
          userRow,
        })
      ) {
        log.debug(
          {
            callbackKind: decoded.kind,
            status: userRow?.status,
            telegramUserId: fromId,
          },
          'access_dropped_silently',
        );
        return;
      }
    }

    // Access decisions are special: only the owner is allowed; the handler
    // itself enforces `from === owner`.

    const adapter: AccessAdapter = {
      send: (toId, replies) =>
        renderReplies(asTelegramOutboundApi(ctx.api), toId, replies),
    };

    if (decoded.kind === 'access_request') {
      await handleAccessRequest({
        adapter,
        db: deps.db,
        logger: log,
        now: now(),
        ownerTelegramUserId: deps.ownerTelegramUserId,
        requesterTelegramUserId: fromId,
        requesterUsername: ctx.from?.username ?? null,
      });
      return;
    }

    if (decoded.kind === 'approve' || decoded.kind === 'deny') {
      await handleAccessDecision({
        adapter,
        db: deps.db,
        decision: decoded.kind,
        fromTelegramUserId: fromId,
        logger: log,
        now: now(),
        ownerTelegramUserId: deps.ownerTelegramUserId,
        requesterTelegramUserId: decoded.requesterId,
      });
      return;
    }

    if (decoded.kind === 'pick') {
      await userLock.acquire(fromId, async () => {
        const result = await handleSelection({
          db: deps.db,
          dispatcher: deps.toolDispatcher,
          logger: log,
          maxTurnsInHistory: deps.maxTurnsInHistory,
          now: now(),
          pick: { mediaType: decoded.mediaType, tmdbId: decoded.tmdbId },
          telegramUserId: fromId,
        });
        // Send first; bail without persisting if any send fails — same
        // ordering as runTextTurn's commit contract.
        try {
          await renderReplies(
            asTelegramOutboundApi(ctx.api),
            chatId,
            result.replies,
          );
        } catch (error) {
          log.error({ err: error, telegramUserId: fromId }, 'render_failed');
          return;
        }
        try {
          await result.commit();
        } catch (error) {
          log.error({ err: error, telegramUserId: fromId }, 'persist_failed');
        }
      });
    }
  });

  bot.catch(err => {
    log.error({ err: err.error }, 'unhandled_bot_error');
  });

  return bot;
}
