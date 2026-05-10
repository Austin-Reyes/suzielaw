import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { KnowledgeBaseStore, KbSearchHit } from '@counsel/kb';

import { convertFileToMarkdown } from './document-tools.js';
import type { FileRecord } from './files.js';

/**
 * Kysely-side schema for the host-app glue table that lives in the
 * @counsel/db migration set (see 1715000100000_matter_doc_index.cjs).
 * Kept inline here so matter-rag stays a self-contained module — it's
 * the only consumer of the table.
 */
export interface MatterDocIndexTable {
    matter_id: string;
    file_id: string;
    kb_doc_id: string;
    indexed_at: Date;
}
export interface MatterDocIndexDB {
    matter_doc_index: MatterDocIndexTable;
}

export interface MatterRagOptions {
    db: Kysely<MatterDocIndexDB>;
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
    private readonly db: Kysely<MatterDocIndexDB>;
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
        const prior = await this.lookupKbDocId(matterId, record.id);
        if (prior) {
            try {
                await this.kb.delete(prior);
            } catch {
                /* noop — best-effort cleanup */
            }
            await this.deleteMapping(matterId, record.id);
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

        await this.recordMapping(matterId, record.id, inserted.id);
        return {
            ok: true,
            kbDocId: inserted.id,
            chunkCount: inserted.chunkCount,
        };
    }

    /** Drop a file's KB index + mapping, e.g. when a matter doc is removed. */
    async removeFile(matterId: string, fileId: string): Promise<void> {
        const kbDocId = await this.lookupKbDocId(matterId, fileId);
        if (!kbDocId) return;
        // Snapshot name + chunk count before delete so the success log can
        // report what came out, mirroring the upload path's "indexed X →
        // N chunk(s)" line.
        const docBefore = await this.kb.get(kbDocId);
        const startedAt = Date.now();
        let kbDeleteOk = true;
        try {
            await this.kb.delete(kbDocId);
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
            await this.deleteMapping(matterId, fileId);
            const elapsed = Date.now() - startedAt;
            const name = docBefore?.name ?? fileId;
            const chunks = docBefore?.chunkCount ?? 0;
            console.log(
                `[matter-rag] removed ${name} → ${chunks} chunk(s) dropped in ${elapsed}ms`,
            );
        }
    }

    /** Drop everything indexed for a matter — call when the matter is deleted. */
    async removeMatter(matterId: string): Promise<void> {
        const rows = await this.db
            .selectFrom('matter_doc_index')
            .select('kb_doc_id')
            .where('matter_id', '=', matterId)
            .execute();
        const ids = rows.map((r) => r.kb_doc_id);
        const stillOrphaned: string[] = [];
        for (const id of ids) {
            try {
                await this.kb.delete(id);
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
            await this.db
                .deleteFrom('matter_doc_index')
                .where('matter_id', '=', matterId)
                .execute();
        } else {
            await this.db
                .deleteFrom('matter_doc_index')
                .where('matter_id', '=', matterId)
                .where('kb_doc_id', 'not in', stillOrphaned)
                .execute();
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
        const kbDocId = await this.lookupKbDocId(matterId, fileId);
        if (!kbDocId) return [];
        return this.kb.searchHybrid(query, {
            ownerId: ownerIdForMatter(matterId),
            documentIds: [kbDocId],
            topK,
        });
    }

    /** Whether a (matter, file) pair has a KB index ready. */
    async hasIndex(matterId: string, fileId: string): Promise<boolean> {
        return (await this.lookupKbDocId(matterId, fileId)) !== null;
    }

    // --- private ---------------------------------------------------------

    private async lookupKbDocId(matterId: string, fileId: string): Promise<string | null> {
        const row = await this.db
            .selectFrom('matter_doc_index')
            .select('kb_doc_id')
            .where('matter_id', '=', matterId)
            .where('file_id', '=', fileId)
            .executeTakeFirst();
        return row?.kb_doc_id ?? null;
    }

    private async recordMapping(matterId: string, fileId: string, kbDocId: string): Promise<void> {
        await this.db
            .insertInto('matter_doc_index')
            .values({
                matter_id: matterId,
                file_id: fileId,
                kb_doc_id: kbDocId,
                indexed_at: sql`now()` as unknown as Date,
            })
            .onConflict((oc) =>
                oc.columns(['matter_id', 'file_id']).doUpdateSet({
                    kb_doc_id: (eb) => eb.ref('excluded.kb_doc_id'),
                    indexed_at: sql`now()` as unknown as Date,
                }),
            )
            .execute();
    }

    private async deleteMapping(matterId: string, fileId: string): Promise<void> {
        await this.db
            .deleteFrom('matter_doc_index')
            .where('matter_id', '=', matterId)
            .where('file_id', '=', fileId)
            .execute();
    }
}

function ownerIdForMatter(matterId: string): string {
    return `matter:${matterId}`;
}
