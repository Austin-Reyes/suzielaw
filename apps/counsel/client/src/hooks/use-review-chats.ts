import { useCallback, useEffect, useState } from 'react';
import type { Chat } from '@teamsuzie/chats';

export type { Chat };

interface UseReviewChatsResult {
  chats: Chat[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (name?: string) => Promise<Chat>;
  remove: (chatId: string) => Promise<void>;
}

/**
 * List + create + delete chats scoped to a review. Mirrors
 * `useMatterChats` but talks to the review-scoped chats router at
 * `/api/matters/:matterId/reviews/:reviewId/chats` — server-side these
 * rows live in the same `chats` table, namespaced by a `review:<id>`
 * workspace_id prefix.
 */
export function useReviewChats(
  matterId: string | undefined,
  reviewId: string | undefined,
): UseReviewChatsResult {
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const baseUrl =
    matterId && reviewId
      ? `/api/matters/${encodeURIComponent(matterId)}/reviews/${encodeURIComponent(reviewId)}/chats`
      : null;

  const refresh = useCallback(async () => {
    if (!baseUrl) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(baseUrl, { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load chats (${res.status})`);
      const data = (await res.json()) as { items: Chat[] };
      setChats(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chats');
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  const create = useCallback(
    async (name?: string): Promise<Chat> => {
      if (!baseUrl) throw new Error('No matter/review id');
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(name ? { name } : {}),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${res.status})`);
      }
      const data = (await res.json()) as { item: Chat };
      setChats((c) => [data.item, ...c]);
      return data.item;
    },
    [baseUrl],
  );

  const remove = useCallback(
    async (chatId: string): Promise<void> => {
      if (!baseUrl) return;
      const res = await fetch(`${baseUrl}/${encodeURIComponent(chatId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Failed (${res.status})`);
      }
      setChats((c) => c.filter((x) => x.id !== chatId));
    },
    [baseUrl],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { chats, loading, error, refresh, create, remove };
}
