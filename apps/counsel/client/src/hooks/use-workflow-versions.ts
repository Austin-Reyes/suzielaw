import { useCallback, useEffect, useState } from 'react';
import type { Workflow } from './use-workflows.js';
import type { WorkflowOutputMode, WorkflowColumnConfig } from './use-workflows.js';

export type WorkflowVersionReason = 'update' | 'restore';

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  name: string;
  description: string;
  prompt: string;
  practiceAreas: string[];
  columnConfig: WorkflowColumnConfig[] | null;
  outputMode: WorkflowOutputMode;
  capturedAt: number;
  capturedBy: string | null;
  reason: WorkflowVersionReason;
}

interface UseWorkflowVersionsResult {
  versions: WorkflowVersion[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Restore a prior version. Returns the restored Workflow on success. */
  restore: (versionId: string) => Promise<Workflow>;
}

/**
 * Version history for a single user-owned workflow. Loads on dialog
 * open (`enabled=true`) and refreshes automatically after a restore.
 */
export function useWorkflowVersions(
  workflowId: string | null,
  enabled: boolean,
): UseWorkflowVersionsResult {
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workflowId || !enabled) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}/versions`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${res.status})`);
      }
      const data = (await res.json()) as { items: WorkflowVersion[] };
      setVersions(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [workflowId, enabled]);

  const restore = useCallback(
    async (versionId: string): Promise<Workflow> => {
      if (!workflowId) throw new Error('no workflow');
      const res = await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/restore`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${res.status})`);
      }
      const data = (await res.json()) as { item: Workflow };
      // The restore wrote a new snapshot, so refresh to pick it up.
      await refresh();
      return data.item;
    },
    [workflowId, refresh],
  );

  useEffect(() => {
    if (workflowId && enabled) void refresh();
    else {
      setVersions([]);
      setError(null);
    }
  }, [workflowId, enabled, refresh]);

  return { versions, loading, error, refresh, restore };
}
