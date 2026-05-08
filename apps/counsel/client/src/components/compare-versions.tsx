import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Download,
  EmptyState,
  EmptyStateDescription,
  EmptyStateTitle,
  GitCompareArrows,
  PendingButton,
  cn,
} from '@teamsuzie/ui';
import type { MatterDocument } from '../hooks/use-matter.js';

interface WordDiffOp {
  kind: 'equal' | 'insert' | 'delete';
  text: string;
}

export type ParagraphDiffEvent =
  | {
      kind: 'unchanged';
      leftIndex: number;
      rightIndex: number;
      text: string;
    }
  | {
      kind: 'modified';
      leftIndex: number;
      rightIndex: number;
      leftText: string;
      rightText: string;
      ops: WordDiffOp[];
      similarity: number;
      moved: boolean;
    }
  | { kind: 'deleted'; leftIndex: number; text: string }
  | { kind: 'inserted'; rightIndex: number; text: string };

export interface DocumentDiffResult {
  left: { name: string; paragraphs: number };
  right: { name: string; paragraphs: number };
  stats: {
    unchanged: number;
    modified: number;
    deleted: number;
    inserted: number;
    moved: number;
  };
  events: ParagraphDiffEvent[];
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documents: MatterDocument[];
  onSubmit: (input: { leftFileId: string; rightFileId: string }) => Promise<void>;
}

/**
 * Two-doc picker for the matter-detail "Compare versions" surface.
 * The matter's own documents are the only eligible candidates; the user
 * picks one for the left (before) side and a different one for the right
 * (after) side. Submit hits POST /api/matters/:matterId/diff and the host
 * opens the result in a side-panel tab.
 */
export function CompareVersionsDialog({
  open,
  onOpenChange,
  documents,
  onSubmit,
}: DialogProps) {
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLeftId(null);
    setRightId(null);
    setError(null);
    setSubmitting(false);
  }, [open]);

  const ordered = useMemo(
    () =>
      [...documents].sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      ),
    [documents],
  );

  const canSubmit =
    !submitting && leftId !== null && rightId !== null && leftId !== rightId;

  async function handleSubmit() {
    if (!canSubmit || !leftId || !rightId) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ leftFileId: leftId, rightFileId: rightId });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compare failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Compare versions</DialogTitle>
          <DialogDescription>
            Pick two documents from this matter. The diff highlights
            inserted, deleted, and modified paragraphs side-by-side.
          </DialogDescription>
        </DialogHeader>
        {ordered.length < 2 ? (
          <EmptyState>
            <EmptyStateTitle>Not enough documents</EmptyStateTitle>
            <EmptyStateDescription>
              Upload at least two documents to this matter before comparing.
            </EmptyStateDescription>
          </EmptyState>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <DocColumn
              title="Left (before)"
              ordered={ordered}
              selectedId={leftId}
              onSelect={setLeftId}
              disabledId={rightId}
            />
            <DocColumn
              title="Right (after)"
              ordered={ordered}
              selectedId={rightId}
              onSelect={setRightId}
              disabledId={leftId}
            />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <PendingButton
            onClick={handleSubmit}
            disabled={!canSubmit}
            pending={submitting}
            pendingLabel="Comparing"
          >
            <GitCompareArrows className="size-4" aria-hidden />
            Compare
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DocColumn({
  title,
  ordered,
  selectedId,
  onSelect,
  disabledId,
}: {
  title: string;
  ordered: MatterDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabledId: string | null;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border bg-card">
        {ordered.map((doc) => {
          const isSelected = doc.externalDocId === selectedId;
          const isDisabled = doc.externalDocId === disabledId;
          return (
            <li key={doc.externalDocId}>
              <button
                type="button"
                onClick={() => onSelect(doc.externalDocId)}
                disabled={isDisabled}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                  isSelected
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-accent/40',
                  isDisabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
                )}
              >
                <span className="truncate">{doc.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Side-panel rendering of a finished diff. Modified paragraphs render with
 * inline word-level ins/del runs; deletions render as a struck-through
 * block; insertions render as a bordered green block. Unchanged paragraphs
 * are summarised by count, not rendered, since legal redlines need to
 * focus on what's different — the rest is noise.
 *
 * When `matterId` + `leftFileId` + `rightFileId` are passed, a
 * "Download tracked-change DOCX" link in the header points at the
 * `/api/matters/:id/diff/download` endpoint.
 */
export function DiffPanel({
  result,
  matterId,
  leftFileId,
  rightFileId,
}: {
  result: DocumentDiffResult;
  matterId?: string;
  leftFileId?: string;
  rightFileId?: string;
}) {
  const stats = formatStatsLine(result);
  const visible = result.events.filter((e) => e.kind !== 'unchanged');
  const downloadHref =
    matterId && leftFileId && rightFileId
      ? `/api/matters/${encodeURIComponent(matterId)}/diff/download?leftFileId=${encodeURIComponent(leftFileId)}&rightFileId=${encodeURIComponent(rightFileId)}`
      : null;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold tracking-tight">
              {result.left.name} → {result.right.name}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{stats}</div>
          </div>
          {downloadHref && (
            <a
              href={downloadHref}
              download
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-accent/40"
              title="Download a tracked-change .docx Word can accept-all"
            >
              <Download className="size-3.5" aria-hidden />
              Download DOCX
            </a>
          )}
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
        {visible.length === 0 ? (
          <p className="text-muted-foreground">
            The two documents are identical (after paragraph-level alignment).
          </p>
        ) : (
          visible.map((event, idx) => <DiffEventBlock key={idx} event={event} />)
        )}
        {result.stats.unchanged > 0 && visible.length > 0 && (
          <p className="pt-2 text-xs text-muted-foreground">
            {result.stats.unchanged} paragraph
            {result.stats.unchanged === 1 ? '' : 's'} unchanged.
          </p>
        )}
      </div>
    </div>
  );
}

function formatStatsLine(result: DocumentDiffResult): string {
  const { unchanged, modified, deleted, inserted, moved } = result.stats;
  const parts: string[] = [];
  if (modified) parts.push(`${modified} modified`);
  if (deleted) parts.push(`${deleted} deleted`);
  if (inserted) parts.push(`${inserted} inserted`);
  if (moved) parts.push(`${moved} moved`);
  parts.push(`${unchanged} unchanged`);
  return parts.join(' · ');
}

function DiffEventBlock({ event }: { event: ParagraphDiffEvent }) {
  if (event.kind === 'modified') {
    const tag = event.moved ? 'modified · moved' : 'modified';
    return (
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-1 text-xs text-muted-foreground">
          ¶{event.leftIndex + 1} → ¶{event.rightIndex + 1} ·{' '}
          {Math.round(event.similarity * 100)}% match · {tag}
        </div>
        <p className="whitespace-pre-wrap leading-relaxed">
          {event.ops.map((op, i) => (
            <span
              key={i}
              className={cn(
                op.kind === 'delete' &&
                  'rounded-sm bg-destructive/15 text-destructive line-through decoration-destructive/60',
                op.kind === 'insert' &&
                  'rounded-sm bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
              )}
            >
              {op.text}
            </span>
          ))}
        </p>
      </div>
    );
  }
  if (event.kind === 'deleted') {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <div className="mb-1 text-xs text-muted-foreground">
          ¶{event.leftIndex + 1} of left · deleted
        </div>
        <p className="whitespace-pre-wrap leading-relaxed text-destructive line-through decoration-destructive/60">
          {event.text}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
      <div className="mb-1 text-xs text-muted-foreground">
        ¶{event.rightIndex + 1} of right · inserted
      </div>
      <p className="whitespace-pre-wrap leading-relaxed text-emerald-700 dark:text-emerald-300">
        {event.text}
      </p>
    </div>
  );
}
