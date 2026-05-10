import { Kysely, sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { chunkMarkdown, type ChunkerOptions } from './chunker.js';
import type { Embedder } from './embedder.js';
import { toVectorLiteral } from './util.js';
import type { KbChunk, KbDB, KbDocument, KbInsertInput, KbSearchHit } from './types.js';

export interface KnowledgeBaseStoreOptions<TDB extends KbDB> {
  db: Kysely<TDB>;
  embedder: Embedder;
  chunker?: ChunkerOptions;
}

const RRF_K = 60;

export class KnowledgeBaseStore<TDB extends KbDB = KbDB> {
  private readonly db: Kysely<TDB>;
  private readonly embedder: Embedder;
  private readonly chunkerOptions: ChunkerOptions | undefined;

  constructor(opts: KnowledgeBaseStoreOptions<TDB>) {
    this.db = opts.db;
    this.embedder = opts.embedder;
    this.chunkerOptions = opts.chunker;
  }

  async insert(input: KbInsertInput): Promise<KbDocument> {
    const chunks = chunkMarkdown(input.markdown, this.chunkerOptions);
    if (chunks.length === 0) {
      throw new Error('Cannot insert empty document — chunker produced 0 chunks');
    }

    // Embed up-front so a failure leaves nothing partially inserted.
    const vectors = await this.embedder.embed(chunks.map((c) => c.content));

    const docId = uuidv7();
    const chunkRows = chunks.map((c, i) => ({
      id: uuidv7(),
      document_id: docId,
      chunk_index: i,
      content: c.content,
      start_char: c.startChar,
      end_char: c.endChar,
      embedding: toVectorLiteral(vectors[i]!),
    }));

    await this.db.transaction().execute(async (trx) => {
      // db is invariant in TDB so the transaction handle is too — narrow
      // the call sites with table-name string literals which Kysely keys on.
      const txDb = trx as unknown as Kysely<KbDB>;

      await txDb
        .insertInto('kb_documents')
        .values({
          id: docId,
          name: input.name,
          mime_type: input.mimeType,
          size: input.size,
          markdown: input.markdown,
          chunk_count: chunks.length,
          owner_id: input.ownerId ?? null,
        })
        .execute();

      // Multi-row insert with raw SQL so we can cast each embedding to
      // vector(D) in one round-trip rather than per-row.
      const valuesSql = chunkRows
        .map(
          (r, i) => sql`(
            ${r.id}, ${r.document_id}, ${r.chunk_index}, ${r.content},
            ${r.start_char}, ${r.end_char}, ${r.embedding}::vector(1536)
          )${i === chunkRows.length - 1 ? sql`` : sql`,`}`,
        )
        .reduce((acc, x) => sql`${acc}${x}`, sql``);

      await sql`
        INSERT INTO kb_chunks (id, document_id, chunk_index, content, start_char, end_char, embedding)
        VALUES ${valuesSql}
      `.execute(txDb);
    });

    return {
      id: docId,
      name: input.name,
      mimeType: input.mimeType,
      size: input.size,
      chunkCount: chunks.length,
      ownerId: input.ownerId ?? null,
      createdAt: new Date(),
    };
  }

  async list(ownerId: string | null): Promise<KbDocument[]> {
    const db = this.kbDb();
    const q = db
      .selectFrom('kb_documents')
      .selectAll()
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'desc');
    const rows = ownerId ? await q.where('owner_id', '=', ownerId).execute() : await q.execute();
    return rows.map(rowToDoc);
  }

  async get(id: string): Promise<KbDocument | null> {
    const row = await this.kbDb()
      .selectFrom('kb_documents')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? rowToDoc(row) : null;
  }

  /** Soft-delete: stamps deleted_at on document + chunks. Returns true if anything changed. */
  async delete(id: string): Promise<boolean> {
    const db = this.kbDb();
    const result = await db
      .updateTable('kb_documents')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return false;

    await db
      .updateTable('kb_chunks')
      .set({ deleted_at: new Date() })
      .where('document_id', '=', id)
      .where('deleted_at', 'is', null)
      .execute();
    return true;
  }

  async listChunks(documentId: string): Promise<KbChunk[]> {
    const rows = await this.kbDb()
      .selectFrom('kb_chunks')
      .select(['id', 'document_id', 'chunk_index', 'content', 'start_char', 'end_char'])
      .where('document_id', '=', documentId)
      .where('deleted_at', 'is', null)
      .orderBy('chunk_index', 'asc')
      .execute();
    return rows.map(rowToChunk);
  }

  async count(ownerId: string | null): Promise<{ documents: number; chunks: number }> {
    const db = this.kbDb();
    const docQ = db
      .selectFrom('kb_documents')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('deleted_at', 'is', null);
    const docRow = await (ownerId ? docQ.where('owner_id', '=', ownerId) : docQ).executeTakeFirst();

    const chunkQ = db
      .selectFrom('kb_chunks as c')
      .innerJoin('kb_documents as d', 'd.id', 'c.document_id')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('c.deleted_at', 'is', null)
      .where('d.deleted_at', 'is', null);
    const chunkRow = await (ownerId
      ? chunkQ.where('d.owner_id', '=', ownerId)
      : chunkQ
    ).executeTakeFirst();

    return {
      documents: Number(docRow?.n ?? 0),
      chunks: Number(chunkRow?.n ?? 0),
    };
  }

  /**
   * Vector-only top-K. Cosine distance via pgvector's `<=>` operator.
   * Lower distance = more similar.
   */
  async search(
    query: string,
    opts: { topK?: number; ownerId?: string | null; documentIds?: readonly string[] } = {},
  ): Promise<KbSearchHit[]> {
    const topK = opts.topK ?? 5;
    if (!query.trim()) return [];

    const [vec] = await this.embedder.embed([query]);
    const vecLit = toVectorLiteral(vec!);
    const ownerId = opts.ownerId ?? null;
    const docIds = opts.documentIds && opts.documentIds.length > 0 ? opts.documentIds : null;

    const ownerFilter = ownerId
      ? sql`AND d.owner_id = ${ownerId}`
      : sql``;
    const docFilter = docIds
      ? sql`AND c.document_id = ANY(${docIds as string[]})`
      : sql``;

    const rows = await sql<HitRow>`
      SELECT
        c.id           AS chunk_id,
        c.document_id  AS document_id,
        c.chunk_index  AS chunk_index,
        c.content      AS content,
        c.start_char   AS start_char,
        c.end_char     AS end_char,
        d.name         AS doc_name,
        d.mime_type    AS doc_mime,
        d.size         AS doc_size,
        d.chunk_count  AS doc_chunks,
        d.owner_id     AS doc_owner,
        d.created_at   AS doc_created,
        (c.embedding <=> ${vecLit}::vector(1536)) AS distance
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      WHERE c.deleted_at IS NULL AND d.deleted_at IS NULL
        ${ownerFilter}
        ${docFilter}
      ORDER BY c.embedding <=> ${vecLit}::vector(1536)
      LIMIT ${topK}
    `.execute(this.kbDb());

    return rows.rows.map(rowToHit);
  }

  /**
   * Keyword-only top-K via tsvector + ts_rank_cd. Distance is undefined on
   * these hits — they didn't pass through the vector index.
   */
  async searchKeyword(
    query: string,
    opts: { topK?: number; ownerId?: string | null; documentIds?: readonly string[] } = {},
  ): Promise<KbSearchHit[]> {
    const topK = opts.topK ?? 5;
    if (!query.trim()) return [];

    const ownerId = opts.ownerId ?? null;
    const docIds = opts.documentIds && opts.documentIds.length > 0 ? opts.documentIds : null;
    const ownerFilter = ownerId ? sql`AND d.owner_id = ${ownerId}` : sql``;
    const docFilter = docIds ? sql`AND c.document_id = ANY(${docIds as string[]})` : sql``;

    const rows = await sql<HitRow>`
      SELECT
        c.id           AS chunk_id,
        c.document_id  AS document_id,
        c.chunk_index  AS chunk_index,
        c.content      AS content,
        c.start_char   AS start_char,
        c.end_char     AS end_char,
        d.name         AS doc_name,
        d.mime_type    AS doc_mime,
        d.size         AS doc_size,
        d.chunk_count  AS doc_chunks,
        d.owner_id     AS doc_owner,
        d.created_at   AS doc_created,
        NULL::float8   AS distance
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id,
           plainto_tsquery('english', ${query}) q
      WHERE c.deleted_at IS NULL AND d.deleted_at IS NULL
        AND c.content_tsv @@ q
        ${ownerFilter}
        ${docFilter}
      ORDER BY ts_rank_cd(c.content_tsv, q) DESC
      LIMIT ${topK}
    `.execute(this.kbDb());

    return rows.rows.map(rowToHit);
  }

  /**
   * Hybrid retrieval via Reciprocal Rank Fusion. Both lanes (vector + keyword)
   * are computed in ONE SQL with two CTEs — fewer round-trips than running
   * them sequentially or in parallel from the app.
   *
   * RRF score for chunk c = 1/(K+rank_vec(c)) + 1/(K+rank_kw(c)),
   * with K=60 (Cormack et al.). Chunks that hit only one lane still rank.
   */
  async searchHybrid(
    query: string,
    opts: { topK?: number; ownerId?: string | null; documentIds?: readonly string[] } = {},
  ): Promise<KbSearchHit[]> {
    const topK = opts.topK ?? 5;
    if (!query.trim()) return [];

    const oversample = Math.max(topK * 4, 20);
    const [vec] = await this.embedder.embed([query]);
    const vecLit = toVectorLiteral(vec!);
    const ownerId = opts.ownerId ?? null;
    const docIds = opts.documentIds && opts.documentIds.length > 0 ? opts.documentIds : null;
    const ownerFilter = ownerId ? sql`AND d.owner_id = ${ownerId}` : sql``;
    const docFilter = docIds ? sql`AND c.document_id = ANY(${docIds as string[]})` : sql``;

    const rows = await sql<HitRow & { rrf_score: number }>`
      WITH vec AS (
        SELECT
          c.id AS chunk_id,
          ROW_NUMBER() OVER (ORDER BY c.embedding <=> ${vecLit}::vector(1536)) AS r,
          (c.embedding <=> ${vecLit}::vector(1536)) AS distance
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.document_id
        WHERE c.deleted_at IS NULL AND d.deleted_at IS NULL
          ${ownerFilter}
          ${docFilter}
        ORDER BY c.embedding <=> ${vecLit}::vector(1536)
        LIMIT ${oversample}
      ),
      kw AS (
        SELECT
          c.id AS chunk_id,
          ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.content_tsv, q) DESC) AS r
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.document_id,
             plainto_tsquery('english', ${query}) q
        WHERE c.deleted_at IS NULL AND d.deleted_at IS NULL
          AND c.content_tsv @@ q
          ${ownerFilter}
          ${docFilter}
        ORDER BY ts_rank_cd(c.content_tsv, q) DESC
        LIMIT ${oversample}
      ),
      fused AS (
        SELECT u.chunk_id,
               COALESCE(1.0 / (${RRF_K} + vec.r), 0) + COALESCE(1.0 / (${RRF_K} + kw.r), 0) AS rrf_score,
               vec.distance AS distance
        FROM (SELECT chunk_id FROM vec UNION SELECT chunk_id FROM kw) u
        LEFT JOIN vec ON vec.chunk_id = u.chunk_id
        LEFT JOIN kw  ON kw.chunk_id  = u.chunk_id
      )
      SELECT
        c.id           AS chunk_id,
        c.document_id  AS document_id,
        c.chunk_index  AS chunk_index,
        c.content      AS content,
        c.start_char   AS start_char,
        c.end_char     AS end_char,
        d.name         AS doc_name,
        d.mime_type    AS doc_mime,
        d.size         AS doc_size,
        d.chunk_count  AS doc_chunks,
        d.owner_id     AS doc_owner,
        d.created_at   AS doc_created,
        f.distance     AS distance,
        f.rrf_score    AS rrf_score
      FROM fused f
      JOIN kb_chunks c    ON c.id = f.chunk_id
      JOIN kb_documents d ON d.id = c.document_id
      ORDER BY f.rrf_score DESC
      LIMIT ${topK}
    `.execute(this.kbDb());

    return rows.rows.map((r) => ({ ...rowToHit(r), rrfScore: Number(r.rrf_score) }));
  }

  // The store accepts `Kysely<TDB extends KbDB>` so callers can pass their
  // wider app DB type. Internally we narrow to KbDB for raw SQL execution.
  private kbDb(): Kysely<KbDB> {
    return this.db as unknown as Kysely<KbDB>;
  }
}

interface DocRow {
  id: string;
  name: string;
  mime_type: string;
  size: string | number | bigint;
  chunk_count: number;
  owner_id: string | null;
  created_at: Date;
}

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  start_char: number;
  end_char: number;
}

interface HitRow {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  start_char: number;
  end_char: number;
  doc_name: string;
  doc_mime: string;
  doc_size: string | number | bigint;
  doc_chunks: number;
  doc_owner: string | null;
  doc_created: Date;
  distance: number | null;
}

function rowToDoc(row: DocRow): KbDocument {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    size: Number(row.size),
    chunkCount: row.chunk_count,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
}

function rowToChunk(row: ChunkRow): KbChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    startChar: row.start_char,
    endChar: row.end_char,
  };
}

function rowToHit(row: HitRow): KbSearchHit {
  const hit: KbSearchHit = {
    chunk: {
      id: row.chunk_id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      startChar: row.start_char,
      endChar: row.end_char,
    },
    document: {
      id: row.document_id,
      name: row.doc_name,
      mimeType: row.doc_mime,
      size: Number(row.doc_size),
      chunkCount: row.doc_chunks,
      ownerId: row.doc_owner,
      createdAt: row.doc_created,
    },
  };
  if (row.distance !== null) hit.distance = Number(row.distance);
  return hit;
}
