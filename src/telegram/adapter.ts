import type { Api } from 'grammy';

import type { TelegramOutboundApi } from './render.js';

/**
 * Adapt a grammY `Api` instance to the narrowed `TelegramOutboundApi` the
 * render layer expects. Keeping the conversion here means `render.ts` stays
 * grammY-free and unit-testable; this file is the only place that imports
 * grammY's API surface for outbound calls.
 */
export function asTelegramOutboundApi(api: Api): TelegramOutboundApi {
  return {
    async sendMessage(chatId, text, options) {
      const args: Parameters<Api['sendMessage']>[2] = {};
      if (options?.parseMode !== undefined) {
        args.parse_mode = options.parseMode;
      }
      if (options?.replyMarkup !== undefined) {
        args.reply_markup = options.replyMarkup;
      }
      await api.sendMessage(chatId, text, args);
    },
    async sendPhoto(chatId, photoUrl, options) {
      const args: Parameters<Api['sendPhoto']>[2] = {};
      if (options?.caption !== undefined) {
        args.caption = options.caption;
      }
      if (options?.parseMode !== undefined) {
        args.parse_mode = options.parseMode;
      }
      await api.sendPhoto(chatId, photoUrl, args);
    },
  };
}
