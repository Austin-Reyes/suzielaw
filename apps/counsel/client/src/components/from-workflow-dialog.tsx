import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  EmptyStateDescription,
  EmptyStateTitle,
  LayoutGrid,
  LoadingState,
  PendingButton,
  cn,
} from '@teamsuzie/ui';
import type { MatterDocument } from '../hooks/use-matter.js';
import type { Workflow } from '../hooks/use-workflows.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All workflows visible to the current user. The dialog filters to those with a column config. */
  workflows: Workflow[];
  workflowsLoading: boolean;
  /** Documents in the current matter — eligible review rows. */
  documents: MatterDocument[];
  /**
   * Submit handler. Implementation calls the server's
   * `/api/matters/:matterId/reviews/from-workflow` endpoint and
   * navigates the host to the created review on success.
   */
  onSubmit: (input: {
    workflowId: string;
    externalDocIds: string[];
  }) => Promise<void>;
}

/**
 * Picker that turns a workflow with a column config into a populated
 * review on the current matter. Two columns: workflow on
 * the left, doc list on the right. Default: every doc selected, no
 * workflow chosen yet (user must click one).
 *
 * Filters workflows to the subset with a non-empty `columnConfig` —
 * free-form prompt workflows aren't eligible to be launched as a
 * review and don't show up here.
 */
export function FromWorkflowDialog({
  open,
  onOpenChange,
  workflows,
  workflowsLoading,
  documents,
  onSubmit,
}: Props) {
  const eligible = useMemo(
    () =>
      workflows
        .filter((w) => (w.columnConfig?.length ?? 0) > 0)
        .sort((a, b) => {
          if (a.source !== b.source) return a.source === 'user' ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
    [workflows],
  );

  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state on open. Default doc selection = all matter docs.
  useEffect(() => {
    if (!open) return;
    setSelectedWorkflowId(null);
    setSelectedDocIds(new Set(documents.map((d) => d.externalDocId)));
    setError(null);
    setSubmitting(false);
  }, [open, documents]);

  const selectedWorkflow = eligible.find((w) => w.id === selectedWorkflowId) ?? null;

  function toggleDoc(externalDocId: string) {
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(externalDocId)) next.delete(externalDocId);
      else next.add(externalDocId);
      return next;
    });
  }

  function toggleAll() {
    if (selectedDocIds.size === documents.length) {
      setSelectedDocIds(new Set());
    } else {
      setSelectedDocIds(new Set(documents.map((d) => d.externalDocId)));
    }
  }

  async function submit() {
    if (!selectedWorkflowId) {
      setError('Pick a workflow.');
      return;
    }
    if (selectedDocIds.size === 0) {
      setError('Pick at least one document.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        workflowId: selectedWorkflowId,
        externalDocIds: Array.from(selectedDocIds),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create review');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create review from workflow</DialogTitle>
          <DialogDescription>
            Pick a workflow template and the documents to run it against.
            One row per document, one column per question. Cells start as
            pending — open the review and click "Run pending" to fill them in.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* Workflow picker */}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Workflow
            </div>
            {workflowsLoading ? (
              <LoadingState>Loading workflows…</LoadingState>
            ) : eligible.length === 0 ? (
              <EmptyState>
                <EmptyStateTitle>No review templates available</EmptyStateTitle>
                <EmptyStateDescription>
                  System review templates seed at startup; user workflows can opt in by adding a column config.
                </EmptyStateDescription>
              </EmptyState>
            ) : (
              <ul className="max-h-[40vh] space-y-1 overflow-y-auto rounded-md border border-border bg-card p-1">
                {eligible.map((wf) => {
                  const active = wf.id === selectedWorkflowId;
                  return (
                    <li key={wf.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedWorkflowId(wf.id)}
                        className={cn(
                          'flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors',
                          active
                            ? 'bg-accent text-foreground'
                            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                        )}
                      >
                        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                          <LayoutGrid className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="truncate">{wf.name}</span>
                          <span className="ml-auto text-xs text-muted-foreground">
                            {wf.columnConfig?.length ?? 0} cols
                          </span>
                        </div>
                        {wf.description && (
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            {wf.description}
                          </p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {selectedWorkflow && (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
                <div className="mb-1 font-semibold text-foreground">
                  Columns ({selectedWorkflow.columnConfig?.length ?? 0})
                </div>
                <ul className="space-y-1 text-muted-foreground">
                  {(selectedWorkflow.columnConfig ?? []).map((c) => (
                    <li key={c.title} className="truncate">
                      <span className="text-foreground">{c.title}</span>
                      <span className="ml-2 text-[10px] uppercase tracking-wide">
                        {c.format}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Document picker */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Documents ({selectedDocIds.size}/{documents.length})
              </div>
              {documents.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={toggleAll}
                >
                  {selectedDocIds.size === documents.length ? 'Clear all' : 'Select all'}
                </Button>
              )}
            </div>
            {documents.length === 0 ? (
              <EmptyState>
                <EmptyStateTitle>No documents in this matter</EmptyStateTitle>
                <EmptyStateDescription>
                  Upload documents to the matter first, then come back to launch a workflow against them.
                </EmptyStateDescription>
              </EmptyState>
            ) : (
              <ul className="max-h-[40vh] space-y-0.5 overflow-y-auto rounded-md border border-border bg-card p-1">
                {documents.map((doc) => {
                  const checked = selectedDocIds.has(doc.externalDocId);
                  return (
                    <li key={doc.id}>
                      <label
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors',
                          checked
                            ? 'bg-accent/30 text-foreground'
                            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          onChange={() => toggleDoc(doc.externalDocId)}
                          aria-label={`Include ${doc.name}`}
                        />
                        <span className="flex-1 truncate text-foreground">
                          {doc.name}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={submitting}>
              Cancel
            </Button>
          </DialogClose>
          <PendingButton
            onClick={() => void submit()}
            pending={submitting}
            pendingLabel="Creating"
            disabled={!selectedWorkflowId || selectedDocIds.size === 0}
          >
            Create review
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
