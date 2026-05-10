import type { ColumnType, Generated } from 'kysely';

export type VersionSource = 'upload' | 'proposal' | 'accept' | 'reject' | 'generated';

export const VERSION_SOURCES: readonly VersionSource[] = [
  'upload',
  'proposal',
  'accept',
  'reject',
  'generated',
] as const;

export interface DocumentVersion {
  id: string;
  /** Opaque pointer to the logical document (no FK). */
  externalDocId: string;
  /** Null for the root upload, OR for a version whose parent was deleted (parent_id ON DELETE SET NULL). */
  parentId: string | null;
  source: VersionSource;
  /** Opaque pointer the host uses to retrieve bytes. The store doesn't interpret it. */
  storageId: string;
  byteSize: number | null;
  /** SHA-256 hex of the bytes, when computed. */
  contentHash: string | null;
  notes: string | null;
  createdAt: Date;
}

export interface AddVersionInput {
  externalDocId: string;
  parentId?: string | null;
  source: VersionSource;
  storageId: string;
  byteSize?: number | null;
  contentHash?: string | null;
  notes?: string | null;
}

// Kysely table types.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface DocumentVersionsTable {
  id: string;
  external_doc_id: string;
  parent_id: string | null;
  source: VersionSource;
  storage_id: string;
  byte_size: ColumnType<string | null, string | number | bigint | null, string | number | bigint | null>;
  content_hash: string | null;
  notes: string | null;
  created_at: Generated<Date>;
  deleted_at: Timestamp | null;
}

export interface DocumentHeadsTable {
  external_doc_id: string;
  current_version_id: string;
  updated_at: Generated<Date>;
}

export interface DocumentVersionsDB {
  document_versions: DocumentVersionsTable;
  document_heads: DocumentHeadsTable;
}
