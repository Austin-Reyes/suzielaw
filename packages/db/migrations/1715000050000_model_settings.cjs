// model_settings + provider_keys — per-user, per-model overrides for local
// agent endpoints, and per-user BYOK keys for cloud providers.
//
// Composite PKs (owner_id, model_id) and (owner_id, provider_id). No
// surrogate ids — the natural key is unique.
//
// API keys are stored plaintext at the column level and rely on Postgres
// at-rest encryption (CMK on Azure Postgres Flex) + the schema's access
// control for confidentiality. Considered pgcrypto column-level encryption
// — deferred for pilot because the threat model that justifies it (DBA
// reads disk via point-in-time backup) is not the threat we're defending
// against; we're defending against losing the database. See TODO.md
// "Operational gotchas".

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable(
    'model_settings',
    {
      owner_id: { type: 'text', notNull: true },
      model_id: { type: 'text', notNull: true },
      base_url: { type: 'text', notNull: true },
      api_key: { type: 'text' },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: { primaryKey: ['owner_id', 'model_id'] },
    },
  );
  pgm.sql('ALTER TABLE model_settings RENAME CONSTRAINT model_settings_pkey TO pk_model_settings;');

  pgm.createTrigger('model_settings', 'trg_model_settings_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  pgm.createTable(
    'provider_keys',
    {
      owner_id: { type: 'text', notNull: true },
      provider_id: { type: 'text', notNull: true },
      api_key: { type: 'text', notNull: true },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: { primaryKey: ['owner_id', 'provider_id'] },
    },
  );
  pgm.sql('ALTER TABLE provider_keys RENAME CONSTRAINT provider_keys_pkey TO pk_provider_keys;');
  pgm.createTrigger('provider_keys', 'trg_provider_keys_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('provider_keys');
  pgm.dropTable('model_settings');
};
