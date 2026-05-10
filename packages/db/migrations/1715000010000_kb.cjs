// kb_documents + kb_chunks: pgvector + tsvector + pg_trgm hybrid retrieval.
// Replaces SQLite's vec0 + fts5 virtual tables with native PG indexes.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('kb_documents', {
    id: { type: 'text', primaryKey: true },
    name: { type: 'text', notNull: true },
    mime_type: { type: 'text', notNull: true },
    size: { type: 'bigint', notNull: true },
    markdown: { type: 'text', notNull: true },
    chunk_count: { type: 'integer', notNull: true, default: 0 },
    owner_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });
  pgm.sql('ALTER TABLE kb_documents RENAME CONSTRAINT kb_documents_pkey TO pk_kb_documents;');
  pgm.createTrigger('kb_documents', 'trg_kb_documents_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
  pgm.createIndex('kb_documents', 'owner_id', {
    name: 'ix_kb_documents_owner',
    where: 'deleted_at IS NULL',
  });
  pgm.createIndex('kb_documents', [{ name: 'created_at', sort: 'DESC' }], {
    name: 'ix_kb_documents_created',
    where: 'deleted_at IS NULL',
  });

  // Vector dim (1536) MUST match db_metadata.embedding_dim. Changing the
  // embedding model is a deliberate migration: re-embed all chunks, drop
  // the index, alter the column type, recreate the index, update metadata.
  pgm.sql(`
    CREATE TABLE kb_chunks (
      id           text NOT NULL,
      document_id  text NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
      chunk_index  integer NOT NULL,
      content      text NOT NULL,
      start_char   integer NOT NULL,
      end_char     integer NOT NULL,
      embedding    vector(1536) NOT NULL,
      content_tsv  tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
      created_at   timestamptz NOT NULL DEFAULT now(),
      deleted_at   timestamptz,
      CONSTRAINT pk_kb_chunks PRIMARY KEY (id)
    );
  `);

  pgm.createIndex('kb_chunks', 'document_id', {
    name: 'ix_kb_chunks_document',
    where: 'deleted_at IS NULL',
  });
  pgm.createIndex('kb_chunks', ['document_id', 'chunk_index'], {
    name: 'uq_kb_chunks_document_chunk_index',
    unique: true,
  });

  // HNSW over IVFFlat: no training step, modern pgvector default, handles
  // small per-matter indexes without IVFFlat's recall cliff at low N.
  // m=16, ef_construction=64 are pgvector's tuned defaults — bump
  // ef_construction to 128+ if recall@5 ever drops below acceptable.
  pgm.sql(`
    CREATE INDEX ix_kb_chunks_embedding_hnsw ON kb_chunks
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE deleted_at IS NULL;
  `);
  pgm.sql(`
    CREATE INDEX ix_kb_chunks_content_tsv ON kb_chunks
      USING gin (content_tsv)
      WHERE deleted_at IS NULL;
  `);
  pgm.sql(`
    CREATE INDEX ix_kb_chunks_content_trgm ON kb_chunks
      USING gin (content gin_trgm_ops)
      WHERE deleted_at IS NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('kb_chunks');
  pgm.dropTable('kb_documents');
};
