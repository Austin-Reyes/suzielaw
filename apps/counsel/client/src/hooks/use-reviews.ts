import { useCallback, useEffect, useState } from 'react';
import type {
  Review,
  ReviewSnapshot,
} from '@teamsuzie/grid-review';

export type { Review, ReviewSnapshot };

export interface CreateReviewInput {
  name: string;
  description?: string;
}

interface UseReviewsResult {
  reviews: Review[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (input: CreateReviewInput) => Promise<Review>;
  remove: (id: string) => Promise<void>;
}

/** List + create reviews for a single matter. */
export function useReviews(matterId: string | undefined): UseReviewsResult {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!matterId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/matters/${encodeURIComponent(matterId)}/reviews`,
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error(`Failed to load reviews (${response.status})`);
      const data = (await response.json()) as { items: Review[] };
      setReviews(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reviews');
    } finally {
      setLoading(false);
    }
  }, [matterId]);

  const create = useCallback(
    async (input: CreateReviewInput): Promise<Review> => {
      if (!matterId) throw new Error('No matter id');
      const response = await fetch(
        `/api/matters/${encodeURIComponent(matterId)}/reviews`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${response.status})`);
      }
      const data = (await response.json()) as { item: Review };
      setReviews((current) => [data.item, ...current]);
      return data.item;
    },
    [matterId],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (!matterId) return;
      const response = await fetch(
        `/api/matters/${encodeURIComponent(matterId)}/reviews/${encodeURIComponent(id)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed (${response.status})`);
      }
      setReviews((current) => current.filter((r) => r.id !== id));
    },
    [matterId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { reviews, loading, error, refresh, create, remove };
}
