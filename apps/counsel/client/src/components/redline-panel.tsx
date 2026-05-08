import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, LoadingState, cn } from '@teamsuzie/ui';
import type {
  FocusCardEventDetail,
  FocusRevisionEventDetail,
} from './tracked-changes-panel.js';

/**
 * Inline redline preview rendered as a side-panel tab. Fetches
 * `/api/files/:sessionId/:fileId/redline-view` (server-side OOXML walk
 * via `extractRedlineParagraphs`) and renders one paragraph per
 * main-document `<w:p>`, including table-cell paragraphs, with each run
 * as either equal text, an `<ins>` span (emerald), or a `<del>` span
 * (struck-through destructive). Each ins/del span carries
 * `data-revision-id` so the chat-side cards and this panel can sync via
 * window CustomEvents:
 *   - inline span click → `redline:focus-card { key: chatId:revisionId }`
 *   - external (`redline:focus-revision`) → scroll to first matching span
 *
 * On `redline:refresh` (fired after an accept/reject mutates the file)
 * the panel re-fetches its paragraphs.
 */

interface RedlineRun {
  kind: 'equal' | 'ins' | 'del';
  text: string;
  revisionId?: number;
}

interface RedlineParagraph {
  index: number;
  runs: RedlineRun[];
}

interface ApiResponse {
  paragraphs: RedlineParagraph[];
}

interface RedlineRefreshDetail {
  sessionId: string;
  fileId: string;
  paragraphs?: RedlineParagraph[];
}

export function RedlinePanelContent({
  sessionId,
  fileId,
  fileName,
  chatId,
  revisionCardKeys,
}: {
  sessionId: string;
  fileId: string;
  fileName: string;
  chatId: string;
  revisionCardKeys?: Record<number, string>;
}) {
  const [paragraphs, setParagraphs] = useState<RedlineParagraph[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Pending revision-id focus that came in before the paragraphs loaded.
  const pendingFocusRef = useRef<number | null>(null);

  const fetchParagraphs = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(
          `/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileId)}/redline-view`,
          { credentials: 'include', signal, cache: 'no-store' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ApiResponse;
        setParagraphs(data.paragraphs);
        setError(null);
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load preview');
      }
    },
    [sessionId, fileId],
  );

  useEffect(() => {
    const ac = new AbortController();
    void fetchParagraphs(ac.signal);
    return () => ac.abort();
  }, [fetchParagraphs]);

  // Listen for refresh (after an accept/reject) and external focus events.
  useEffect(() => {
    function onRefresh(ev: Event) {
      const ce = ev as CustomEvent<RedlineRefreshDetail>;
      if (ce.detail?.sessionId !== sessionId || ce.detail?.fileId !== fileId) return;
      if (ce.detail.paragraphs) {
        setParagraphs(ce.detail.paragraphs);
        setError(null);
        return;
      }
      void fetchParagraphs();
    }
    function onFocusRevision(ev: Event) {
      const ce = ev as CustomEvent<FocusRevisionEventDetail>;
      const rid = ce.detail?.revisionId;
      if (rid === undefined) return;
      if (!paragraphs) {
        pendingFocusRef.current = rid;
        return;
      }
      focusRevision(rid);
    }
    window.addEventListener('redline:refresh', onRefresh as EventListener);
    window.addEventListener(
      'redline:focus-revision',
      onFocusRevision as EventListener,
    );
    return () => {
      window.removeEventListener('redline:refresh', onRefresh as EventListener);
      window.removeEventListener(
        'redline:focus-revision',
        onFocusRevision as EventListener,
      );
    };
  }, [sessionId, fileId, fetchParagraphs, paragraphs]);

  // Once paragraphs land, fire any pending focus.
  useEffect(() => {
    if (!paragraphs) return;
    const rid = pendingFocusRef.current;
    if (rid === null) return;
    pendingFocusRef.current = null;
    // Defer so the DOM has painted.
    window.requestAnimationFrame(() => focusRevision(rid));
  }, [paragraphs]);

  function focusRevision(revisionId: number) {
    const root = containerRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(
      `[data-revision-id="${revisionId}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('redline-flash');
    window.setTimeout(() => target.classList.remove('redline-flash'), 1200);
  }

  function handleSpanClick(revisionId: number) {
    const key = revisionCardKeys?.[revisionId] ?? `${chatId}:${revisionId}`;
    window.dispatchEvent(
      new CustomEvent<FocusCardEventDetail>('redline:focus-card', {
        detail: { key },
      }),
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold tracking-tight">
            {fileName}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Inline tracked changes — click an edit to find its card
          </div>
        </div>
        <a
          href={`/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileId)}/content`}
          download
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-accent/40"
          title="Download the .docx with native Word tracked changes"
        >
          <Download className="size-3.5" aria-hidden />
          Download
        </a>
      </div>
      <div
        ref={containerRef}
        className="flex-1 space-y-3 overflow-y-auto p-4 text-sm leading-relaxed"
      >
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        {!paragraphs && !error && (
          <LoadingState>Loading redline…</LoadingState>
        )}
        {paragraphs && paragraphs.length === 0 && (
          <p className="text-sm text-muted-foreground">No paragraphs in document.</p>
        )}
        {paragraphs?.map((para) => (
          <p
            key={para.index}
            className="whitespace-pre-wrap"
            data-paragraph-index={para.index}
          >
            {para.runs.length === 0 ? (
              <span className="text-muted-foreground">·</span>
            ) : (
              para.runs.map((run, i) => (
                <RedlineSpan
                  key={i}
                  run={run}
                  onClick={
                    run.revisionId !== undefined
                      ? () => handleSpanClick(run.revisionId!)
                      : undefined
                  }
                />
              ))
            )}
          </p>
        ))}
      </div>
    </div>
  );
}

function RedlineSpan({
  run,
  onClick,
}: {
  run: RedlineRun;
  onClick?: () => void;
}) {
  if (run.kind === 'equal') {
    return <span>{run.text}</span>;
  }
  return (
    <span
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      data-revision-id={run.revisionId}
      className={cn(
        'rounded-sm px-0.5 transition-colors',
        run.kind === 'del' &&
          'bg-destructive/15 text-destructive line-through decoration-destructive/60',
        run.kind === 'ins' &&
          'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        onClick && 'cursor-pointer hover:ring-1 hover:ring-amber-400/60',
      )}
    >
      {run.text}
    </span>
  );
}
