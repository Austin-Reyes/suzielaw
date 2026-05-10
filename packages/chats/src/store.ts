import { Kysely, sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type {
  AppendMessageInput,
  Chat,
  ChatMessage,
  ChatMessageRole,
  ChatsDB,
  CreateChatInput,
  UpdateChatInput,
} from './types.js';

export interface ChatsStoreOptions<TDB extends ChatsDB> {
  db: Kysely<TDB>;
  idFactory?: () => string;
}

export class ChatsStore<TDB extends ChatsDB = ChatsDB> {
  private readonly db: Kysely<TDB>;
  private readonly newId: () => string;

  constructor(opts: ChatsStoreOptions<TDB>) {
    this.db = opts.db;
    this.newId = opts.idFactory ?? uuidv7;
  }

  // --- Chat -------------------------------------------------------------

  async createChat(input: CreateChatInput): Promise<Chat> {
    const id = this.newId();
    const name = input.name?.trim() || 'New chat';
    await this.kbDb()
      .insertInto('chats')
      .values({
        id,
        workspace_id: input.workspaceId,
        name,
        persona_id: input.personaId ?? null,
      })
      .execute();
    return (await this.getChat(id))!;
  }

  async getChat(id: string): Promise<Chat | null> {
    const row = await this.kbDb()
      .selectFrom('chats')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? rowToChat(row) : null;
  }

  async listChats(workspaceId: string): Promise<Chat[]> {
    const rows = await this.kbDb()
      .selectFrom('chats')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('deleted_at', 'is', null)
      .orderBy('updated_at', 'desc')
      .execute();
    return rows.map(rowToChat);
  }

  async updateChat(id: string, patch: UpdateChatInput): Promise<Chat | null> {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (trimmed.length > 0) set.name = trimmed;
    }
    // Tri-state: only stamp persona_id if the key is present in the patch.
    if ('personaId' in patch) set.persona_id = patch.personaId ?? null;

    if (Object.keys(set).length === 0) return this.getChat(id);

    const result = await this.kbDb()
      .updateTable('chats')
      .set(set)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return null;
    return this.getChat(id);
  }

  /** Bump updated_at without changing other fields. */
  async touchChat(id: string): Promise<void> {
    await this.kbDb()
      .updateTable('chats')
      .set({ updated_at: sql`now()` })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .execute();
  }

  /** Soft-delete the chat. Messages remain in place — query joins exclude
   *  rows whose chat is soft-deleted because we filter by chat existence. */
  async deleteChat(id: string): Promise<boolean> {
    const result = await this.kbDb()
      .updateTable('chats')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  // --- Messages ---------------------------------------------------------

  async appendMessage(input: AppendMessageInput): Promise<ChatMessage> {
    const id = this.newId();
    // pg's auto-serialization sends JS arrays as Postgres text[] (the array
    // type), not as jsonb. For jsonb columns we have to JSON.stringify
    // first so pg sends it as a string and PG parses it back into jsonb.
    // Object values would auto-serialize but we want both array AND null,
    // so be explicit on both branches.
    const toolEvents = input.toolEvents == null ? null : JSON.stringify(input.toolEvents);
    const citations = input.citations == null ? null : JSON.stringify(input.citations);
    await this.kbDb()
      .insertInto('chat_messages')
      .values({
        id,
        chat_id: input.chatId,
        role: input.role,
        content: input.content,
        tool_events: toolEvents,
        citations: citations,
      })
      .execute();
    // Bump chat.updated_at so the chats list reorders. Done inline rather
    // than as a trigger to keep the touch optional (clearMessages doesn't
    // bump — that's a deliberate "you cleared, no need to surface").
    await this.touchChat(input.chatId);
    return (await this.getMessage(id))!;
  }

  async getMessage(id: string): Promise<ChatMessage | null> {
    const row = await this.kbDb()
      .selectFrom('chat_messages')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? rowToMessage(row) : null;
  }

  async listMessages(chatId: string): Promise<ChatMessage[]> {
    const rows = await this.kbDb()
      .selectFrom('chat_messages')
      .selectAll()
      .where('chat_id', '=', chatId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(rowToMessage);
  }

  /** Soft-delete every message in a chat. Returns the count cleared. */
  async clearMessages(chatId: string): Promise<number> {
    const result = await this.kbDb()
      .updateTable('chat_messages')
      .set({ deleted_at: new Date() })
      .where('chat_id', '=', chatId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }

  private kbDb(): Kysely<ChatsDB> {
    return this.db as unknown as Kysely<ChatsDB>;
  }
}

interface ChatRow {
  id: string;
  workspace_id: string;
  name: string;
  persona_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  tool_events: unknown[] | null;
  citations: unknown[] | null;
  created_at: Date;
}

function rowToChat(row: ChatRow): Chat {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    personaId: row.persona_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as ChatMessageRole,
    content: row.content,
    toolEvents: row.tool_events,
    citations: row.citations,
    createdAt: row.created_at,
  };
}
