import type { AnyToolDefinition } from '@teamsuzie/agent-loop';
import type { FileRecord, InMemoryFileStore } from '../files.js';
import {
  runDocumentDiff,
  type DocumentDiffResult,
} from '../diff-engine.js';
import {
  composeRedlineDocx,
  redlineDownloadFilename,
} from '../redline-export.js';

interface BuildOptions {
  /** Bucket id for the file store — matter id for matter/review chats, otherwise the chat sessionId. */
  sessionId: string;
  fileStore: InMemoryFileStore;
  markitdownBaseUrl: string;
  /** Author name written into every revision when the redline DOCX is generated. */
  redlineAuthor?: string;
  /**
   * Origin (e.g. `http://localhost:17501`) prepended to the redline
   * download URL the tool returns. Set this from the request that built
   * the tool — small LLMs hallucinate a domain (commonly `example.com`)
   * when they wrap a bare relative URL into a markdown link, so we hand
   * them an absolute URL up front.
   */
  originUrl?: string;
}

/**
 * Tool the agent can call to compare two uploaded documents and stream back
 * a redline-style markdown diff. The model decides when to invoke it based
 * on the user's prompt ("compare", "diff", "redline these two", "what
 * changed between v1 and v2").
 */
export function buildDiffTools(opts: BuildOptions): AnyToolDefinition[] {
  const {
    sessionId,
    fileStore,
    markitdownBaseUrl,
    redlineAuthor = 'Counsel',
    originUrl = '',
  } = opts;

  const tool: AnyToolDefinition = {
    name: 'compare_documents',
    description:
      'Compare two previously-uploaded documents (DOCX/PDF/etc.) paragraph-by-paragraph and return a redline-style diff PLUS a downloadable tracked-change `.docx`. **Call this tool whenever the user asks for any of: "compare", "diff", "redline", "blackline", "show changes", "what changed", "differences", or any synonym referring to a side-by-side / version comparison between two attached documents.** Do NOT describe the comparison only in prose when this tool is available — invoking it is the only way to produce a real downloadable file. NEVER fabricate a download URL; the only valid `download_url` is the one returned in this tool\'s result. The result has (a) `stats` + `summary`, (b) a `markdown` field with `~~deletions~~` and `**insertions**` inline you can quote back, and (c) a `download_url` pointing at a tracked-change `.docx` (accept-all reproduces the right document; reject-all reproduces the left). Include the `download_url` verbatim as a clickable link in your reply.',
    parameters: {
      type: 'object',
      properties: {
        left_file_id: {
          type: 'string',
          description:
            "The earlier / 'before' / 'v1' document's file_id from the [Attachments] block.",
        },
        right_file_id: {
          type: 'string',
          description:
            "The later / 'after' / 'v2' document's file_id from the [Attachments] block.",
        },
      },
      required: ['left_file_id', 'right_file_id'],
      additionalProperties: false,
    },
    async execute(args: { left_file_id: string; right_file_id: string }) {
      const left = fileStore.get(sessionId, args.left_file_id);
      if (!left) {
        throw new Error(
          `left_file_id not found in session: ${args.left_file_id}`,
        );
      }
      const right = fileStore.get(sessionId, args.right_file_id);
      if (!right) {
        throw new Error(
          `right_file_id not found in session: ${args.right_file_id}`,
        );
      }
      if (left.id === right.id) {
        throw new Error(
          'left_file_id and right_file_id must reference different files.',
        );
      }

      const diff = await runDocumentDiff(left, right, { markitdownBaseUrl });

      // Generate the tracked-change .docx, store it under the same bucket
      // so the chat UI's existing /api/files/<sessionId>/<id>/content
      // route can serve it, and surface a download_url.
      let downloadUrl: string | null = null;
      let downloadFileId: string | null = null;
      let downloadFilename: string | null = null;
      try {
        const redlineBytes = composeRedlineDocx({
          leftBytes: left.bytes,
          rightBytes: right.bytes,
          diff,
          author: redlineAuthor,
        });
        const filename = redlineDownloadFilename(left.name, right.name);
        const fileId = `file_redline_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 10)}`;
        const record: FileRecord = {
          id: fileId,
          sessionId,
          name: filename,
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: redlineBytes.length,
          bytes: redlineBytes,
          createdAt: Date.now(),
        };
        fileStore.put(record);
        downloadFileId = fileId;
        downloadFilename = filename;
        const relativePath = `/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileId)}/content`;
        downloadUrl = originUrl ? `${originUrl}${relativePath}` : relativePath;
      } catch (err) {
        console.warn(
          '[compare_documents] redline export failed, returning markdown only:',
          err instanceof Error ? err.message : err,
        );
      }

      return {
        left: diff.left,
        right: diff.right,
        stats: diff.stats,
        summary: formatStatsLine(diff),
        markdown: renderDiffMarkdown(diff),
        download_url: downloadUrl,
        download_file_id: downloadFileId,
        download_filename: downloadFilename,
      };
    },
  };

  return [tool];
}

function formatStatsLine(diff: DocumentDiffResult): string {
  const { unchanged, modified, deleted, inserted, moved } = diff.stats;
  const parts: string[] = [];
  if (modified) parts.push(`${modified} modified`);
  if (deleted) parts.push(`${deleted} deleted from left`);
  if (inserted) parts.push(`${inserted} inserted into right`);
  if (moved) parts.push(`${moved} moved`);
  parts.push(`${unchanged} unchanged`);
  return parts.join(' · ');
}

function renderDiffMarkdown(diff: DocumentDiffResult): string {
  const lines: string[] = [];
  lines.push(`## Comparing **${diff.left.name}** → **${diff.right.name}**`);
  lines.push('');
  lines.push(`_${formatStatsLine(diff)}_`);
  lines.push('');

  let emittedAny = false;
  for (const event of diff.events) {
    if (event.kind === 'unchanged') continue;
    emittedAny = true;
    if (event.kind === 'modified') {
      const inline = renderModifiedInline(event.ops);
      const tag = event.moved ? 'modified + moved' : 'modified';
      lines.push(
        `**¶${event.leftIndex + 1} → ¶${event.rightIndex + 1}** _(${tag}, ${Math.round(event.similarity * 100)}% match)_`,
      );
      lines.push('');
      lines.push(blockquote(inline));
      lines.push('');
    } else if (event.kind === 'deleted') {
      lines.push(`**¶${event.leftIndex + 1} of left** _(deleted)_`);
      lines.push('');
      lines.push(blockquoteWithMarker(event.text, '~~'));
      lines.push('');
    } else {
      lines.push(`**¶${event.rightIndex + 1} of right** _(inserted)_`);
      lines.push('');
      lines.push(blockquoteWithMarker(event.text, '**'));
      lines.push('');
    }
  }

  if (!emittedAny) {
    lines.push('_The two documents are identical._');
  }
  return lines.join('\n');
}

/**
 * Render a modified paragraph's ops as inline markdown, with two
 * readability tweaks the naive `op → marker(text)` approach lacks:
 *
 *   1. Leading/trailing whitespace lives OUTSIDE the markers so chat MD
 *      renderers don't choke on `~~ text ~~`. (Some renderers refuse to
 *      apply strikethrough/bold when whitespace is immediately inside.)
 *   2. When a delete is directly followed by an insert (a swap), insert
 *      a ` → ` separator. Without it, "General Partner" → "GENERAL
 *      PARTNER" renders as `~~General Partner~~**GENERAL PARTNER**` —
 *      visually two words mashed together. The arrow gives the eye a
 *      pivot.
 */
function renderModifiedInline(ops: WordDiffOpLike[]): string {
  let out = '';
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === 'equal') {
      out += op.text;
      continue;
    }
    const trimmed = op.text.trim();
    if (!trimmed) continue;
    const leading = op.text.match(/^\s*/)?.[0] ?? '';
    const trailing = op.text.match(/\s*$/)?.[0] ?? '';
    const marker = op.kind === 'delete' ? '~~' : '**';
    const prev = i > 0 ? ops[i - 1] : null;
    const isSwap = prev?.kind === 'delete' && op.kind === 'insert';
    const sep = isSwap ? (/\s$/.test(out) ? '→ ' : ' → ') : '';
    out += `${sep}${leading}${marker}${trimmed}${marker}${trailing}`;
  }
  return out;
}

interface WordDiffOpLike {
  kind: 'equal' | 'insert' | 'delete';
  text: string;
}

function wrapTight(text: string, marker: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const leading = text.match(/^\s*/)?.[0] ?? '';
  const trailing = text.match(/\s*$/)?.[0] ?? '';
  return `${leading}${marker}${trimmed}${marker}${trailing}`;
}

/** Multi-line blockquote with ${marker}…${marker} per non-empty line. */
function blockquoteWithMarker(text: string, marker: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.trim() ? `> ${wrapTight(line, marker)}` : '>')
    .join('\n');
}

/** Multi-line blockquote (no extra markers — caller already applied them). */
function blockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}
