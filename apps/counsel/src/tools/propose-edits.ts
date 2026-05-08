import type { AnyToolDefinition } from '@teamsuzie/agent-loop';
import {
  applyContentKeyedEdits,
  bodyParagraphTexts,
  loadDocx,
  type ContentKeyedEdit,
} from '@teamsuzie/docx';
import type { DocumentVersionsStore } from '@teamsuzie/document-versions';
import type { FileRecord, InMemoryFileStore } from '../files.js';
import { findEditParagraphIndex } from '../redline-view.js';

interface BuildOptions {
  /** Bucket id for the file store (matter id for matter chats, chat id otherwise). */
  sessionId: string;
  fileStore: InMemoryFileStore;
  /** Author name written into every revision. */
  redlineAuthor?: string;
  /** Origin (e.g. http://localhost:17501) to make download_url absolute. */
  originUrl?: string;
  /** When set, every successful proposal records a version row branched from
   *  the source's latest upload-or-proposal version. */
  documentVersions?: DocumentVersionsStore;
}

/**
 * Chat tool the agent invokes to redline a single uploaded DOCX with a list
 * of content-keyed edits. Each edit specifies a find string + the
 * surrounding context (text immediately before and after) so the location
 * is unambiguous; the tool applies them as native Word tracked changes via
 * `applyContentKeyedEdits`, saves a new DOCX into the same file-store
 * bucket, and returns a download_url so the model can hand the user a
 * Word-openable file. Every successful application records a
 * `source: 'proposal'` version branched from the source DOCX's chain.
 */
export function buildProposeEditsTools(
  opts: BuildOptions,
): AnyToolDefinition[] {
  const {
    sessionId,
    fileStore,
    redlineAuthor = 'Counsel',
    originUrl = '',
    documentVersions,
  } = opts;

  const tool: AnyToolDefinition = {
    name: 'propose_document_edits',
    description:
      'Propose tracked-change edits to a SINGLE previously-uploaded DOCX (chat-driven redline against a base contract). **Use this whenever the user asks you to "redline", "edit", "revise", "amend", "negotiate against", "mark up", or "make changes to" a document, OR when the user asks for changes from a particular party\'s perspective (e.g., "redline this NDA from buyer\'s perspective").** Each edit is content-keyed: a `find` substring + `context_before` and `context_after` (5–15 words on each side, taken verbatim from the document) for disambiguation. Use empty `find` for a pure insertion at the position where context_before meets context_after. Returns a `download_url` to a Word-openable .docx with native `<w:ins>` / `<w:del>` tracked changes (accept-all in Word reproduces your proposed edits; reject-all reproduces the original). Always include `download_url` verbatim as a clickable link in your reply. Per-edit `errors[]` lists any edits that failed to apply (`not_found`, `ambiguous`, `overlaps`); when an edit fails, retry with more disambiguating context.',
    parameters: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description:
            "The DOCX file_id from the [Attachments] block to edit. Must be a .docx (we can't write tracked changes to PDFs).",
        },
        edits: {
          type: 'array',
          description:
            'List of content-keyed edits. Each is a find/replace with surrounding context for disambiguation.',
          items: {
            type: 'object',
            properties: {
              find: {
                type: 'string',
                description:
                  'The exact substring to delete. Empty string means a pure insertion at the position context_before + context_after meets.',
              },
              replace: {
                type: 'string',
                description:
                  'Replacement text. Empty string means pure deletion.',
              },
              context_before: {
                type: 'string',
                description:
                  '5–15 words from the document immediately before `find` (verbatim, including punctuation/spacing). Used to disambiguate identical `find` strings that occur multiple times.',
              },
              context_after: {
                type: 'string',
                description:
                  '5–15 words from the document immediately after `find` (verbatim). Used to disambiguate.',
              },
              reason: {
                type: 'string',
                description:
                  'Short rationale for the edit (e.g., "tighten confidentiality scope"). Surfaces in the per-edit result so the user can decide which proposals to accept.',
              },
            },
            required: ['find', 'replace', 'context_before', 'context_after'],
            additionalProperties: false,
          },
        },
      },
      required: ['file_id', 'edits'],
      additionalProperties: false,
    },
    async execute(args: {
      file_id: string;
      edits: Array<{
        find: string;
        replace: string;
        context_before: string;
        context_after: string;
        reason?: string;
      }>;
    }) {
      const record = fileStore.get(sessionId, args.file_id);
      if (!record) {
        throw new Error(`file_id not found in session: ${args.file_id}`);
      }
      if (
        !record.name.toLowerCase().endsWith('.docx') &&
        record.mimeType !==
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ) {
        throw new Error(
          `propose_document_edits requires a .docx file; got ${record.name} (${record.mimeType})`,
        );
      }
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        throw new Error('edits must be a non-empty array');
      }

      const file = loadDocx(record.bytes);
      // Snapshot paragraph texts BEFORE we mutate so we can locate each
      // applied edit's paragraph index — `applyContentKeyedEdits` doesn't
      // surface that in its return shape, but the cards UI needs it to
      // anchor cards to inline runs in the redline preview.
      const paragraphTextsBefore = bodyParagraphTexts(file);
      const editsForApply: ContentKeyedEdit[] = args.edits.map((e) => {
        const out: ContentKeyedEdit = {
          find: e.find,
          replace: e.replace,
          contextBefore: e.context_before,
          contextAfter: e.context_after,
        };
        if (e.reason !== undefined) out.reason = e.reason;
        return out;
      });
      const results = applyContentKeyedEdits(file, editsForApply, {
        name: redlineAuthor,
      });

      const appliedCount = results.filter((r) => r.status === 'applied').length;
      const errors = results
        .map((r, i) => ({
          index: i,
          status: r.status,
          reason: r.reason,
          find: args.edits[i].find,
          replace: args.edits[i].replace,
          original_reason: args.edits[i].reason,
        }))
        .filter((r) => r.status !== 'applied');

      // The accept/reject cards consume this: per-applied-edit metadata
      // + revision ids so the client can render Accept/Reject buttons
      // that hit the resolve endpoint by id, plus the source paragraph
      // index for inline-preview anchoring.
      const appliedEdits = results
        .map((r, i) => {
          if (r.status !== 'applied') return null;
          const e = args.edits[i];
          const paragraphIndex = findEditParagraphIndex(
            paragraphTextsBefore,
            e.find,
            e.context_before,
            e.context_after,
          );
          return {
            index: i,
            find: e.find,
            replace: e.replace,
            context_before: e.context_before,
            context_after: e.context_after,
            reason: e.reason,
            revision_ids: r.revisionIds,
            paragraph_index: paragraphIndex,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // Save the redline regardless of whether all edits applied — partial
      // proposals are useful (the user can accept what worked and try the
      // failures with more context).
      const redlineBytes = file.save();
      const baseName = record.name.replace(/\.docx$/i, '');
      const filename = `${baseName}__proposed_edits.docx`;
      const newFileId = `file_proposal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const newRecord: FileRecord = {
        id: newFileId,
        sessionId,
        name: filename,
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: redlineBytes.length,
        bytes: redlineBytes,
        createdAt: Date.now(),
      };
      fileStore.put(newRecord);

      // Record this proposal as a version branched from the source
      // doc's most recent version (an upload, or a prior proposal if the
      // user is iterating). Best-effort — failure here doesn't block the
      // download.
      let versionId: string | undefined;
      if (documentVersions && appliedCount > 0) {
        try {
          const head = documentVersions.getHead(args.file_id);
          const v = documentVersions.addVersion({
            externalDocId: args.file_id,
            parentId: head?.id ?? null,
            source: 'proposal',
            storageId: newFileId,
            byteSize: redlineBytes.length,
            notes: `Counsel proposed ${appliedCount} edit${appliedCount === 1 ? '' : 's'}`,
          });
          versionId = v.id;
        } catch (err) {
          console.warn(
            '[propose_document_edits] addVersion failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }

      const relativePath = `/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(newFileId)}/content`;
      const downloadUrl = originUrl ? `${originUrl}${relativePath}` : relativePath;

      return {
        applied_count: appliedCount,
        total: args.edits.length,
        errors,
        applied_edits: appliedEdits,
        download_url: downloadUrl,
        download_file_id: newFileId,
        download_session_id: sessionId,
        download_filename: filename,
        version_id: versionId,
        summary:
          appliedCount === args.edits.length
            ? `All ${appliedCount} edit${appliedCount === 1 ? '' : 's'} applied as tracked changes.`
            : `${appliedCount} of ${args.edits.length} edits applied; see errors for the rest.`,
      };
    },
  };

  return [tool];
}
