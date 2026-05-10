import { Kysely, sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type {
  AddColumnInput,
  AddReviewDocumentInput,
  CellFormat,
  CellStatus,
  CreateReviewInput,
  GridReviewDB,
  Review,
  ReviewCell,
  ReviewColumn,
  ReviewDocument,
  ReviewSnapshot,
  UpdateColumnInput,
  UpdateReviewInput,
  UpsertCellInput,
} from './types.js';

export interface ReviewsStoreOptions<TDB extends GridReviewDB> {
  db: Kysely<TDB>;
  idFactory?: () => string;
}

export class ReviewsStore<TDB extends GridReviewDB = GridReviewDB> {
  private readonly db: Kysely<TDB>;
  private readonly newId: () => string;

  constructor(opts: ReviewsStoreOptions<TDB>) {
    this.db = opts.db;
    this.newId = opts.idFactory ?? uuidv7;
  }

  // --- Review -----------------------------------------------------------

  async createReview(input: CreateReviewInput): Promise<Review> {
    const id = this.newId();
    await this.kbDb()
      .insertInto('reviews')
      .values({
        id,
        workspace_id: input.workspaceId,
        name: input.name,
        description: input.description ?? null,
      })
      .execute();
    return (await this.getReview(id))!;
  }

  async getReview(id: string): Promise<Review | null> {
    const row = await this.kbDb()
      .selectFrom('reviews')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? rowToReview(row) : null;
  }

  async listReviews(workspaceId: string): Promise<Review[]> {
    const rows = await this.kbDb()
      .selectFrom('reviews')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(rowToReview);
  }

  async updateReview(id: string, patch: UpdateReviewInput): Promise<Review | null> {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (Object.keys(set).length === 0) return this.getReview(id);

    const result = await this.kbDb()
      .updateTable('reviews')
      .set(set)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return null;
    return this.getReview(id);
  }

  async deleteReview(id: string): Promise<boolean> {
    const result = await this.kbDb()
      .updateTable('reviews')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  // --- Columns ----------------------------------------------------------

  async addColumn(input: AddColumnInput): Promise<ReviewColumn> {
    const id = this.newId();
    await this.kbDb()
      .insertInto('review_columns')
      .values({
        id,
        review_id: input.reviewId,
        title: input.title,
        prompt: input.prompt,
        format: input.format,
        position: input.position,
      })
      .execute();
    return (await this.getColumn(id))!;
  }

  async getColumn(id: string): Promise<ReviewColumn | null> {
    const row = await this.kbDb()
      .selectFrom('review_columns')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToColumn(row) : null;
  }

  async listColumns(reviewId: string): Promise<ReviewColumn[]> {
    const rows = await this.kbDb()
      .selectFrom('review_columns')
      .selectAll()
      .where('review_id', '=', reviewId)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map(rowToColumn);
  }

  async updateColumn(id: string, patch: UpdateColumnInput): Promise<ReviewColumn | null> {
    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.prompt !== undefined) set.prompt = patch.prompt;
    if (patch.format !== undefined) set.format = patch.format;
    if (patch.position !== undefined) set.position = patch.position;
    if (Object.keys(set).length === 0) return this.getColumn(id);

    const result = await this.kbDb()
      .updateTable('review_columns')
      .set(set)
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return null;
    return this.getColumn(id);
  }

  async removeColumn(id: string): Promise<boolean> {
    const result = await this.kbDb()
      .deleteFrom('review_columns')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  // --- Documents (rows) -------------------------------------------------

  async addDocument(input: AddReviewDocumentInput): Promise<ReviewDocument> {
    const id = this.newId();
    await this.kbDb()
      .insertInto('review_documents')
      .values({
        id,
        review_id: input.reviewId,
        external_doc_id: input.externalDocId,
        name: input.name,
        mime_type: input.mimeType ?? null,
        position: input.position,
      })
      .execute();
    return (await this.getDocument(id))!;
  }

  async getDocument(id: string): Promise<ReviewDocument | null> {
    const row = await this.kbDb()
      .selectFrom('review_documents')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToDocument(row) : null;
  }

  async listDocuments(reviewId: string): Promise<ReviewDocument[]> {
    const rows = await this.kbDb()
      .selectFrom('review_documents')
      .selectAll()
      .where('review_id', '=', reviewId)
      .orderBy('position', 'asc')
      .orderBy('added_at', 'asc')
      .execute();
    return rows.map(rowToDocument);
  }

  async removeDocument(id: string): Promise<boolean> {
    const result = await this.kbDb()
      .deleteFrom('review_documents')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  /**
   * Drop every review-document row referencing an external doc, scoped to
   * one workspace. Used when the host removes a doc from a matter — keeps
   * reviews from holding stale pointers.
   */
  async removeDocumentsByExternalId(
    workspaceId: string,
    externalDocId: string,
  ): Promise<number> {
    const result = await this.kbDb()
      .deleteFrom('review_documents')
      .where('external_doc_id', '=', externalDocId)
      .where('review_id', 'in', (eb) =>
        eb.selectFrom('reviews').select('id').where('workspace_id', '=', workspaceId),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  // --- Cells ------------------------------------------------------------

  async upsertCell(input: UpsertCellInput): Promise<ReviewCell> {
    // Match upstream tri-state semantics: undefined → leave alone; null →
    // clear; value → set. We can't express that in a single UPSERT so we
    // get-then-insert-or-update.
    const existing = await this.getCell(input.columnId, input.reviewDocumentId);
    const citationsJson =
      input.citations === undefined
        ? undefined
        : input.citations === null
          ? null
          : JSON.stringify(input.citations);

    if (existing) {
      const set: Record<string, unknown> = {};
      if (input.status !== undefined) set.status = input.status;
      if (input.value !== undefined) set.value = input.value;
      if (citationsJson !== undefined) set.citations = citationsJson;
      if (input.error !== undefined) set.error = input.error;
      if (Object.keys(set).length > 0) {
        await this.kbDb()
          .updateTable('review_cells')
          .set(set)
          .where('id', '=', existing.id)
          .execute();
      }
      return (await this.getCellById(existing.id))!;
    }

    const id = this.newId();
    await this.kbDb()
      .insertInto('review_cells')
      .values({
        id,
        review_id: input.reviewId,
        column_id: input.columnId,
        review_document_id: input.reviewDocumentId,
        status: input.status,
        value: input.value ?? null,
        citations: citationsJson === undefined ? null : citationsJson,
        error: input.error ?? null,
      })
      .execute();
    return (await this.getCellById(id))!;
  }

  async getCell(columnId: string, reviewDocumentId: string): Promise<ReviewCell | null> {
    const row = await this.kbDb()
      .selectFrom('review_cells')
      .selectAll()
      .where('column_id', '=', columnId)
      .where('review_document_id', '=', reviewDocumentId)
      .executeTakeFirst();
    return row ? rowToCell(row) : null;
  }

  async getCellById(id: string): Promise<ReviewCell | null> {
    const row = await this.kbDb()
      .selectFrom('review_cells')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToCell(row) : null;
  }

  async listCells(reviewId: string): Promise<ReviewCell[]> {
    const rows = await this.kbDb()
      .selectFrom('review_cells')
      .selectAll()
      .where('review_id', '=', reviewId)
      .execute();
    return rows.map(rowToCell);
  }

  async setCellStatus(
    id: string,
    status: CellStatus,
    error: string | null = null,
  ): Promise<ReviewCell | null> {
    const result = await this.kbDb()
      .updateTable('review_cells')
      .set({ status, error })
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return null;
    return this.getCellById(id);
  }

  /** Reset cells stuck in `streaming` to `pending` — startup recovery. */
  async recoverStaleStreaming(): Promise<number> {
    const result = await this.kbDb()
      .updateTable('review_cells')
      .set({ status: 'pending', updated_at: sql`now()` })
      .where('status', '=', 'streaming')
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }

  // --- Bulk -------------------------------------------------------------

  async getReviewSnapshot(reviewId: string): Promise<ReviewSnapshot | null> {
    const review = await this.getReview(reviewId);
    if (!review) return null;
    const [columns, documents, cells] = await Promise.all([
      this.listColumns(reviewId),
      this.listDocuments(reviewId),
      this.listCells(reviewId),
    ]);
    return { review, columns, documents, cells };
  }

  private kbDb(): Kysely<GridReviewDB> {
    return this.db as unknown as Kysely<GridReviewDB>;
  }
}

interface ReviewRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ColumnRow {
  id: string;
  review_id: string;
  title: string;
  prompt: string;
  format: CellFormat;
  position: number;
  created_at: Date;
  updated_at: Date;
}

interface DocumentRow {
  id: string;
  review_id: string;
  external_doc_id: string;
  name: string;
  mime_type: string | null;
  position: number;
  added_at: Date;
}

interface CellRow {
  id: string;
  review_id: string;
  column_id: string;
  review_document_id: string;
  status: CellStatus;
  value: string | null;
  citations: unknown[] | null;
  error: string | null;
  updated_at: Date;
}

function rowToReview(row: ReviewRow): Review {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToColumn(row: ColumnRow): ReviewColumn {
  return {
    id: row.id,
    reviewId: row.review_id,
    title: row.title,
    prompt: row.prompt,
    format: row.format,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDocument(row: DocumentRow): ReviewDocument {
  return {
    id: row.id,
    reviewId: row.review_id,
    externalDocId: row.external_doc_id,
    name: row.name,
    mimeType: row.mime_type,
    position: row.position,
    addedAt: row.added_at,
  };
}

function rowToCell(row: CellRow): ReviewCell {
  return {
    id: row.id,
    reviewId: row.review_id,
    columnId: row.column_id,
    reviewDocumentId: row.review_document_id,
    status: row.status,
    value: row.value,
    citations: row.citations,
    error: row.error,
    updatedAt: row.updated_at,
  };
}
