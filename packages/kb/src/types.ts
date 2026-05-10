import type { ColumnType, Generated } from 'kysely';

// Public domain types — what callers see.

export interface KbDocument {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes of the original upload, informational only. */
  size: number;
  chunkCount: number;
  /** Optional owner id (e.g. user email). The store doesn't enforce ownership — callers do. */
  ownerId: string | null;
  /** ISO timestamp. */
  createdAt: Date;
}

export interface KbChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  startChar: number;
  endChar: number;
}

export interface KbSearchHit {
  chunk: KbChunk;
  document: KbDocument;
  /** Cosine distance — lower is more similar. Undefined for keyword-only hits. */
  distance?: number;
  /** Reciprocal-Rank-Fusion score. Only set on hybrid hits. */
  rrfScore?: number;
}

export interface KbInsertInput {
  name: string;
  mimeType: string;
  size: number;
  /** Already-converted markdown text. Caller converts binaries before insert. */
  markdown: string;
  ownerId?: string;
}

// Kysely table types — composed into the app's DB type.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface KbDocumentsTable {
  id: string;
  name: string;
  mime_type: string;
  size: ColumnType<string, string | number | bigint, string | number | bigint>;
  markdown: string;
  chunk_count: Generated<number>;
  owner_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Timestamp | null;
}

export interface KbChunksTable {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  start_char: number;
  end_char: number;
  /** vector(1536). Insert via raw SQL with ::vector cast. */
  embedding: ColumnType<string, string, string>;
  /** GENERATED ALWAYS — never write. */
  content_tsv: ColumnType<string, never, never>;
  created_at: Generated<Date>;
  deleted_at: Timestamp | null;
}

export interface KbDB {
  kb_documents: KbDocumentsTable;
  kb_chunks: KbChunksTable;
}
