// document_versions + document_heads — append-only version chains with a
// per-document head pointer.
//
// Source enum carries all 5 values from the start (upload | proposal |
// accept | reject | generated). The upstream SQLite package added 'generated'
// in a follow-up that required a table rebuild — Postgres CHECK constraints
// can be altered in place, but starting clean avoids the migration history
// having to mirror that.
//
// parent_id ON DELETE SET NULL: deleting an ancestor nulls its descendants'
// pointers rather than cascading, so a hypothetical future single-version
// delete doesn't silently destroy the descendant chain. For
// `deleteAllForDocument`, the store deletes heads first then versions
// (which then null each other harmlessly during the sweep).
//
// document_heads.current_version_id has the default ON DELETE RESTRICT —
// you can't delete a version while it's the live head; force the caller
// to repoint head first.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('document_versions', {
    id: { type: 'text', primaryKey: true },
    external_doc_id: { type: 'text', notNull: true },
    parent_id: {
      type: 'text',
      references: 'document_versions(id)',
      onDelete: 'SET NULL',
    },
    source: { type: 'text', notNull: true },
    storage_id: { type: 'text', notNull: true },
    byte_size: { type: 'bigint' },
    content_hash: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });
  pgm.sql(
    'ALTER TABLE document_versions RENAME CONSTRAINT document_versions_pkey TO pk_document_versions;',
  );
  pgm.sql(
    "ALTER TABLE document_versions ADD CONSTRAINT ck_document_versions_source CHECK (source IN ('upload', 'proposal', 'accept', 'reject', 'generated'));",
  );
  pgm.createIndex('document_versions', ['external_doc_id', 'created_at'], {
    name: 'ix_document_versions_doc',
    where: 'deleted_at IS NULL',
  });
  pgm.createIndex('document_versions', 'parent_id', {
    name: 'ix_document_versions_parent',
    where: 'deleted_at IS NULL',
  });

  pgm.createTable('document_heads', {
    external_doc_id: { type: 'text', primaryKey: true },
    current_version_id: {
      type: 'text',
      notNull: true,
      references: 'document_versions(id)',
      // Default RESTRICT — see migration header.
    },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql('ALTER TABLE document_heads RENAME CONSTRAINT document_heads_pkey TO pk_document_heads;');
  pgm.createTrigger('document_heads', 'trg_document_heads_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('document_heads');
  pgm.dropTable('document_versions');
};
