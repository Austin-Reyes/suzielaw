import type { ColumnType, Generated } from 'kysely';

export type CellFormat = 'text' | 'short_text' | 'date' | 'yes_no' | 'bullets' | 'money';
export type CellStatus = 'pending' | 'streaming' | 'done' | 'error';

export interface Review {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewColumn {
  id: string;
  reviewId: string;
  title: string;
  prompt: string;
  format: CellFormat;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewDocument {
  id: string;
  reviewId: string;
  /** Opaque pointer into the host's doc store. */
  externalDocId: string;
  name: string;
  mimeType: string | null;
  position: number;
  addedAt: Date;
}

export interface ReviewCell {
  id: string;
  reviewId: string;
  columnId: string;
  reviewDocumentId: string;
  status: CellStatus;
  value: string | null;
  /** Decoded JSON Citation array. Surface change vs upstream (was raw JSON string). */
  citations: unknown[] | null;
  error: string | null;
  updatedAt: Date;
}

export interface ReviewSnapshot {
  review: Review;
  columns: ReviewColumn[];
  documents: ReviewDocument[];
  cells: ReviewCell[];
}

export interface CreateReviewInput {
  workspaceId: string;
  name: string;
  description?: string | null;
}

export interface UpdateReviewInput {
  name?: string;
  description?: string | null;
}

export interface AddColumnInput {
  reviewId: string;
  title: string;
  prompt: string;
  format?: CellFormat;
  position?: number;
}

export interface UpdateColumnInput {
  title?: string;
  prompt?: string;
  format?: CellFormat;
  position?: number;
}

export interface AddReviewDocumentInput {
  reviewId: string;
  externalDocId: string;
  name: string;
  mimeType?: string | null;
  position?: number;
}

export interface UpsertCellInput {
  reviewId: string;
  columnId: string;
  reviewDocumentId: string;
  status?: CellStatus;
  value?: string | null;
  citations?: unknown[] | null;
  error?: string | null;
}

// Kysely table types.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface ReviewsTable {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Timestamp | null;
}

export interface ReviewColumnsTable {
  id: string;
  review_id: string;
  title: string;
  prompt: string;
  format: Generated<CellFormat>;
  position: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ReviewDocumentsTable {
  id: string;
  review_id: string;
  external_doc_id: string;
  name: string;
  mime_type: string | null;
  position: Generated<number>;
  added_at: Generated<Date>;
}

export interface ReviewCellsTable {
  id: string;
  review_id: string;
  column_id: string;
  review_document_id: string;
  status: Generated<CellStatus>;
  value: string | null;
  citations: ColumnType<unknown[] | null, string | null, string | null>;
  error: string | null;
  updated_at: Generated<Date>;
}

export interface GridReviewDB {
  reviews: ReviewsTable;
  review_columns: ReviewColumnsTable;
  review_documents: ReviewDocumentsTable;
  review_cells: ReviewCellsTable;
}
