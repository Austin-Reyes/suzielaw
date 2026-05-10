// personas — user-created agent identities. Owned by user_id; the
// store filters every read by owner_id.
// personas_seeded — bookkeeping for "did we copy the file-based built-ins
// into this user's table yet?" One row per owner, set once on first login.
//
// allowed_tools / blocked_tools: JSONB arrays of tool name strings.
// (Was TEXT-storing-stringified-JSON in SQLite — JSON.stringify on insert
// per the @counsel/chats pattern.)

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('personas', {
    id: { type: 'text', primaryKey: true },
    owner_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
    avatar: { type: 'text' },
    model: { type: 'text' },
    allowed_tools: { type: 'jsonb' },
    blocked_tools: { type: 'jsonb' },
    system_prompt: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });
  pgm.sql('ALTER TABLE personas RENAME CONSTRAINT personas_pkey TO pk_personas;');
  pgm.createTrigger('personas', 'trg_personas_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
  pgm.createIndex('personas', 'owner_id', {
    name: 'ix_personas_owner',
    where: 'deleted_at IS NULL',
  });
  // Trigram index on name for fast substring search via ILIKE.
  pgm.sql(
    "CREATE INDEX ix_personas_name_trgm ON personas USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL;",
  );

  pgm.createTable('personas_seeded', {
    owner_id: { type: 'text', primaryKey: true },
    seeded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql('ALTER TABLE personas_seeded RENAME CONSTRAINT personas_seeded_pkey TO pk_personas_seeded;');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('personas_seeded');
  pgm.dropTable('personas');
};
