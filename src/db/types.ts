import type { ColumnType, Generated } from 'kysely';

export type UserStatus = 'pending' | 'approved' | 'denied' | 'revoked';

export interface UsersTable {
  telegramUserId: number;
  telegramUsername: string | null;
  status: UserStatus;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: number | null;
  lastRequestAt: number | null;
}

export interface ConversationTurnsTable {
  id: Generated<number>;
  telegramUserId: number;
  messagesJson: string;
  createdAt: number;
}

export interface DailyCostTable {
  dayUtc: string;
  costUsd: ColumnType<number, number | undefined, number>;
}

export interface Database {
  conversationTurns: ConversationTurnsTable;
  dailyCost: DailyCostTable;
  users: UsersTable;
}
