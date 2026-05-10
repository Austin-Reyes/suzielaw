// workflows / workflow_hides / workflow_versions
//
// Single migration with all 4 SQLite migrations folded in (column_config,
// output_mode, versions table). practice_areas + column_config are JSONB
// (was TEXT-with-stringified-JSON in SQLite — surface change to typed
// arrays in @counsel/workflows).
//
// CHECK constraints enforce: workflows.source, workflows.output_mode,
// workflow_versions.reason at the schema level.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('workflows', {
    id: { type: 'text', primaryKey: true },
    source: { type: 'text', notNull: true },
    owner_id: { type: 'text' },
    name: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
    prompt: { type: 'text', notNull: true },
    practice_areas: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    column_config: { type: 'jsonb' },
    output_mode: { type: 'text', notNull: true, default: 'inline_chat' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    archived_at: { type: 'timestamptz' },
  });
  pgm.sql('ALTER TABLE workflows RENAME CONSTRAINT workflows_pkey TO pk_workflows;');
  pgm.sql(
    "ALTER TABLE workflows ADD CONSTRAINT ck_workflows_source CHECK (source IN ('system', 'user'));",
  );
  pgm.sql(
    "ALTER TABLE workflows ADD CONSTRAINT ck_workflows_output_mode CHECK (output_mode IN ('inline_chat', 'generate_docx', 'tabular_review'));",
  );
  pgm.createTrigger('workflows', 'trg_workflows_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
  pgm.createIndex('workflows', ['source', 'owner_id'], { name: 'ix_workflows_source_owner' });
  pgm.createIndex('workflows', [{ name: 'updated_at', sort: 'DESC' }], {
    name: 'ix_workflows_updated_at',
  });

  pgm.createTable(
    'workflow_hides',
    {
      workflow_id: {
        type: 'text',
        notNull: true,
        references: 'workflows(id)',
        onDelete: 'CASCADE',
      },
      owner_id: { type: 'text', notNull: true },
      hidden_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { constraints: { primaryKey: ['workflow_id', 'owner_id'] } },
  );
  pgm.sql('ALTER TABLE workflow_hides RENAME CONSTRAINT workflow_hides_pkey TO pk_workflow_hides;');
  pgm.createIndex('workflow_hides', 'owner_id', { name: 'ix_workflow_hides_owner' });

  pgm.createTable('workflow_versions', {
    id: { type: 'text', primaryKey: true },
    workflow_id: {
      type: 'text',
      notNull: true,
      references: 'workflows(id)',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
    prompt: { type: 'text', notNull: true },
    practice_areas: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    column_config: { type: 'jsonb' },
    output_mode: { type: 'text', notNull: true },
    captured_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    captured_by: { type: 'text' },
    reason: { type: 'text', notNull: true },
  });
  pgm.sql(
    'ALTER TABLE workflow_versions RENAME CONSTRAINT workflow_versions_pkey TO pk_workflow_versions;',
  );
  pgm.sql(
    "ALTER TABLE workflow_versions ADD CONSTRAINT ck_workflow_versions_reason CHECK (reason IN ('update', 'restore'));",
  );
  pgm.createIndex(
    'workflow_versions',
    ['workflow_id', { name: 'captured_at', sort: 'DESC' }],
    { name: 'ix_workflow_versions_workflow_time' },
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('workflow_versions');
  pgm.dropTable('workflow_hides');
  pgm.dropTable('workflows');
};
