import { useCallback, useEffect, useState } from 'react';
import type { Chat } from '@teamsuzie/chats';

export type { Chat };

interface UseAssistantChatsResult {
  chats: Chat[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** `personaId` is opaque (string), null = explicit "no persona", undefined = leave unset. */
  create: (init?: { name?: string; personaId?: string | null }) => Promise<Chat>;
  remove: (chatId: string) => Promise<void>;
  update: (chatId: string, patch: { name?: string; personaId?: string | null }) => Promise<Chat>;
}

export function useAssistantChats(): UseAssistantChatsResult {
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/assistant/chats', { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load chats (${res.status})`);
      const data = (await res.json()) as { items: Chat[] };
      setChats(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chats');
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(
    async (init?: { name?: string; personaId?: string | null }): Promise<Chat> => {
      const body: Record<string, unknown> = {};
      if (init?.name) body.name = init.name;
      // Forward null explicitly so the server records "no persona" rather
      // than leaving the column unset.
      if (init && 'personaId' in init) body.personaId = init.personaId;
      const res = await fetch('/api/assistant/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${res.status})`);
      }
      const data = (await res.json()) as { item: Chat };
      setChats((c) => [data.item, ...c]);
      return data.item;
    },
    [],
  );

  const update = useCallback(
    async (
      chatId: string,
      patch: { name?: string; personaId?: string | null },
    ): Promise<Chat> => {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if ('personaId' in patch) body.personaId = patch.personaId;
      const res = await fetch(
        `/api/assistant/chats/${encodeURIComponent(chatId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${res.status})`);
      }
      const data = (await res.json()) as { item: Chat };
      setChats((c) => c.map((x) => (x.id === chatId ? data.item : x)));
      return data.item;
    },
    [],
  );

  const remove = useCallback(async (chatId: string): Promise<void> => {
    const res = await fetch(
      `/api/assistant/chats/${encodeURIComponent(chatId)}`,
      { method: 'DELETE', credentials: 'include' },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed (${res.status})`);
    }
    setChats((c) => c.filter((x) => x.id !== chatId));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { chats, loading, error, refresh, create, remove, update };
}
