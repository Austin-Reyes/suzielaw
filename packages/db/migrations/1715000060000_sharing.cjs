// members — cross-subject sharing/membership grants. Subject is opaque
// (subject_type, subject_id) — no FK across packages, matching the loose
// coupling pattern used by chats.workspace_id and document_versions.external_doc_id.
// Hosts clean up explicitly via removeMembersFor when a subject is deleted.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('members', {
    id: { type: 'text', primaryKey: true },
    subject_type: { type: 'text', notNull: true },
    subject_id: { type: 'text', notNull: true },
    user_id: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true },
    granted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    granted_by: { type: 'text' },
  });
  pgm.sql('ALTER TABLE members RENAME CONSTRAINT members_pkey TO pk_members;');
  pgm.sql(
    "ALTER TABLE members ADD CONSTRAINT ck_members_role CHECK (role IN ('owner', 'editor', 'viewer'));",
  );
  pgm.addConstraint('members', 'uq_members_subject_user', {
    unique: ['subject_type', 'subject_id', 'user_id'],
  });
  pgm.createIndex('members', ['subject_type', 'subject_id'], { name: 'ix_members_subject' });
  pgm.createIndex('members', ['user_id', 'subject_type'], { name: 'ix_members_user' });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('members');
};
