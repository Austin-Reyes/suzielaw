// matter_doc_index — host-app glue table that maps a (matter_id, file_id)
// pair to the kb_documents.id assigned when the matter doc was indexed
// into @counsel/kb. Per-matter RAG (cell runner, future matter chat) uses
// it to translate a workspace document reference into a KB document
// filter, and to drop the matching KB doc when the file is removed.
//
// Lives in the @counsel/db migration set rather than its own package
// because it's purely host-app glue — it joins workspaces, files, and kb
// entities that already exist in their own packages, and there's exactly
// one consumer (apps/counsel/src/matter-rag.ts).
//
// Composite PK (matter_id, file_id) — natural key, no surrogate id.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable(
    'matter_doc_index',
    {
      matter_id: { type: 'text', notNull: true },
      file_id: { type: 'text', notNull: true },
      kb_doc_id: { type: 'text', notNull: true },
      indexed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: { primaryKey: ['matter_id', 'file_id'] },
    },
  );
  pgm.sql(
    'ALTER TABLE matter_doc_index RENAME CONSTRAINT matter_doc_index_pkey TO pk_matter_doc_index;',
  );
  pgm.createIndex('matter_doc_index', 'matter_id', {
    name: 'ix_matter_doc_index_matter',
  });
  pgm.createIndex('matter_doc_index', 'kb_doc_id', {
    name: 'ix_matter_doc_index_kb_doc',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('matter_doc_index');
};
