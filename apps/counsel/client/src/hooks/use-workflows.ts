import { useCallback, useEffect, useState } from 'react';

export type WorkflowSource = 'system' | 'user';

export type WorkflowOutputMode =
  | 'inline_chat'
  | 'generate_docx'
  | 'tabular_review';

export interface WorkflowColumnConfig {
  title: string;
  prompt: string;
  format: string;
}

export interface Workflow {
  id: string;
  source: WorkflowSource;
  ownerId: string | null;
  name: string;
  description: string;
  prompt: string;
  practiceAreas: string[];
  /**
   * Optional review template. When non-null, this workflow can be
   * launched as a review against a matter's documents — one column
   * per entry.
   */
  columnConfig: WorkflowColumnConfig[] | null;
  /** Output mode the runtime uses to route this workflow. */
  outputMode: WorkflowOutputMode;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  prompt: string;
  practiceAreas?: string[];
  columnConfig?: WorkflowColumnConfig[] | null;
  outputMode?: WorkflowOutputMode;
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  prompt?: string;
  practiceAreas?: string[];
  columnConfig?: WorkflowColumnConfig[] | null;
  outputMode?: WorkflowOutputMode;
}

interface UseWorkflowsResult {
  workflows: Workflow[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (input: CreateWorkflowInput) => Promise<Workflow>;
  update: (id: string, patch: UpdateWorkflowInput) => Promise<Workflow>;
  remove: (id: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
  unarchive: (id: string) => Promise<void>;
  hide: (id: string) => Promise<void>;
  unhide: (id: string) => Promise<void>;
}

/**
 * Reads + writes the user's visible workflows from `/api/workflows`.
 * Server-side this returns system workflows minus any the user has
 * hidden plus any user-owned rows; archives are excluded by default.
 *
 * Mutations refresh the list inline (not optimistic — the visibility
 * filter is server-side, so we wait for the server's view of truth
 * after each operation).
 */
export function useWorkflows(): UseWorkflowsResult {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/workflows', { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load workflows (${res.status})`);
      const data = (await res.json()) as { items: Workflow[] };
      setWorkflows(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(async (input: CreateWorkflowInput): Promise<Workflow> => {
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Failed (${res.status})`);
    }
    const data = (await res.json()) as { item: Workflow };
    setWorkflows((current) => [data.item, ...current]);
    return data.item;
  }, []);

  const update = useCallback(
    async (id: string, patch: UpdateWorkflowInput): Promise<Workflow> => {
      const res = await fetch(`/api/workflows/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${res.status})`);
      }
      const data = (await res.json()) as { item: Workflow };
      setWorkflows((current) =>
        current.map((w) => (w.id === id ? data.item : w)),
      );
      return data.item;
    },
    [],
  );

  const remove = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`/api/workflows/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed (${res.status})`);
    }
    setWorkflows((current) => current.filter((w) => w.id !== id));
  }, []);

  const action = useCallback(
    async (id: string, path: string) => {
      const res = await fetch(
        `/api/workflows/${encodeURIComponent(id)}/${path}`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`Failed (${res.status})`);
      }
      await refresh();
    },
    [refresh],
  );

  const archive = useCallback((id: string) => action(id, 'archive'), [action]);
  const unarchive = useCallback((id: string) => action(id, 'unarchive'), [action]);
  const hide = useCallback((id: string) => action(id, 'hide'), [action]);
  const unhide = useCallback((id: string) => action(id, 'unhide'), [action]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    workflows,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    archive,
    unarchive,
    hide,
    unhide,
  };
}
