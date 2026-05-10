import type { ColumnType, Generated } from 'kysely';

export type ChatMessageRole = 'user' | 'assistant';

export interface Chat {
  id: string;
  workspaceId: string;
  name: string;
  /** Opaque persona id active when this chat was created. The chats package never resolves it. */
  personaId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: ChatMessageRole;
  content: string;
  /** Decoded JSON. Null when no tools were used. Surface change vs upstream:
   *  was `string | null` (raw JSON); now structured. */
  toolEvents: unknown[] | null;
  /** Decoded JSON Citation array. Null when none. */
  citations: unknown[] | null;
  createdAt: Date;
}

export interface CreateChatInput {
  workspaceId: string;
  /** Defaults to "New chat". */
  name?: string;
  /** Opaque persona id; null/undefined = default assistant. */
  personaId?: string | null;
}

export interface UpdateChatInput {
  name?: string;
  /** Tri-state: undefined = leave, null = clear, string = switch. */
  personaId?: string | null;
}

export interface AppendMessageInput {
  chatId: string;
  role: ChatMessageRole;
  content: string;
  toolEvents?: unknown[] | null;
  citations?: unknown[] | null;
}

// Kysely table types.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface ChatsTable {
  id: string;
  workspace_id: string;
  name: string;
  persona_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Timestamp | null;
}

export interface ChatMessagesTable {
  id: string;
  chat_id: string;
  role: ChatMessageRole;
  content: string;
  // Insert/update accept a JSON string (we stringify before sending) — pg
  // would otherwise serialize a JS array as a Postgres text[], not jsonb.
  // Read shape is the parsed JS value.
  tool_events: ColumnType<unknown[] | null, string | null, string | null>;
  citations: ColumnType<unknown[] | null, string | null, string | null>;
  created_at: Generated<Date>;
  deleted_at: Timestamp | null;
}

export interface ChatsDB {
  chats: ChatsTable;
  chat_messages: ChatMessagesTable;
}
