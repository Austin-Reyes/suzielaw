// workspace_documents.sha256 — per-matter content hash for dedup on
// re-upload. Set by the zip-ingest path; nullable because single-file
// uploads and pre-existing rows don't have one.
//
// Partial unique index (workspace_id, sha256) WHERE sha256 IS NOT NULL
// AND deleted_at IS NULL enforces "the same bytes can't be re-ingested
// into the same matter" at the DB level so the dedup is correct under
// concurrent uploads, not just best-effort in app code.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumn('workspace_documents', {
    sha256: { type: 'text' },
  });
  pgm.createIndex('workspace_documents', ['workspace_id', 'sha256'], {
    name: 'uq_workspace_documents_workspace_sha256',
    unique: true,
    where: 'sha256 IS NOT NULL AND deleted_at IS NULL',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropIndex('workspace_documents', ['workspace_id', 'sha256'], {
    name: 'uq_workspace_documents_workspace_sha256',
  });
  pgm.dropColumn('workspace_documents', 'sha256');
};
