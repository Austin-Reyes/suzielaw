/**
 * Inline panel rendered while a Litify/Docrio zip is being ingested and
 * after it finishes. Two phases:
 *
 * - Active: shows "Processing N of M (stage)…" with a thin progress bar
 *   so the user knows the system isn't frozen on a multi-minute upload.
 * - Settled: shows the manifest summary line and an expandable details list.
 *
 * No filenames in error logs anywhere upstream; per-entry paths only show
 * here, in the attorney's authenticated view.
 */

import { useState } from 'react';
import type {
  ZipManifest,
  ZipUploadProgress,
  ZipEntryResult,
  ZipEntryKind,
} from '../hooks/use-matter.js';

export interface ZipUploadPanelProps {
  zipFilename: string;
  /** When set, the upload is still running. */
  progress: ZipUploadProgress | null;
  /** When set, the upload finished. */
  manifest: ZipManifest | null;
  /** When set, the upload failed with this message. */
  errorMessage: string | null;
  /** Called when the user dismisses the panel after settle. */
  onDismiss?: () => void;
}

export function ZipUploadPanel({
  zipFilename,
  progress,
  manifest,
  errorMessage,
  onDismiss,
}: ZipUploadPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const running = !manifest && !errorMessage;

  const pct = progress && progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;

  return (
    <div
      style={{
        border: '1px solid #d0d7de',
        borderRadius: 6,
        padding: '10px 12px',
        margin: '8px 0',
        background: '#f6f8fa',
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {zipFilename}
        </strong>
        {!running && onDismiss && (
          <button
            onClick={onDismiss}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#57606a', fontSize: 16, lineHeight: 1, padding: 0,
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>

      {running && (
        <>
          <div style={{ color: '#57606a', marginTop: 4 }}>
            {progress
              ? `Processing ${progress.processed} of ${progress.total}… (${stageLabel(progress.stage)})`
              : 'Reading archive…'}
          </div>
          <div
            style={{
              marginTop: 6, height: 4, borderRadius: 2,
              background: '#d0d7de', overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                background: '#0969da',
                transition: 'width 200ms ease-out',
              }}
            />
          </div>
        </>
      )}

      {errorMessage && (
        <div style={{ color: '#cf222e', marginTop: 4 }}>
          {errorMessage}
        </div>
      )}

      {manifest && (
        <>
          <div style={{ color: '#1f2328', marginTop: 4 }}>
            {summaryLine(manifest)}
          </div>
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#0969da', padding: 0, marginTop: 6, fontSize: 12,
            }}
          >
            {expanded ? 'Hide details' : 'Show details'}
          </button>
          {expanded && <ManifestEntries entries={manifest.entries} />}
        </>
      )}
    </div>
  );
}

function summaryLine(m: ZipManifest): string {
  const parts = [
    `${m.summary.text} text`,
    `${m.summary.ocrd} OCR'd`,
    `${m.summary.attached} attached (no OCR)`,
    `${m.summary.duplicates} duplicates merged`,
    `${m.summary.failed} failed`,
  ];
  return parts.join(' · ');
}

function stageLabel(stage: ZipUploadProgress['stage']): string {
  switch (stage) {
    case 'reading': return 'reading';
    case 'classify': return 'extracting';
    case 'ocr': return 'OCR';
    case 'index': return 'indexing';
    case 'done': return 'done';
  }
}

function ManifestEntries({ entries }: { entries: ZipEntryResult[] }) {
  // Group by kind so failures + duplicates surface first; the long "text"
  // list goes last because it's the boring happy path.
  const order: ZipEntryKind[] = ['failed', 'duplicate', 'ocrd', 'attached', 'text'];
  const grouped = new Map<ZipEntryKind, ZipEntryResult[]>();
  for (const e of entries) {
    if (!grouped.has(e.kind)) grouped.set(e.kind, []);
    grouped.get(e.kind)!.push(e);
  }

  return (
    <div
      style={{
        marginTop: 6, maxHeight: 260, overflowY: 'auto',
        background: '#fff', border: '1px solid #d0d7de', borderRadius: 4,
        padding: 6, fontSize: 12,
      }}
    >
      {order.map((kind) => {
        const list = grouped.get(kind);
        if (!list || list.length === 0) return null;
        return (
          <div key={kind} style={{ marginBottom: 6 }}>
            <div style={{ color: '#57606a', fontWeight: 600 }}>
              {kindLabel(kind)} ({list.length})
            </div>
            {list.map((e) => (
              <div
                key={`${e.path}-${e.sha256 ?? ''}`}
                style={{ color: '#1f2328', paddingLeft: 8 }}
                title={e.reason ?? ''}
              >
                {e.path}
                {e.reason && (
                  <span style={{ color: '#57606a' }}> — {e.reason}</span>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function kindLabel(kind: ZipEntryKind): string {
  switch (kind) {
    case 'text': return 'Indexed (text extracted)';
    case 'ocrd': return "Indexed (OCR'd)";
    case 'attached': return 'Attached (no OCR)';
    case 'duplicate': return 'Duplicates (already in matter)';
    case 'failed': return 'Failed';
  }
}
