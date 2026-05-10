import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { ChatsStore } from '../src/store.js';
import { startChatsTestEnv, type ChatsTestEnv } from './setup.js';

describe('@counsel/chats — ChatsStore', () => {
  let env: ChatsTestEnv;
  let store: ChatsStore;

  beforeAll(async () => {
    env = await startChatsTestEnv();
    store = new ChatsStore({ db: env.kysely });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('creates a chat with default name', async () => {
    const chat = await store.createChat({ workspaceId: 'ws-1' });
    expect(chat.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(chat.name).toBe('New chat');
    expect(chat.personaId).toBeNull();
  });

  it('creates with custom name + persona id (whitespace trimmed)', async () => {
    const chat = await store.createChat({
      workspaceId: 'ws-1',
      name: '  Cortez intake  ',
      personaId: 'pi-pre-litigation',
    });
    expect(chat.name).toBe('Cortez intake');
    expect(chat.personaId).toBe('pi-pre-litigation');
  });

  it('lists by workspace, newest-touched first', async () => {
    const a = await store.createChat({ workspaceId: 'ws-2', name: 'A' });
    await new Promise((r) => setTimeout(r, 10));
    const b = await store.createChat({ workspaceId: 'ws-2', name: 'B' });

    let list = await store.listChats('ws-2');
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);

    // Touch A so it climbs back to top.
    await new Promise((r) => setTimeout(r, 10));
    await store.touchChat(a.id);
    list = await store.listChats('ws-2');
    expect(list.map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it('updates with tri-state personaId semantics', async () => {
    const chat = await store.createChat({
      workspaceId: 'ws-3',
      personaId: 'p1',
    });

    // Patch without personaId key — leave alone.
    const u1 = await store.updateChat(chat.id, { name: 'New name' });
    expect(u1?.personaId).toBe('p1');

    // Patch with personaId: null — clear.
    const u2 = await store.updateChat(chat.id, { personaId: null });
    expect(u2?.personaId).toBeNull();

    // Patch with personaId: 'p2' — switch.
    const u3 = await store.updateChat(chat.id, { personaId: 'p2' });
    expect(u3?.personaId).toBe('p2');
  });

  it('appendMessage stores JSONB tool_events + citations and bumps chat.updated_at', async () => {
    const chat = await store.createChat({ workspaceId: 'ws-4' });
    const beforeUpdated = chat.updatedAt;

    await new Promise((r) => setTimeout(r, 10));

    const msg = await store.appendMessage({
      chatId: chat.id,
      role: 'user',
      content: 'What does Texas §18.001 require?',
    });
    expect(msg.role).toBe('user');
    expect(msg.toolEvents).toBeNull();
    expect(msg.citations).toBeNull();

    const reply = await store.appendMessage({
      chatId: chat.id,
      role: 'assistant',
      content: 'It requires a billing affidavit ...',
      toolEvents: [{ tool: 'search', query: '18.001' }],
      citations: [{ doc: 'TX-CPRC-18.001', span: [0, 100] }],
    });
    expect(reply.role).toBe('assistant');
    expect(Array.isArray(reply.toolEvents)).toBe(true);
    expect((reply.toolEvents as Array<{ tool: string }>)[0]?.tool).toBe('search');
    expect(Array.isArray(reply.citations)).toBe(true);

    const updated = await store.getChat(chat.id);
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(beforeUpdated.getTime());
  });

  it('lists messages in append order', async () => {
    const chat = await store.createChat({ workspaceId: 'ws-5' });
    await store.appendMessage({ chatId: chat.id, role: 'user', content: 'one' });
    await store.appendMessage({ chatId: chat.id, role: 'assistant', content: 'two' });
    await store.appendMessage({ chatId: chat.id, role: 'user', content: 'three' });
    const list = await store.listMessages(chat.id);
    expect(list.map((m) => m.content)).toEqual(['one', 'two', 'three']);
  });

  it('clearMessages soft-deletes — count returned + reads exclude', async () => {
    const chat = await store.createChat({ workspaceId: 'ws-6' });
    await store.appendMessage({ chatId: chat.id, role: 'user', content: '1' });
    await store.appendMessage({ chatId: chat.id, role: 'assistant', content: '2' });
    expect((await store.listMessages(chat.id)).length).toBe(2);

    const cleared = await store.clearMessages(chat.id);
    expect(cleared).toBe(2);
    expect((await store.listMessages(chat.id)).length).toBe(0);

    // The rows still exist in the table (audit), just hidden.
    const raw = await env.kysely
      .selectFrom('chat_messages')
      .selectAll()
      .where('chat_id', '=', chat.id)
      .execute();
    expect(raw.length).toBe(2);
    expect(raw.every((r) => r.deleted_at !== null)).toBe(true);
  });

  it('soft-deleteChat hides from list/get; messages CASCADE-stay (chat is gone but rows kept)', async () => {
    const chat = await store.createChat({ workspaceId: 'ws-7' });
    await store.appendMessage({ chatId: chat.id, role: 'user', content: 'hi' });

    expect(await store.deleteChat(chat.id)).toBe(true);
    expect(await store.getChat(chat.id)).toBeNull();
    expect((await store.listChats('ws-7')).length).toBe(0);

    expect(await store.deleteChat(chat.id)).toBe(false);
  });

  it('hard delete on chats table CASCADEs to chat_messages', async () => {
    const chat = await store.createChat({ workspaceId: 'ws-8' });
    await store.appendMessage({ chatId: chat.id, role: 'user', content: 'a' });

    await env.kysely.deleteFrom('chats').where('id', '=', chat.id).execute();

    const msgs = await env.kysely
      .selectFrom('chat_messages')
      .selectAll()
      .where('chat_id', '=', chat.id)
      .execute();
    expect(msgs).toEqual([]);
  });

  it('CHECK constraint rejects invalid roles', async () => {
    const chat = await store.createChat({ workspaceId: 'ws-9' });
    await expect(
      sql`INSERT INTO chat_messages (id, chat_id, role, content) VALUES ('m', ${chat.id}, 'system', 'x')`.execute(
        env.kysely,
      ),
    ).rejects.toThrow(/ck_chat_messages_role|check constraint/i);
  });
});
