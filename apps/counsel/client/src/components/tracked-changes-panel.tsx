import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Check,
  ExternalLink,
  Undo2,
  X,
  cn,
  useSidePanel,
} from '@teamsuzie/ui';
import { RedlinePanelContent } from './redline-panel.js';

/**
 * Tracked-changes cards + redline side-panel sync. Renders one
 * `<TrackedChangeCard>` per applied edit returned by
 * `propose_document_edits`. Each card has
 * Accept / Reject buttons backed by an optimistic round-trip to the
 * `/revisions/resolve` endpoint; on failure the card flips back to
 * pending and surfaces the error inline.
 *
 * Cross-component sync uses two `window` CustomEvents:
 *  - `redline:focus-card` { detail: { key } } — fired by inline ins/del
 *    runs in the side panel. Scrolls + ring-flashes the matching card.
 *  - `redline:focus-revision` { detail: { revisionId } } — fired when a
 *    card is clicked. The side panel listens and scrolls to the first
 *    inline run with that revision id.
 *
 * The `key` is `${chatId}:${editIndex}` so multiple panels in different
 * chats coexist without collisions.
 */

export interface AppliedEdit {
  index: number;
  find: string;
  replace: string;
  context_before: string;
  context_after: string;
  reason?: string;
  revision_ids: number[];
  paragraph_index: number;
}

export interface ProposeEditsResult {
  applied_count: number;
  total: number;
  errors: Array<{
    index: number;
    status: string;
    reason?: string;
    find: string;
    replace: string;
    original_reason?: string;
  }>;
  applied_edits?: AppliedEdit[];
  download_url: string;
  download_file_id: string;
  download_session_id: string;
  download_filename: string;
  version_id?: string;
  summary: string;
}

interface ResolveResponse {
  ok: boolean;
  accepted: number[];
  rejected: number[];
  changed: number;
  version_id?: string;
  paragraphs?: Array<{
    index: number;
    runs: Array<{
      kind: 'equal' | 'ins' | 'del';
      text: string;
      revisionId?: number;
    }>;
  }>;
}

type CardStatus = 'pending' | 'accepting' | 'accepted' | 'rejecting' | 'rejected';

interface CardState {
  status: CardStatus;
  error: string | null;
}

export interface FocusCardEventDetail {
  key: string;
}
export interface FocusRevisionEventDetail {
  revisionId: number;
}

export function TrackedChangesPanel({
  result,
  chatId,
}: {
  result: ProposeEditsResult;
  /** Used as a namespace prefix for focus-event keys. */
  chatId: string;
}) {
  const sidePanel = useSidePanel();
  const applied = result.applied_edits ?? [];
  const autoOpenedRef = useRef(false);

  const [cards, setCards] = useState<Record<number, CardState>>(() => {
    const init: Record<number, CardState> = {};
    for (const e of applied) init[e.index] = { status: 'pending', error: null };
    return init;
  });

  const sessionId = result.download_session_id;
  const fileId = result.download_file_id;
  const fileName = result.download_filename;
  const revisionCardKeys = useMemo(() => {
    const out: Record<number, string> = {};
    for (const edit of applied) {
      const key = `${chatId}:${edit.index}`;
      for (const revisionId of edit.revision_ids) out[revisionId] = key;
    }
    return out;
  }, [applied, chatId]);

  const openRedlineTab = useCallback(
    (focusRevisionId?: number) => {
      const tabId = `redline:${sessionId}:${fileId}`;
      sidePanel.openTab({
        id: tabId,
        title: fileName,
        render: () => (
          <RedlinePanelContent
            sessionId={sessionId}
            fileId={fileId}
            fileName={fileName}
            chatId={chatId}
            revisionCardKeys={revisionCardKeys}
          />
        ),
      });
      if (focusRevisionId !== undefined) {
        // Defer the focus event so the panel has time to mount + fetch.
        // The panel re-fires the focus on mount-load too — this is a
        // best-effort second nudge for the "already mounted" path.
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent<FocusRevisionEventDetail>(
              'redline:focus-revision',
              { detail: { revisionId: focusRevisionId } },
            ),
          );
        }, 50);
      }
    },
    [sidePanel, sessionId, fileId, fileName, chatId, revisionCardKeys],
  );

  useEffect(() => {
    if (autoOpenedRef.current || applied.length === 0) return;
    autoOpenedRef.current = true;
    openRedlineTab();
  }, [applied.length, openRedlineTab]);

  async function resolve(
    edit: AppliedEdit,
    action: 'accept' | 'reject',
  ): Promise<void> {
    const prev = cards[edit.index];
    setCards((s) => ({
      ...s,
      [edit.index]: {
        status: action === 'accept' ? 'accepting' : 'rejecting',
        error: null,
      },
    }));
    try {
      const body =
        action === 'accept'
          ? { accept: edit.revision_ids }
          : { reject: edit.revision_ids };
      const res = await fetch(
        `/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileId)}/revisions/resolve`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      const resolved = (await res.json()) as ResolveResponse;
      setCards((s) => ({
        ...s,
        [edit.index]: {
          status: action === 'accept' ? 'accepted' : 'rejected',
          error: null,
        },
      }));
      // Tell any open redline panel to refresh — the saved bytes have changed.
      window.dispatchEvent(
        new CustomEvent('redline:refresh', {
          detail: { sessionId, fileId, paragraphs: resolved.paragraphs },
        }),
      );
    } catch (err) {
      setCards((s) => ({
        ...s,
        [edit.index]: {
          ...prev,
          status: 'pending',
          error: err instanceof Error ? err.message : 'Resolve failed',
        },
      }));
    }
  }

  if (applied.length === 0) {
    // Tool ran but no edits applied (all errors). Surface a summary so
    // the user isn't left wondering — the model usually narrates this
    // anyway, but the cards panel should at least say "nothing to show".
    if (result.errors.length > 0) {
      return (
        <div className="my-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {result.summary}
        </div>
      );
    }
    return null;
  }

  return (
    <div className="my-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {applied.length} proposed edit{applied.length === 1 ? '' : 's'} ·
          accept or reject in-app, or open in Word
        </span>
        <button
          type="button"
          onClick={() => openRedlineTab()}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent/40"
        >
          <ExternalLink className="size-3" aria-hidden />
          View redline
        </button>
      </div>
      {applied.map((edit) => (
        <TrackedChangeCard
          key={edit.index}
          edit={edit}
          state={cards[edit.index] ?? { status: 'pending', error: null }}
          cardKey={`${chatId}:${edit.index}`}
          onAccept={() => void resolve(edit, 'accept')}
          onReject={() => void resolve(edit, 'reject')}
          onView={() => openRedlineTab(edit.revision_ids[0])}
        />
      ))}
    </div>
  );
}

type PreviewOp =
  | { kind: 'equal'; text: string }
  | { kind: 'delete'; text: string }
  | { kind: 'insert'; text: string };

const TOKEN_RE = /\s+|(?:[\p{L}\p{N}_'‘’′]+|[^\p{L}\p{N}_'‘’′\s])\s*/gu;

function wordDiffPreview(find: string, replace: string): PreviewOp[] {
  if (find === replace) {
    return find ? [{ kind: 'equal', text: find }] : [];
  }
  const a = tokenizePreview(find);
  const b = tokenizePreview(replace);
  const aKeys = a.map(previewTokenKey);
  const bKeys = b.map(previewTokenKey);
  if (a.length === 0) return replace ? [{ kind: 'insert', text: replace }] : [];
  if (b.length === 0) return [{ kind: 'delete', text: find }];

  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        aKeys[i - 1] === bKeys[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const reversed: PreviewOp[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aKeys[i - 1] === bKeys[j - 1]) {
      reversed.push({ kind: 'equal', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      reversed.push({ kind: 'insert', text: b[j - 1] });
      j--;
    } else {
      reversed.push({ kind: 'delete', text: a[i - 1] });
      i--;
    }
  }
  reversed.reverse();
  return coalescePreviewOps(reversed);
}

function tokenizePreview(value: string): string[] {
  return value.match(TOKEN_RE) ?? [];
}

function previewTokenKey(value: string): string {
  return value
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')
    .replace(/​/g, '');
}

function coalescePreviewOps(ops: PreviewOp[]): PreviewOp[] {
  const out: PreviewOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.kind === op.kind) {
      last.text += op.text;
    } else {
      out.push({ ...op });
    }
  }
  return out;
}

function TrackedChangeCard({
  edit,
  state,
  cardKey,
  onAccept,
  onReject,
  onView,
}: {
  edit: AppliedEdit;
  state: CardState;
  cardKey: string;
  onAccept: () => void;
  onReject: () => void;
  onView: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [flashing, setFlashing] = useState(false);

  // Listen for focus events targeting this card key.
  useEffect(() => {
    function onFocus(ev: Event) {
      const ce = ev as CustomEvent<FocusCardEventDetail>;
      if (ce.detail?.key !== cardKey) return;
      cardRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFlashing(true);
      window.setTimeout(() => setFlashing(false), 1200);
    }
    window.addEventListener('redline:focus-card', onFocus as EventListener);
    return () =>
      window.removeEventListener(
        'redline:focus-card',
        onFocus as EventListener,
      );
  }, [cardKey]);

  const busy = state.status === 'accepting' || state.status === 'rejecting';
  const resolved = state.status === 'accepted' || state.status === 'rejected';
  const previewOps = useMemo(
    () => wordDiffPreview(edit.find, edit.replace),
    [edit.find, edit.replace],
  );

  return (
    <div
      ref={cardRef}
      data-card-key={cardKey}
      className={cn(
        'rounded-lg border bg-card p-3 text-sm transition-shadow',
        state.status === 'accepted' && 'border-emerald-500/40 bg-emerald-500/5',
        state.status === 'rejected' && 'border-destructive/30 bg-destructive/5 opacity-70',
        flashing && 'ring-2 ring-amber-400/60',
      )}
    >
      {edit.reason && (
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">
          {edit.reason}
        </div>
      )}
      <div className="leading-relaxed">
        {previewOps.map((op, index) => {
          if (op.kind === 'equal') {
            return <span key={index}>{op.text}</span>;
          }
          if (op.kind === 'delete') {
            return (
              <span
                key={index}
                className="rounded-sm bg-destructive/15 px-0.5 text-destructive line-through decoration-destructive/60"
              >
                {op.text}
              </span>
            );
          }
          return (
            <span
              key={index}
              className="rounded-sm bg-emerald-500/15 px-0.5 text-emerald-700 dark:text-emerald-300"
            >
              {op.text}
            </span>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={onView}
          >
            <ExternalLink className="size-3" aria-hidden />
            In document
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          {state.status === 'accepted' ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <Check className="size-3" aria-hidden /> Accepted
            </span>
          ) : state.status === 'rejected' ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
              <Undo2 className="size-3" aria-hidden /> Rejected
            </span>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                disabled={busy}
                onClick={onReject}
              >
                <X className="size-3" aria-hidden />
                Reject
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                disabled={busy}
                onClick={onAccept}
              >
                <Check className="size-3" aria-hidden />
                Accept
              </Button>
            </>
          )}
        </div>
      </div>
      {state.error && (
        <p className="mt-1.5 text-xs text-destructive">{state.error}</p>
      )}
      {resolved && !state.error && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Re-download the .docx to get the updated file.
        </p>
      )}
    </div>
  );
}

export function appliedEditsKey(chatId: string, editIndex: number): string {
  return `${chatId}:${editIndex}`;
}

export function useTrackedChangesProps(): { sidePanelMounted: boolean } {
  // Tiny indicator hook so callers can decide whether to render the
  // panel (it requires a `<SidePanelProvider>` ancestor). Doesn't
  // actually touch the panel — useSidePanel does its own throw if
  // missing. Kept here for symmetry with future opt-in flows.
  return useMemo(() => ({ sidePanelMounted: true }), []);
}
