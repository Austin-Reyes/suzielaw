// chats / chat_messages — append-only conversation history.
//
// workspace_id on chats is OPAQUE (no FK) by design — matches the
// loose-coupling pattern from the upstream package. Hosts that want
// workspace cascade should soft-delete chats explicitly when a workspace
// goes away.
//
// chat -> messages: ON DELETE CASCADE.
// tool_events + citations: JSONB (was TEXT-with-stringified-JSON in SQLite —
//   surface change documented in @counsel/chats README).

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('chats', {
    id: { type: 'text', primaryKey: true },
    workspace_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    persona_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });
  pgm.sql('ALTER TABLE chats RENAME CONSTRAINT chats_pkey TO pk_chats;');
  pgm.createTrigger('chats', 'trg_chats_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
  pgm.createIndex('chats', 'workspace_id', {
    name: 'ix_chats_workspace',
    where: 'deleted_at IS NULL',
  });
  pgm.createIndex('chats', [{ name: 'updated_at', sort: 'DESC' }], {
    name: 'ix_chats_updated',
    where: 'deleted_at IS NULL',
  });

  pgm.createTable('chat_messages', {
    id: { type: 'text', primaryKey: true },
    chat_id: {
      type: 'text',
      notNull: true,
      references: 'chats(id)',
      onDelete: 'CASCADE',
    },
    role: { type: 'text', notNull: true },
    content: { type: 'text', notNull: true },
    tool_events: { type: 'jsonb' },
    citations: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });
  pgm.sql('ALTER TABLE chat_messages RENAME CONSTRAINT chat_messages_pkey TO pk_chat_messages;');
  pgm.sql(
    "ALTER TABLE chat_messages ADD CONSTRAINT ck_chat_messages_role CHECK (role IN ('user', 'assistant'));",
  );
  pgm.createIndex('chat_messages', ['chat_id', 'created_at'], {
    name: 'ix_chat_messages_chat',
    where: 'deleted_at IS NULL',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('chat_messages');
  pgm.dropTable('chats');
};
