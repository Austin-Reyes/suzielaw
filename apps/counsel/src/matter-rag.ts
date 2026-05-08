import { prepareCached, type DatabaseInstance } from '@teamsuzie/db-sqlite';
import type { KnowledgeBaseStore, KbSearchHit } from '@teamsuzie/kb';

import { convertFileToMarkdown } from './document-tools.js';
import type { FileRecord } from './files.js';

interface IndexRow {
    matter_id: string;
    file_id: string;
    kb_doc_id: string;
    indexed_at: number;
}

export interface MatterRagOptions {
    db: DatabaseInstance;
    kb: KnowledgeBaseStore;
    markitdownBaseUrl: string;
}

/**
 * Per-matter RAG glue. Indexes uploaded matter docs into the shared
 * `KnowledgeBaseStore` with `ownerId = matter:<matterId>` and tracks the
 * (matter_id, file_id) → kb_doc_id mapping in the `matter_doc_index` table.
 *
 * Cell runs (and later matter chats) call `searchInDoc` / `searchInMatter`
 * to retrieve top-K relevant chunks instead of feeding full document text
 * into the prompt.
 */
export class MatterRag {
    private readonly db: DatabaseInstance;
    private readonly kb: KnowledgeBaseStore;
    private readonly markitdownBaseUrl: string;

    constructor(opts: MatterRagOptions) {
        this.db = opts.db;
        this.kb = opts.kb;
        this.markitdownBaseUrl = opts.markitdownBaseUrl;
    }

    /**
     * Convert a freshly-uploaded file into markdown and insert it into the
     * KB scoped to the matter. Records the (matter, file) → kb-doc mapping
     * so subsequent searches can target this doc.
     *
     * Idempotent: re-indexing the same (matter, file) drops the prior KB
     * entry first, so the latest call wins.
     *
     * Returns `{ ok: true, chunkCount }` on success and `{ ok: false, reason }`
     * when conversion fails or yields nothing — callers can surface either
     * outcome in their logs.
     */
    async indexFile(
        matterId: string,
        record: FileRecord,
    ): Promise<
        | { ok: true; kbDocId: string; chunkCount: number }
        | { ok: false; reason: string }
    > {
        // If this (matter, file) was indexed before, drop the prior KB doc
        // and the mapping so we don't end up with stale chunks.
        const prior = this.lookupKbDocId(matterId, record.id);
        if (prior) {
            try {
                this.kb.delete(prior);
            } catch {
                /* noop — best-effort cleanup */
            }
            this.deleteMapping(matterId, record.id);
        }

        let markdown: string;
        try {
            markdown = await convertFileToMarkdown(record, {
                markitdownBaseUrl: this.markitdownBaseUrl,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                ok: false,
                reason: `convert failed: ${message}`,
            };
        }
        if (!markdown.trim()) {
            return { ok: false, reason: 'converted to empty markdown' };
        }

        const inserted = await this.kb.insert({
            name: record.name,
            mimeType: record.mimeType,
            size: record.size,
            markdown,
            ownerId: ownerIdForMatter(matterId),
        });

        this.recordMapping(matterId, record.id, inserted.id);
        return {
            ok: true,
            kbDocId: inserted.id,
            chunkCount: inserted.chunkCount,
        };
    }

    /** Drop a file's KB index + mapping, e.g. when a matter doc is removed. */
    removeFile(matterId: string, fileId: string): void {
        const kbDocId = this.lookupKbDocId(matterId, fileId);
        if (!kbDocId) return;
        // Snapshot name + chunk count before delete so the success log can
        // report what came out, mirroring the upload path's "indexed X →
        // N chunk(s)" line.
        const docBefore = this.kb.get(kbDocId);
        const startedAt = Date.now();
        let kbDeleteOk = true;
        try {
            this.kb.delete(kbDocId);
        } catch (err) {
            // If the kb-side delete fails we leave the matter_doc_index row
            // in place so a future retry / sweep can find the orphan again.
            // Logging is critical here — the previous silent swallow caused
            // the FTS-trigger bug to manifest as orphaned chunks days later.
            kbDeleteOk = false;
            console.warn(
                `[matter-rag] kb.delete(${kbDocId}) failed for (${matterId}, ${fileId}):`,
                err instanceof Error ? err.message : err,
            );
        }
        if (kbDeleteOk) {
            this.deleteMapping(matterId, fileId);
            const elapsed = Date.now() - startedAt;
            const name = docBefore?.name ?? fileId;
            const chunks = docBefore?.chunkCount ?? 0;
            console.log(
                `[matter-rag] removed ${name} → ${chunks} chunk(s) dropped in ${elapsed}ms`,
            );
        }
    }

    /** Drop everything indexed for a matter — call when the matter is deleted. */
    removeMatter(matterId: string): void {
        const ids = prepareCached<[string], { kb_doc_id: string }>(
            this.db,
            `SELECT kb_doc_id FROM matter_doc_index WHERE matter_id = ?`,
        )
            .all(matterId)
            .map((r) => r.kb_doc_id);
        const stillOrphaned: string[] = [];
        for (const id of ids) {
            try {
                this.kb.delete(id);
            } catch (err) {
                stillOrphaned.push(id);
                console.warn(
                    `[matter-rag] kb.delete(${id}) failed during removeMatter(${matterId}):`,
                    err instanceof Error ? err.message : err,
                );
            }
        }
        // Only drop mappings whose kb_documents row is actually gone — keeps
        // partial-failure state recoverable on the next call.
        if (stillOrphaned.length === 0) {
            prepareCached<[string]>(
                this.db,
                `DELETE FROM matter_doc_index WHERE matter_id = ?`,
            ).run(matterId);
        } else {
            const placeholders = stillOrphaned.map(() => '?').join(',');
            this.db
                .prepare(
                    `DELETE FROM matter_doc_index
                       WHERE matter_id = ?
                         AND kb_doc_id NOT IN (${placeholders})`,
                )
                .run(matterId, ...stillOrphaned);
        }
    }

    /**
     * Top-K chunks across the matter — used by future matter-chat to feed
     * a `vector_search` tool. Excludes mappings whose KB doc has since been
     * deleted. Uses hybrid (vector + BM25) retrieval.
     */
    async searchInMatter(
        matterId: string,
        query: string,
        topK = 5,
    ): Promise<KbSearchHit[]> {
        return this.kb.searchHybrid(query, {
            ownerId: ownerIdForMatter(matterId),
            topK,
        });
    }

    /**
     * Top-K chunks scoped to a single matter document (cell runner path).
     * Hybrid retrieval — keyword matches catch literal phrases like
     * "governing law" that pure embeddings can rank under unrelated
     * "law"-adjacent text; vector matches catch paraphrases the keyword
     * lane misses. Reciprocal Rank Fusion combines them.
     */
    async searchInDoc(
        matterId: string,
        fileId: string,
        query: string,
        topK = 5,
    ): Promise<KbSearchHit[]> {
        const kbDocId = this.lookupKbDocId(matterId, fileId);
        if (!kbDocId) return [];
        return this.kb.searchHybrid(query, {
            ownerId: ownerIdForMatter(matterId),
            documentIds: [kbDocId],
            topK,
        });
    }

    /** Whether a (matter, file) pair has a KB index ready. */
    hasIndex(matterId: string, fileId: string): boolean {
        return this.lookupKbDocId(matterId, fileId) !== null;
    }

    // --- private ---------------------------------------------------------

    private lookupKbDocId(matterId: string, fileId: string): string | null {
        const row = prepareCached<[string, string], IndexRow>(
            this.db,
            `SELECT * FROM matter_doc_index WHERE matter_id = ? AND file_id = ?`,
        ).get(matterId, fileId);
        return row?.kb_doc_id ?? null;
    }

    private recordMapping(matterId: string, fileId: string, kbDocId: string): void {
        prepareCached<[string, string, string, number]>(
            this.db,
            `INSERT INTO matter_doc_index (matter_id, file_id, kb_doc_id, indexed_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(matter_id, file_id) DO UPDATE SET
               kb_doc_id = excluded.kb_doc_id,
               indexed_at = excluded.indexed_at`,
        ).run(matterId, fileId, kbDocId, Date.now());
    }

    private deleteMapping(matterId: string, fileId: string): void {
        prepareCached<[string, string]>(
            this.db,
            `DELETE FROM matter_doc_index WHERE matter_id = ? AND file_id = ?`,
        ).run(matterId, fileId);
    }
}

function ownerIdForMatter(matterId: string): string {
    return `matter:${matterId}`;
}
