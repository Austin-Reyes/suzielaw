import { useCallback, useEffect, useState } from 'react';

export interface KbDocument {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  chunkCount: number;
  ownerId: string | null;
  createdAt: number;
}

export interface KbStats {
  documents: number;
  chunks: number;
}

export interface KbSearchHit {
  chunk: {
    id: number;
    documentId: string;
    chunkIndex: number;
    content: string;
    startChar: number;
    endChar: number;
  };
  document: KbDocument;
  distance: number;
}

interface UseKnowledgeBase {
  documents: KbDocument[];
  stats: KbStats;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  upload: (file: File) => Promise<void>;
  remove: (id: string) => Promise<void>;
  search: (query: string, topK?: number) => Promise<KbSearchHit[]>;
}

/**
 * Drives the Knowledge Base page. Calls /api/kb/{documents,search} and keeps
 * a local cache of the document list + stats. The KB is server-scoped to
 * the logged-in user via the session cookie.
 */
export function useKnowledgeBase(): UseKnowledgeBase {
  const [documents, setDocuments] = useState<KbDocument[]>([]);
  const [stats, setStats] = useState<KbStats>({ documents: 0, chunks: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/kb/documents', { credentials: 'include' });
      if (!response.ok) throw new Error(`Failed to load (${response.status})`);
      const data = (await response.json()) as { documents: KbDocument[]; stats: KbStats };
      setDocuments(data.documents);
      setStats(data.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge base');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = useCallback(
    async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/kb/documents', {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Upload failed (${response.status})`);
      }
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      const response = await fetch(`/api/kb/documents/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Delete failed (${response.status})`);
      }
      await refresh();
    },
    [refresh],
  );

  const search = useCallback(async (query: string, topK = 5): Promise<KbSearchHit[]> => {
    const response = await fetch('/api/kb/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query, top_k: topK }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Search failed (${response.status})`);
    }
    const data = (await response.json()) as { hits: KbSearchHit[] };
    return data.hits;
  }, []);

  return { documents, stats, loading, error, refresh, upload, remove, search };
}
