import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  EmptyStateDescription,
  EmptyStateTitle,
  LoadingState,
  PendingButton,
  RefreshCw,
  useConfirm,
} from '@teamsuzie/ui';
import {
  useWorkflowVersions,
  type WorkflowVersion,
} from '../hooks/use-workflow-versions.js';
import type { Workflow } from '../hooks/use-workflows.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow: Workflow | null;
  /**
   * Called after a successful restore so the parent can refresh its
   * local workflow state. The argument is the post-restore Workflow.
   */
  onRestored?: (next: Workflow) => void;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function summarise(version: WorkflowVersion, prev: WorkflowVersion | null): string[] {
  // What changed *into* this version, relative to the prior captured state.
  // The list is captured pre-edit, so version[i] is the state before edit i;
  // version[i+1] (older) is the state before edit i-1. So "what changed into
  // version[i]" is the diff between version[i+1] and version[i].
  if (!prev) return ['Initial captured state'];
  const out: string[] = [];
  if (prev.name !== version.name) out.push('Name');
  if (prev.description !== version.description) out.push('Description');
  if (prev.prompt !== version.prompt) out.push('Prompt');
  if (
    JSON.stringify(prev.practiceAreas) !== JSON.stringify(version.practiceAreas)
  ) {
    out.push('Practice areas');
  }
  if (
    JSON.stringify(prev.columnConfig) !== JSON.stringify(version.columnConfig)
  ) {
    out.push('Columns');
  }
  if (prev.outputMode !== version.outputMode) out.push('Output mode');
  return out.length > 0 ? out : ['No fields changed'];
}

/**
 * Browse a user-owned workflow's edit history; restore a prior version.
 * The list is newest-first; each row shows the captured state's name,
 * the timestamp, the reason (update vs restore), and a per-row Restore
 * action behind a confirm. Mounted via a "History" RowAction in the
 * library page.
 */
export function WorkflowHistoryDialog({
  open,
  onOpenChange,
  workflow,
  onRestored,
}: Props) {
  const { versions, loading, error, restore } = useWorkflowVersions(
    workflow?.id ?? null,
    open,
  );
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);

  async function handleRestore(version: WorkflowVersion) {
    const ok = await confirm({
      title: `Restore "${version.name}"?`,
      description:
        'The current state will be saved as a new history entry first, so you can undo the restore. This replaces the live workflow.',
      confirmLabel: 'Restore version',
    });
    if (!ok) return;
    setBusy(version.id);
    try {
      const next = await restore(version.id);
      onRestored?.(next);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            History — {workflow?.name ?? 'Workflow'}
          </DialogTitle>
          <DialogDescription>
            Every edit captures the prior state. Restore a version to roll back —
            the act of restoring is itself a new entry, so you can undo it.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {loading ? (
          <LoadingState>Loading history…</LoadingState>
        ) : versions.length === 0 ? (
          <EmptyState>
            <EmptyStateTitle>No edits yet</EmptyStateTitle>
            <EmptyStateDescription>
              History entries appear here after the first edit.
            </EmptyStateDescription>
          </EmptyState>
        ) : (
          <ul className="max-h-[60vh] divide-y overflow-y-auto rounded-md border">
            {versions.map((v, i) => {
              const prev = versions[i + 1] ?? null;
              const changed = summarise(v, prev);
              return (
                <li key={v.id} className="flex items-start gap-3 px-3 py-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate text-sm font-medium">{v.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatTimestamp(v.capturedAt)}
                      {v.capturedBy && (
                        <>
                          {' · '}
                          <span>{v.capturedBy}</span>
                        </>
                      )}
                      {' · '}
                      <span className="capitalize">{v.reason}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Changed: {changed.join(', ')}
                    </p>
                  </div>
                  <PendingButton
                    type="button"
                    variant="outline"
                    size="sm"
                    pending={busy === v.id}
                    pendingLabel="Restoring"
                    onClick={() => void handleRestore(v)}
                  >
                    <RefreshCw className="size-4" aria-hidden />
                    Restore
                  </PendingButton>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
