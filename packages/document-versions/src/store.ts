import { Kysely, sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type {
  AddVersionInput,
  DocumentVersion,
  DocumentVersionsDB,
  VersionSource,
} from './types.js';
import { VERSION_SOURCES } from './types.js';

export interface DocumentVersionsStoreOptions<TDB extends DocumentVersionsDB> {
  db: Kysely<TDB>;
  idFactory?: () => string;
}

export class DocumentVersionsStore<TDB extends DocumentVersionsDB = DocumentVersionsDB> {
  private readonly db: Kysely<TDB>;
  private readonly newId: () => string;

  constructor(opts: DocumentVersionsStoreOptions<TDB>) {
    this.db = opts.db;
    this.newId = opts.idFactory ?? uuidv7;
  }

  async addVersion(input: AddVersionInput): Promise<DocumentVersion> {
    if (!VERSION_SOURCES.includes(input.source)) {
      throw new Error(
        `invalid source: ${input.source} (expected one of: ${VERSION_SOURCES.join(', ')})`,
      );
    }
    if (input.parentId) {
      const parent = await this.getVersion(input.parentId);
      if (!parent) throw new Error(`parentId not found: ${input.parentId}`);
      if (parent.externalDocId !== input.externalDocId) {
        throw new Error(`parentId ${input.parentId} belongs to a different document`);
      }
    }

    const id = this.newId();
    await this.kbDb().transaction().execute(async (trx) => {
      const txDb = trx as unknown as Kysely<DocumentVersionsDB>;

      await txDb
        .insertInto('document_versions')
        .values({
          id,
          external_doc_id: input.externalDocId,
          parent_id: input.parentId ?? null,
          source: input.source,
          storage_id: input.storageId,
          byte_size: input.byteSize ?? null,
          content_hash: input.contentHash ?? null,
          notes: input.notes ?? null,
        })
        .execute();

      // New version becomes the head. Upsert because heads are 1:1 with
      // external_doc_id.
      await txDb
        .insertInto('document_heads')
        .values({
          external_doc_id: input.externalDocId,
          current_version_id: id,
        })
        .onConflict((oc) =>
          oc.column('external_doc_id').doUpdateSet({
            current_version_id: id,
            updated_at: sql`now()`,
          }),
        )
        .execute();
    });

    return (await this.getVersion(id))!;
  }

  async getVersion(id: string): Promise<DocumentVersion | null> {
    const row = await this.kbDb()
      .selectFrom('document_versions')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? rowToVersion(row) : null;
  }

  /** Versions for one logical document, oldest first. */
  async listVersions(externalDocId: string): Promise<DocumentVersion[]> {
    const rows = await this.kbDb()
      .selectFrom('document_versions')
      .selectAll()
      .where('external_doc_id', '=', externalDocId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(rowToVersion);
  }

  async getHead(externalDocId: string): Promise<DocumentVersion | null> {
    const row = await this.kbDb()
      .selectFrom('document_heads as h')
      .innerJoin('document_versions as v', 'v.id', 'h.current_version_id')
      .where('h.external_doc_id', '=', externalDocId)
      .where('v.deleted_at', 'is', null)
      .selectAll('v')
      .executeTakeFirst();
    return row ? rowToVersion(row) : null;
  }

  async setHead(externalDocId: string, versionId: string): Promise<DocumentVersion> {
    const version = await this.getVersion(versionId);
    if (!version) throw new Error(`version not found: ${versionId}`);
    if (version.externalDocId !== externalDocId) {
      throw new Error(`version ${versionId} belongs to a different document`);
    }

    await this.kbDb()
      .insertInto('document_heads')
      .values({ external_doc_id: externalDocId, current_version_id: versionId })
      .onConflict((oc) =>
        oc.column('external_doc_id').doUpdateSet({
          current_version_id: versionId,
          updated_at: sql`now()`,
        }),
      )
      .execute();
    return version;
  }

  /**
   * Walk back from a version to the root via parent_id. Single round-trip
   * via recursive CTE — replaces the upstream SQLite N-roundtrip walk.
   * Cycle-safe via UNION (PG dedupes), and bounded by the chain length.
   */
  async walkAncestors(versionId: string): Promise<DocumentVersion[]> {
    const rows = await sql<VersionRow & { depth: number }>`
      WITH RECURSIVE chain AS (
        SELECT v.*, 0 AS depth
        FROM document_versions v
        WHERE v.id = ${versionId} AND v.deleted_at IS NULL
        UNION
        SELECT v.*, c.depth + 1
        FROM document_versions v
        JOIN chain c ON v.id = c.parent_id
        WHERE v.deleted_at IS NULL
      )
      SELECT * FROM chain ORDER BY depth ASC
    `.execute(this.kbDb());
    return rows.rows.map(rowToVersion);
  }

  /**
   * All descendants of `versionId` (excluding itself). Single recursive
   * CTE — replaces the upstream "fetch all + build tree in memory".
   */
  async walkDescendants(versionId: string): Promise<DocumentVersion[]> {
    const rows = await sql<VersionRow & { depth: number }>`
      WITH RECURSIVE tree AS (
        SELECT v.*, 0 AS depth
        FROM document_versions v
        WHERE v.parent_id = ${versionId} AND v.deleted_at IS NULL
        UNION
        SELECT v.*, t.depth + 1
        FROM document_versions v
        JOIN tree t ON v.parent_id = t.id
        WHERE v.deleted_at IS NULL
      )
      SELECT * FROM tree ORDER BY depth ASC, created_at ASC
    `.execute(this.kbDb());
    return rows.rows.map(rowToVersion);
  }

  /**
   * Hard-delete every version + the head pointer for one logical document.
   * Heads first (clears the head FK to versions), then versions (parent_id
   * is ON DELETE SET NULL so the order within the version sweep doesn't
   * matter — PG nulls children's parent_id as their parents disappear).
   */
  async deleteAllForDocument(externalDocId: string): Promise<number> {
    return this.kbDb().transaction().execute(async (trx) => {
      const txDb = trx as unknown as Kysely<DocumentVersionsDB>;
      await txDb
        .deleteFrom('document_heads')
        .where('external_doc_id', '=', externalDocId)
        .execute();
      const result = await txDb
        .deleteFrom('document_versions')
        .where('external_doc_id', '=', externalDocId)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    });
  }

  private kbDb(): Kysely<DocumentVersionsDB> {
    return this.db as unknown as Kysely<DocumentVersionsDB>;
  }
}

interface VersionRow {
  id: string;
  external_doc_id: string;
  parent_id: string | null;
  source: string;
  storage_id: string;
  byte_size: string | null;
  content_hash: string | null;
  notes: string | null;
  created_at: Date;
}

function rowToVersion(row: VersionRow): DocumentVersion {
  return {
    id: row.id,
    externalDocId: row.external_doc_id,
    parentId: row.parent_id,
    source: row.source as VersionSource,
    storageId: row.storage_id,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    contentHash: row.content_hash,
    notes: row.notes,
    createdAt: row.created_at,
  };
}
