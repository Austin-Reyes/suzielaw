// audit_log — application-layer HIPAA Security Rule §164.312(b) audit trail.
// Append-only, PHI-minimized: opaque subjects + bounded JSON metadata only.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('audit_log', {
    id: { type: 'text', primaryKey: true },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    actor_email: { type: 'text', notNull: true },
    actor_name: { type: 'text' },
    event: { type: 'text', notNull: true },
    subject_type: { type: 'text' },
    subject_id: { type: 'text' },
    metadata: { type: 'jsonb' },
    ip_address: { type: 'text' },
    user_agent: { type: 'text' },
  });
  pgm.sql('ALTER TABLE audit_log RENAME CONSTRAINT audit_log_pkey TO pk_audit_log;');
  pgm.sql(
    'ALTER TABLE audit_log ADD CONSTRAINT ck_audit_log_metadata_size CHECK (pg_column_size(metadata) <= 1024);',
  );
  pgm.createIndex('audit_log', ['actor_email', { name: 'at', sort: 'DESC' }], {
    name: 'ix_audit_log_actor_at',
  });
  pgm.createIndex(
    'audit_log',
    ['subject_type', 'subject_id', { name: 'at', sort: 'DESC' }],
    {
      name: 'ix_audit_log_subject',
      where: 'subject_type IS NOT NULL',
    },
  );
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_log_block_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only';
    END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.createTrigger('audit_log', 'trg_audit_log_block_mutation', {
    when: 'BEFORE',
    operation: ['UPDATE', 'DELETE'],
    level: 'ROW',
    function: 'audit_log_block_mutation',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_audit_log_block_mutation ON audit_log;');
  pgm.sql('DROP FUNCTION IF EXISTS audit_log_block_mutation();');
  pgm.dropTable('audit_log');
};
