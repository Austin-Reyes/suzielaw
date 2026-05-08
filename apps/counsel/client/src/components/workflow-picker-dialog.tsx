import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  EmptyStateDescription,
  EmptyStateTitle,
  Input,
  LoadingState,
  cn,
} from '@teamsuzie/ui';
import { practiceAreaLabel } from '../data/practice-areas.js';
import { useWorkflows, type Workflow } from '../hooks/use-workflows.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fired when the user picks a workflow. The host updates the chat
   * input with `workflow.prompt`, surfaces a label chip with
   * `workflow.name`, and stashes `workflow.id` to send on the next
   * /api/chat turn so the runtime can route by `output_mode`.
   */
  onSelect: (workflow: Workflow) => void;
}

const OUTPUT_MODE_BADGE: Record<Workflow['outputMode'], { label: string; className: string }> = {
  inline_chat: { label: 'Chat', className: 'bg-muted text-muted-foreground' },
  generate_docx: {
    label: 'Word doc',
    className: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  },
  tabular_review: {
    label: 'Review',
    className: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  },
};

/**
 * Pick a workflow from inside an existing chat (assistant, matter chat,
 * review chat). Free-form prompt workflows + generate_docx workflows
 * are eligible; tabular_review workflows are filtered out — those
 * launch via the matter detail page's "From workflow" button into a
 * review grid, not into a chat. (Running a tabular workflow from a chat
 * has no useful semantics: chats don't render columns.)
 *
 * Mirrors what the library page's "click card → land in assistant"
 * navigation flow already does — sets the workflow's prompt as the
 * chat input and stashes the workflow id so the next chat turn carries
 * `workflowId` and the server can route by `output_mode`.
 */
export function WorkflowPickerDialog({ open, onOpenChange, onSelect }: Props) {
  const wf = useWorkflows();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset and focus the search whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      // Defer focus to next tick so Radix's auto-focus on the dialog
      // doesn't race with ours.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  const eligible = useMemo(
    () => wf.workflows.filter((w) => w.outputMode !== 'tabular_review'),
    [wf.workflows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter((w) => {
      const haystack = `${w.name}\n${w.description}\n${w.practiceAreas.join(' ')}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [eligible, query]);

  function handlePick(workflow: Workflow) {
    onSelect(workflow);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run a workflow</DialogTitle>
          <DialogDescription>
            Pick a workflow to fill in the chat input. The next message you send carries the workflow's mandated output shape.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workflows by name, description, practice area"
            aria-label="Search workflows"
          />

          {wf.loading ? (
            <LoadingState>Loading workflows…</LoadingState>
          ) : filtered.length === 0 ? (
            <EmptyState>
              <EmptyStateTitle>
                {eligible.length === 0
                  ? 'No workflows in your library'
                  : 'No workflows match'}
              </EmptyStateTitle>
              <EmptyStateDescription>
                {eligible.length === 0
                  ? 'Create one from the Library page to get started.'
                  : 'Try a different search term.'}
              </EmptyStateDescription>
            </EmptyState>
          ) : (
            <ul className="max-h-[420px] overflow-y-auto rounded-md border border-border">
              {filtered.map((w) => {
                const badge = OUTPUT_MODE_BADGE[w.outputMode];
                return (
                  <li key={w.id}>
                    <button
                      type="button"
                      onClick={() => handlePick(w)}
                      className={cn(
                        'flex w-full flex-col gap-1 border-b border-border px-3 py-2.5 text-left text-sm last:border-b-0',
                        'hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">{w.name}</span>
                        <span
                          className={cn(
                            'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                            badge.className,
                          )}
                        >
                          {badge.label}
                        </span>
                      </div>
                      {w.description && (
                        <p className="text-xs text-muted-foreground">{w.description}</p>
                      )}
                      {w.practiceAreas.length > 0 && (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {w.practiceAreas.map((id) => (
                            <span
                              key={id}
                              className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            >
                              {practiceAreaLabel(id)}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

