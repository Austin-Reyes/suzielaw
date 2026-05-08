import type { AnyToolDefinition } from '@teamsuzie/agent-loop';
import type { DocumentVersionsStore } from '@teamsuzie/document-versions';
import type { FileRecord, InMemoryFileStore } from '../files.js';

interface BuildOptions {
  /** File-store bucket id (matter id for matter chats, chat id otherwise). */
  sessionId: string;
  fileStore: InMemoryFileStore;
  /** Origin (e.g. http://localhost:17501) to make download_url absolute. */
  originUrl?: string;
  /** When set, the new copy is recorded as a `source: 'upload'` version
   *  rooted at the new file id (not branched from the source — semantics
   *  are "fresh document", not "next revision"). */
  documentVersions?: DocumentVersionsStore;
}

/**
 * `replicate_document(file_id, new_filename)` — copy an uploaded file
 * verbatim under a new filename. Used for "create NDA-v2.docx as a
 * working copy of NDA.docx" before redlining, so the original file in
 * the matter stays untouched. The copy lives in the same file-store
 * bucket and is downloadable via the standard `/api/files/...` URL.
 *
 * Bytes are copied byte-for-byte — no parse, no re-emit. Works for any
 * file type, not just DOCX.
 */
export function buildReplicateDocumentTools(
  opts: BuildOptions,
): AnyToolDefinition[] {
  const { sessionId, fileStore, originUrl = '', documentVersions } = opts;

  const tool: AnyToolDefinition = {
    name: 'replicate_document',
    description:
      'Copy an uploaded document verbatim under a new filename. Use this when the user asks for a "copy", "duplicate", or a working version (e.g., "make a v2 of NDA.docx I can mark up") so the original stays untouched. The new file is downloadable immediately and can be passed straight to `propose_document_edits`. Returns `download_url` and the new `file_id`.',
    parameters: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description:
            'Source file id from the [Attachments] block. Bytes are copied as-is; works for DOCX, PDF, images, etc.',
        },
        new_filename: {
          type: 'string',
          description:
            'Filename for the copy. Extension is auto-preserved if omitted (e.g. "NDA-v2" copies "NDA.docx" to "NDA-v2.docx"). Sanitised — directory separators stripped.',
        },
      },
      required: ['file_id', 'new_filename'],
      additionalProperties: false,
    },
    async execute(args: { file_id: string; new_filename: string }) {
      const record = fileStore.get(sessionId, args.file_id);
      if (!record) {
        throw new Error(`file_id not found in session: ${args.file_id}`);
      }
      const sanitized = sanitizeFilename(args.new_filename);
      if (!sanitized) {
        throw new Error('new_filename is required (after sanitisation)');
      }
      const finalName = preserveExtension(record.name, sanitized);
      const newFileId = `file_copy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const newRecord: FileRecord = {
        id: newFileId,
        sessionId,
        name: finalName,
        mimeType: record.mimeType,
        size: record.size,
        // Slice to a fresh Uint8Array so future mutations of the source's
        // bytes (e.g. revisions/resolve in place) don't bleed into the copy.
        bytes: Buffer.from(record.bytes),
        createdAt: Date.now(),
      };
      fileStore.put(newRecord);

      let versionId: string | undefined;
      if (documentVersions) {
        try {
          const v = documentVersions.addVersion({
            externalDocId: newFileId,
            parentId: null,
            source: 'upload',
            storageId: newFileId,
            byteSize: newRecord.size,
            notes: `Copied from ${record.name}`,
          });
          versionId = v.id;
        } catch (err) {
          console.warn(
            '[replicate_document] addVersion failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }

      const relativePath = `/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(newFileId)}/content`;
      const downloadUrl = originUrl ? `${originUrl}${relativePath}` : relativePath;
      return {
        file_id: newFileId,
        filename: finalName,
        size: newRecord.size,
        download_url: downloadUrl,
        version_id: versionId,
        summary: `Copied ${record.name} → ${finalName}`,
      };
    },
  };

  return [tool];
}

function sanitizeFilename(name: string): string {
  const trimmed = String(name ?? '').trim();
  // Strip any path separators — the file store is flat per-session and
  // we don't want directory traversal in the surfaced filename.
  return trimmed.replace(/[/\\]/g, '_').replace(/^\.+/, '').slice(0, 240);
}

function preserveExtension(sourceName: string, requestedName: string): string {
  const sourceExt = extension(sourceName);
  const requestedExt = extension(requestedName);
  if (requestedExt) return requestedName;
  if (!sourceExt) return requestedName;
  return `${requestedName}${sourceExt}`;
}

function extension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx < 0) return '';
  return name.slice(idx);
}
