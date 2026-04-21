import { describe, expect, it } from 'vitest';

import type { Reply } from '../../src/llm/orchestrator.js';
import type { TelegramOutboundApi } from '../../src/telegram/render.js';
import { escapeMarkdownV2, renderReplies } from '../../src/telegram/render.js';

interface RecordedSend {
  kind: 'text' | 'photo' | 'keyboard';
  chatId: number;
  text?: string;
  photoUrl?: string;
  caption?: string;
  parseMode?: string;
  buttons?: { text: string; callback_data: string }[];
}

function makeFakeApi(): { api: TelegramOutboundApi; sent: RecordedSend[] } {
  const sent: RecordedSend[] = [];
  const api: TelegramOutboundApi = {
    sendMessage(chatId, text, options) {
      const record: RecordedSend = {
        chatId,
        kind: options?.replyMarkup ? 'keyboard' : 'text',
        text,
      };
      if (options?.parseMode !== undefined) {
        record.parseMode = options.parseMode;
      }
      if (options?.replyMarkup !== undefined) {
        record.buttons = options.replyMarkup.inline_keyboard[0] ?? [];
      }
      sent.push(record);
      return Promise.resolve();
    },
    sendPhoto(chatId, photoUrl, options) {
      const record: RecordedSend = {
        chatId,
        kind: 'photo',
        photoUrl,
      };
      if (options?.caption !== undefined) {
        record.caption = options.caption;
      }
      if (options?.parseMode !== undefined) {
        record.parseMode = options.parseMode;
      }
      sent.push(record);
      return Promise.resolve();
    },
  };
  return { api, sent };
}

describe('escapeMarkdownV2', () => {
  it('escapes MarkdownV2 special characters in plain text', () => {
    // Every character in the special set must be backslash-escaped.
    const input = 'Hello (world).';
    expect(escapeMarkdownV2(input)).toBe('Hello \\(world\\)\\.');
  });

  it('preserves *bold* markers and escapes special chars inside the run', () => {
    const input = '*The Batman (2022)*';
    expect(escapeMarkdownV2(input)).toBe('*The Batman \\(2022\\)*');
  });

  it('preserves `code` markers and only escapes ` and \\ inside the run', () => {
    const input = 'status is `AVAILABLE`';
    // . after the code run must still be escaped in the surrounding text.
    expect(escapeMarkdownV2(`${input}.`)).toBe('status is `AVAILABLE`\\.');
  });

  it('escapes unmatched * as literal text', () => {
    // "unmatched" shouldn't start a formatting run.
    const input = 'a * b';
    expect(escapeMarkdownV2(input)).toBe('a \\* b');
  });

  it('handles a mix of bold, code and plain text end-to-end', () => {
    const input = 'Requested *The Batman (2022)*. Status: `PENDING`.';
    expect(escapeMarkdownV2(input)).toBe(
      'Requested *The Batman \\(2022\\)*\\. Status: `PENDING`\\.',
    );
  });

  it('escapes all 18 MarkdownV2 reserved characters when they are not formatting markers', () => {
    // _ * [ ] ( ) ~ ` > # + - = | { } . !
    // '*' and '`' are markers when paired — as loose chars they are escaped.
    const loose = '_[]()~>#+-=|{}.!';
    const expected = loose.replace(/./g, c => `\\${c}`);
    expect(escapeMarkdownV2(loose)).toBe(expected);
  });

  it('treats a newline as the end of a formatting run (markers do not span newlines)', () => {
    // `*foo\nbar*` is not a valid MarkdownV2 bold run. Each `*` is a lone
    // special char and must be escaped.
    const input = '*foo\nbar*';
    expect(escapeMarkdownV2(input)).toBe('\\*foo\nbar\\*');
  });

  it('leaves the empty string unchanged', () => {
    expect(escapeMarkdownV2('')).toBe('');
  });
});

describe('renderReplies', () => {
  const CHAT_ID = 42;

  it('sends a text reply via sendMessage with MarkdownV2 parse_mode and escapes specials', async () => {
    const { api, sent } = makeFakeApi();
    const replies: Reply[] = [
      { kind: 'text', text: 'Requested *The Batman (2022)*. ✓' },
    ];

    await renderReplies(api, CHAT_ID, replies);

    expect(sent).toEqual([
      {
        chatId: CHAT_ID,
        kind: 'text',
        parseMode: 'MarkdownV2',
        text: 'Requested *The Batman \\(2022\\)*\\. ✓',
      },
    ]);
  });

  it('sends a photo reply via sendPhoto with the escaped caption', async () => {
    const { api, sent } = makeFakeApi();
    const replies: Reply[] = [
      {
        caption: '*Option 1:* The Batman (2022)',
        kind: 'photo',
        posterUrl: 'https://image.tmdb.org/t/p/w342/bat.jpg',
      },
    ];

    await renderReplies(api, CHAT_ID, replies);

    expect(sent).toEqual([
      {
        caption: '*Option 1:* The Batman \\(2022\\)',
        chatId: CHAT_ID,
        kind: 'photo',
        parseMode: 'MarkdownV2',
        photoUrl: 'https://image.tmdb.org/t/p/w342/bat.jpg',
      },
    ]);
  });

  it('omits parse_mode when a photo caption is empty so Telegram does not error on empty formatting', async () => {
    const { api, sent } = makeFakeApi();
    const replies: Reply[] = [
      {
        caption: '',
        kind: 'photo',
        posterUrl: 'https://image.tmdb.org/t/p/w342/bat.jpg',
      },
    ];

    await renderReplies(api, CHAT_ID, replies);

    expect(sent[0]?.caption).toBeUndefined();
    expect(sent[0]?.parseMode).toBeUndefined();
  });

  it('renders a keyboard reply as sendMessage with a single-row inline keyboard', async () => {
    const { api, sent } = makeFakeApi();
    const replies: Reply[] = [
      {
        buttons: [
          { data: 'pick:414906:movie', label: '1' },
          { data: 'pick:272:movie', label: '2' },
        ],
        kind: 'keyboard',
        text: 'Pick one:',
      },
    ];

    await renderReplies(api, CHAT_ID, replies);

    expect(sent).toEqual([
      {
        buttons: [
          { callback_data: 'pick:414906:movie', text: '1' },
          { callback_data: 'pick:272:movie', text: '2' },
        ],
        chatId: CHAT_ID,
        kind: 'keyboard',
        parseMode: 'MarkdownV2',
        text: 'Pick one:',
      },
    ]);
  });

  it('sends replies in the order they appear', async () => {
    const { api, sent } = makeFakeApi();
    const replies: Reply[] = [
      { kind: 'text', text: 'first' },
      {
        caption: 'second',
        kind: 'photo',
        posterUrl: 'https://example/p.jpg',
      },
      { kind: 'text', text: 'third' },
    ];

    await renderReplies(api, CHAT_ID, replies);

    expect(sent.map(s => s.kind)).toEqual(['text', 'photo', 'text']);
    expect(sent[0]?.text).toBe('first');
    expect(sent[2]?.text).toBe('third');
  });

  it('propagates a send failure so the caller can skip turn persistence', async () => {
    // If any send fails, the turn is NOT persisted. Our contract
    // with the caller is "throw on first failure".
    const boom = new Error('network down');
    const api: TelegramOutboundApi = {
      sendMessage: () => Promise.reject(boom),
      sendPhoto: () => Promise.resolve(),
    };

    await expect(
      renderReplies(api, CHAT_ID, [{ kind: 'text', text: 'hi' }]),
    ).rejects.toBe(boom);
  });

  it('stops sending on first failure so subsequent replies are not emitted', async () => {
    let photoCalls = 0;
    const api: TelegramOutboundApi = {
      sendMessage: () => Promise.reject(new Error('fail')),
      sendPhoto: () => {
        photoCalls++;
        return Promise.resolve();
      },
    };

    await expect(
      renderReplies(api, CHAT_ID, [
        { kind: 'text', text: 'fails first' },
        { caption: '', kind: 'photo', posterUrl: 'https://example/p.jpg' },
      ]),
    ).rejects.toThrow(/fail/);

    expect(photoCalls).toBe(0);
  });
});
