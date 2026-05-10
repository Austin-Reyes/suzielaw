// workspaces / folders / workspace_documents — three-table tree of
// matter-document references. Document content lives elsewhere; this
// schema only stores the pointer + light metadata for cheap listing.
//
// Cascade behavior:
//   workspace -> folders, workspace_documents      ON DELETE CASCADE
//   folder    -> subfolders                         ON DELETE CASCADE (recursive)
//   folder    -> workspace_documents                ON DELETE SET NULL (orphan to root)
//
// archived_at vs deleted_at: archived = "hidden but recoverable" (user-facing),
// deleted = "soft-deleted, audit only" (rbl convention). Both are TIMESTAMPTZ NULL.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('workspaces', {
    id: { type: 'text', primaryKey: true },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    archived_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });
  pgm.sql('ALTER TABLE workspaces RENAME CONSTRAINT workspaces_pkey TO pk_workspaces;');
  pgm.createTrigger('workspaces', 'trg_workspaces_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
  pgm.createIndex('workspaces', [{ name: 'created_at', sort: 'DESC' }], {
    name: 'ix_workspaces_created',
    where: 'deleted_at IS NULL',
  });

  pgm.createTable('folders', {
    id: { type: 'text', primaryKey: true },
    workspace_id: {
      type: 'text',
      notNull: true,
      references: 'workspaces(id)',
      onDelete: 'CASCADE',
    },
    parent_folder_id: {
      type: 'text',
      references: 'folders(id)',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });
  pgm.sql('ALTER TABLE folders RENAME CONSTRAINT folders_pkey TO pk_folders;');
  pgm.createTrigger('folders', 'trg_folders_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
  pgm.createIndex('folders', 'workspace_id', {
    name: 'ix_folders_workspace',
    where: 'deleted_at IS NULL',
  });
  pgm.createIndex('folders', 'parent_folder_id', {
    name: 'ix_folders_parent',
    where: 'deleted_at IS NULL',
  });

  pgm.createTable('workspace_documents', {
    id: { type: 'text', primaryKey: true },
    workspace_id: {
      type: 'text',
      notNull: true,
      references: 'workspaces(id)',
      onDelete: 'CASCADE',
    },
    folder_id: {
      type: 'text',
      references: 'folders(id)',
      onDelete: 'SET NULL',
    },
    external_doc_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    mime_type: { type: 'text' },
    size: { type: 'bigint' },
    position: { type: 'integer', notNull: true, default: 0 },
    added_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });
  pgm.sql(
    'ALTER TABLE workspace_documents RENAME CONSTRAINT workspace_documents_pkey TO pk_workspace_documents;',
  );
  pgm.createIndex('workspace_documents', 'workspace_id', {
    name: 'ix_workspace_documents_workspace',
    where: 'deleted_at IS NULL',
  });
  pgm.createIndex('workspace_documents', 'folder_id', {
    name: 'ix_workspace_documents_folder',
    where: 'deleted_at IS NULL',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('workspace_documents');
  pgm.dropTable('folders');
  pgm.dropTable('workspaces');
};
