import type { AppDb } from './index.js';

/**
 * The opaque pi-ai Context-shaped message array. Treated as untyped JSON at
 * the DB layer; the orchestrator owns the pi-ai types.
 */
export type TurnMessages = readonly unknown[];

/**
 * messages_json column wrapper. Versioned so that a future pi-ai shape change
 * can be detected on load (unrecognised versions are silently dropped so stale
 * rows don't crash the bot).
 */
const SCHEMA_VERSION = 1;

interface TurnEnvelope {
  v: number;
  messages: unknown[];
}

function parseEnvelope(raw: string): TurnEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'v' in parsed &&
      'messages' in parsed &&
      Array.isArray((parsed as { messages: unknown }).messages)
    ) {
      return parsed as TurnEnvelope;
    }
  } catch {
    // Malformed JSON — treat as unreadable, drop below.
  }
  return null;
}

export interface RecordTurnInput {
  telegramUserId: number;
  messages: TurnMessages;
  now: number;
  maxTurns: number;
}

export async function recordTurn(
  db: AppDb,
  input: RecordTurnInput,
): Promise<void> {
  const envelope: TurnEnvelope = {
    messages: [...input.messages],
    v: SCHEMA_VERSION,
  };

  await db.transaction().execute(async trx => {
    await trx
      .insertInto('conversationTurns')
      .values({
        createdAt: input.now,
        messagesJson: JSON.stringify(envelope),
        telegramUserId: input.telegramUserId,
      })
      .execute();

    // Trim: delete all but the most recent `maxTurns` rows for this user.
    await trx
      .deleteFrom('conversationTurns')
      .where('telegramUserId', '=', input.telegramUserId)
      .where('id', 'not in', qb =>
        qb
          .selectFrom('conversationTurns')
          .select('id')
          .where('telegramUserId', '=', input.telegramUserId)
          .orderBy('createdAt', 'desc')
          .limit(input.maxTurns),
      )
      .execute();
  });
}

export async function loadRecentTurnMessages(
  db: AppDb,
  telegramUserId: number,
  maxTurns: number,
): Promise<unknown[]> {
  const rows = await db
    .selectFrom('conversationTurns')
    .select('messagesJson')
    .where('telegramUserId', '=', telegramUserId)
    .orderBy('createdAt', 'desc')
    .limit(maxTurns)
    .execute();

  // Reverse to chronological order (oldest first), parse each row's envelope,
  // filter to current schema version, flatten into one message list.
  const out: unknown[] = [];
  for (const row of rows.reverse()) {
    const envelope = parseEnvelope(row.messagesJson);
    if (envelope?.v === SCHEMA_VERSION) {
      out.push(...envelope.messages);
    }
  }
  return out;
}
