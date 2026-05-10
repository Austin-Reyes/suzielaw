// Migration files run via node-pg-migrate's runner — loaded with require(),
// so they must be plain CommonJS. Forward-only: down() is implemented for
// dev convenience but not exercised in prod (per locked migration policy).
//
// Constraint naming convention (rbl_shared style):
//   pk_<table>, uq_<table>_<col>, ix_<table>_<col>, ck_<table>_<name>,
//   fk_<table>_<col>_<reftable>

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // Extensions are server-wide regardless of search_path. Already enabled on
  // psql-counsel-scus via the azure.extensions parameter; idempotent locally.
  pgm.createExtension('vector', { ifNotExists: true });
  pgm.createExtension('uuid-ossp', { ifNotExists: true });
  pgm.createExtension('pgcrypto', { ifNotExists: true });
  pgm.createExtension('pg_trgm', { ifNotExists: true });
  pgm.createExtension('btree_gin', { ifNotExists: true });

  // Trigger function for auto-maintaining updated_at. Lives in the counsel
  // schema (the runner's createSchema:true + schema option puts us there).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // db_metadata: pinned configuration. Embedding model + dim live here so a
  // model swap is a deliberate migration, not a silent column-type mismatch.
  pgm.createTable('db_metadata', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'jsonb', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // rbl_shared naming convention: pk_<table>. node-pg-migrate auto-names PKs
  // <table>_pkey; rename to match.
  pgm.sql('ALTER TABLE db_metadata RENAME CONSTRAINT db_metadata_pkey TO pk_db_metadata;');

  pgm.createTrigger('db_metadata', 'trg_db_metadata_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  pgm.sql(`
    INSERT INTO db_metadata (key, value) VALUES
      ('schema_version',  '"1"'::jsonb),
      ('embedding_model', '"text-embedding-3-small"'::jsonb),
      ('embedding_dim',   '1536'::jsonb);
  `);

  // app_audit_log: HIPAA audit trail. Append-only — a follow-up migration
  // will REVOKE UPDATE/DELETE from the app role once pgaadauth principals
  // are wired in. Shape matches rbl_shared ADR 0008 verbatim.
  pgm.createTable('app_audit_log', {
    id: { type: 'text', primaryKey: true },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    actor_id: { type: 'text' },
    entity_type: { type: 'text', notNull: true },
    entity_id: { type: 'text' },
    action: { type: 'text', notNull: true },
    request_id: { type: 'text' },
    ip: { type: 'text' },
    route: { type: 'text' },
    reason: { type: 'text' },
  });
  pgm.sql('ALTER TABLE app_audit_log RENAME CONSTRAINT app_audit_log_pkey TO pk_app_audit_log;');

  pgm.createIndex('app_audit_log', [{ name: 'at', sort: 'DESC' }], {
    name: 'ix_app_audit_log_at',
  });
  pgm.createIndex('app_audit_log', ['actor_id', { name: 'at', sort: 'DESC' }], {
    name: 'ix_app_audit_log_actor_id',
    where: 'actor_id IS NOT NULL',
  });
  pgm.createIndex(
    'app_audit_log',
    ['entity_type', 'entity_id', { name: 'at', sort: 'DESC' }],
    { name: 'ix_app_audit_log_entity' },
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('app_audit_log');
  pgm.dropTable('db_metadata');
  pgm.sql('DROP FUNCTION IF EXISTS set_updated_at();');
  // Extensions deliberately not dropped — other schemas may depend on them.
};
