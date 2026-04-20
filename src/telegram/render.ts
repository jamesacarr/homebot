import type { Reply } from '../llm/orchestrator.js';

/**
 * Telegram MarkdownV2 rules (from the Bot API docs):
 *
 * - Outside formatting, these characters must be backslash-escaped when they
 *   appear as literal text (any of them will otherwise be treated as syntax):
 *     _ * [ ] ( ) ~ ` > # + - = | { } . !
 * - Inside `...` (inline code / pre) only `\` and `` ` `` need escaping.
 * - Inside *...* (bold) all the other reserved chars still need escaping; the
 *   surrounding `*` markers themselves are the formatting and are NOT escaped.
 *
 * We only support the formatting markers the bot's LLM actually emits: bold
 * (`*...*`) and inline code (`` `...` ``). Italic (`_..._`) and links are not
 * produced by the prompt and are not recognised here — lone `_` and `[` will
 * be escaped as literal text, which is the correct fail-safe.
 */

const RESERVED = new Set<string>([
  '_',
  '*',
  '[',
  ']',
  '(',
  ')',
  '~',
  '`',
  '>',
  '#',
  '+',
  '-',
  '=',
  '|',
  '{',
  '}',
  '.',
  '!',
]);

function findClose(text: string, marker: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    // Markers do not span newlines per MarkdownV2's single-line-run grammar.
    if (ch === '\n') {
      return -1;
    }
    if (ch === marker) {
      return i;
    }
  }
  return -1;
}

function escapeInsideBold(inner: string): string {
  // Every reserved char except `*` (which is the marker) gets escaped.
  let out = '';
  for (const ch of inner) {
    out += RESERVED.has(ch) && ch !== '*' ? `\\${ch}` : ch;
  }
  return out;
}

function escapeInsideCode(inner: string): string {
  // Only ` and \ are meaningful inside an inline-code run.
  let out = '';
  for (const ch of inner) {
    out += ch === '`' || ch === '\\' ? `\\${ch}` : ch;
  }
  return out;
}

/**
 * Escape `text` for Telegram MarkdownV2 while preserving the two formatting
 * runs the LLM emits: `*bold*` and `` `code` ``. Unmatched markers are
 * escaped as literal characters.
 */
/**
 * Minimal surface of the Telegram Bot API we call from the render layer.
 * Narrowing the adapter to this interface keeps `render.ts` grammY-agnostic
 * and unit-testable.
 */
export interface TelegramOutboundApi {
  sendMessage(
    chatId: number,
    text: string,
    options?: {
      parseMode?: 'MarkdownV2';
      replyMarkup?: InlineKeyboardMarkup;
    },
  ): Promise<void>;
  sendPhoto(
    chatId: number,
    photoUrl: string,
    options?: {
      caption?: string;
      parseMode?: 'MarkdownV2';
    },
  ): Promise<void>;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/**
 * Send each `Reply` in order. If any send rejects, the promise rejects and
 * the caller is expected NOT to persist the turn (plan.md). Sends are
 * sequential on purpose — Telegram respects message ordering when calls are
 * awaited; parallel `send*` calls would arrive in arbitrary order.
 */
export async function renderReplies(
  api: TelegramOutboundApi,
  chatId: number,
  replies: Reply[],
): Promise<void> {
  for (const reply of replies) {
    if (reply.kind === 'text') {
      await api.sendMessage(chatId, escapeMarkdownV2(reply.text), {
        parseMode: 'MarkdownV2',
      });
      continue;
    }
    if (reply.kind === 'photo') {
      // A photo with an empty caption is a valid use case (the bare poster
      // that follows a confirmation text). Don't set parse_mode in that
      // case — empty MarkdownV2 is still valid but skipping keeps the call
      // cheaper and less surprising in logs.
      if (reply.caption.length === 0) {
        await api.sendPhoto(chatId, reply.posterUrl);
      } else {
        await api.sendPhoto(chatId, reply.posterUrl, {
          caption: escapeMarkdownV2(reply.caption),
          parseMode: 'MarkdownV2',
        });
      }
      continue;
    }
    // keyboard
    const inline_keyboard = [
      reply.buttons.map(b => ({ callback_data: b.data, text: b.label })),
    ];
    await api.sendMessage(chatId, escapeMarkdownV2(reply.text), {
      parseMode: 'MarkdownV2',
      replyMarkup: { inline_keyboard },
    });
  }
}

export function escapeMarkdownV2(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) {
      break;
    }
    if (ch === '*' || ch === '`') {
      const close = findClose(text, ch, i + 1);
      if (close !== -1 && close > i + 1) {
        // Non-empty balanced run on one line — emit it as a formatting run.
        const inner = text.slice(i + 1, close);
        out +=
          ch +
          (ch === '`' ? escapeInsideCode(inner) : escapeInsideBold(inner)) +
          ch;
        i = close + 1;
        continue;
      }
      // Unmatched or empty marker — treat as literal.
      out += `\\${ch}`;
      i++;
      continue;
    }
    out += RESERVED.has(ch) ? `\\${ch}` : ch;
    i++;
  }
  return out;
}
