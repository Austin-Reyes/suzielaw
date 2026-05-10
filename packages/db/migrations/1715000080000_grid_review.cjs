// Tabular document review:
//   reviews -> review_columns (questions/extractions, ordered)
//             -> review_documents (rows in the grid)
//             -> review_cells (N×M output, sparse)
//
// workspace_id on reviews is OPAQUE (no cross-package FK) per the
// loose-coupling pattern. Within a review, deletes cascade.
//
// citations: JSONB (was TEXT-storing-JSON in SQLite — surface change
// to unknown[] | null in @counsel/grid-review).

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('reviews', {
    id: { type: 'text', primaryKey: true },
    workspace_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });
  pgm.sql('ALTER TABLE reviews RENAME CONSTRAINT reviews_pkey TO pk_reviews;');
  pgm.createTrigger('reviews', 'trg_reviews_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
  pgm.createIndex('reviews', 'workspace_id', {
    name: 'ix_reviews_workspace',
    where: 'deleted_at IS NULL',
  });

  pgm.createTable('review_columns', {
    id: { type: 'text', primaryKey: true },
    review_id: {
      type: 'text',
      notNull: true,
      references: 'reviews(id)',
      onDelete: 'CASCADE',
    },
    title: { type: 'text', notNull: true },
    prompt: { type: 'text', notNull: true },
    format: { type: 'text', notNull: true, default: 'text' },
    position: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql('ALTER TABLE review_columns RENAME CONSTRAINT review_columns_pkey TO pk_review_columns;');
  pgm.sql(
    "ALTER TABLE review_columns ADD CONSTRAINT ck_review_columns_format CHECK (format IN ('text', 'short_text', 'date', 'yes_no', 'bullets', 'money'));",
  );
  pgm.createTrigger('review_columns', 'trg_review_columns_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
  pgm.createIndex('review_columns', ['review_id', 'position'], { name: 'ix_review_columns_review' });

  pgm.createTable('review_documents', {
    id: { type: 'text', primaryKey: true },
    review_id: {
      type: 'text',
      notNull: true,
      references: 'reviews(id)',
      onDelete: 'CASCADE',
    },
    external_doc_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    mime_type: { type: 'text' },
    position: { type: 'integer', notNull: true, default: 0 },
    added_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(
    'ALTER TABLE review_documents RENAME CONSTRAINT review_documents_pkey TO pk_review_documents;',
  );
  pgm.addConstraint('review_documents', 'uq_review_documents_review_external', {
    unique: ['review_id', 'external_doc_id'],
  });
  pgm.createIndex('review_documents', ['review_id', 'position'], {
    name: 'ix_review_documents_review',
  });

  pgm.createTable('review_cells', {
    id: { type: 'text', primaryKey: true },
    review_id: {
      type: 'text',
      notNull: true,
      references: 'reviews(id)',
      onDelete: 'CASCADE',
    },
    column_id: {
      type: 'text',
      notNull: true,
      references: 'review_columns(id)',
      onDelete: 'CASCADE',
    },
    review_document_id: {
      type: 'text',
      notNull: true,
      references: 'review_documents(id)',
      onDelete: 'CASCADE',
    },
    status: { type: 'text', notNull: true, default: 'pending' },
    value: { type: 'text' },
    citations: { type: 'jsonb' },
    error: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql('ALTER TABLE review_cells RENAME CONSTRAINT review_cells_pkey TO pk_review_cells;');
  pgm.sql(
    "ALTER TABLE review_cells ADD CONSTRAINT ck_review_cells_status CHECK (status IN ('pending', 'streaming', 'done', 'error'));",
  );
  pgm.addConstraint('review_cells', 'uq_review_cells_column_doc', {
    unique: ['column_id', 'review_document_id'],
  });
  pgm.createIndex('review_cells', 'review_id', { name: 'ix_review_cells_review' });
  pgm.createTrigger('review_cells', 'trg_review_cells_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('review_cells');
  pgm.dropTable('review_documents');
  pgm.dropTable('review_columns');
  pgm.dropTable('reviews');
};
