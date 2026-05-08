import { openDb, type DatabaseInstance, type Migration } from '@teamsuzie/db-sqlite';
import { KB_MIGRATIONS } from '@teamsuzie/kb';
import { MODEL_SETTINGS_MIGRATIONS } from '@teamsuzie/model-settings';
import { PERSONAS_MIGRATIONS } from '@teamsuzie/personas';
import { WORKSPACES_MIGRATIONS } from '@teamsuzie/workspaces';
import { REVIEWS_MIGRATIONS } from '@teamsuzie/grid-review';
import { CHATS_MIGRATIONS } from '@teamsuzie/chats';
import { WORKFLOWS_MIGRATIONS } from '@teamsuzie/workflows';
import { DOCUMENT_VERSIONS_MIGRATIONS } from '@teamsuzie/document-versions';
import { SHARING_MIGRATIONS } from '@teamsuzie/sharing';
import { HOSTED_DEMO_MIGRATIONS } from '@teamsuzie/hosted-demo';
import { config } from './config.js';

const migrations: Migration[] = [
  {
    name: '20260101_create_user_prompts',
    up: `
      CREATE TABLE IF NOT EXISTS user_prompts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        practice_areas TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_user_prompts_created_at ON user_prompts(created_at DESC);
    `,
  },
  ...PERSONAS_MIGRATIONS,
  ...KB_MIGRATIONS,
  ...MODEL_SETTINGS_MIGRATIONS,
  ...WORKSPACES_MIGRATIONS,
  ...REVIEWS_MIGRATIONS,
  ...CHATS_MIGRATIONS,
  ...WORKFLOWS_MIGRATIONS,
  ...DOCUMENT_VERSIONS_MIGRATIONS,
  ...SHARING_MIGRATIONS,
  ...HOSTED_DEMO_MIGRATIONS,
  {
    // Maps a (matter_id, file_id) pair to the kb_documents.id assigned when
    // the file was indexed. Used by the cell runner + (future) matter chat
    // to translate workspace-document references into KB document filters.
    name: '20260502_create_matter_doc_index',
    up: `
      CREATE TABLE IF NOT EXISTS matter_doc_index (
        matter_id   TEXT NOT NULL,
        file_id     TEXT NOT NULL,
        kb_doc_id   TEXT NOT NULL,
        indexed_at  INTEGER NOT NULL,
        PRIMARY KEY (matter_id, file_id)
      );
      CREATE INDEX IF NOT EXISTS idx_matter_doc_index_matter
        ON matter_doc_index(matter_id);
      CREATE INDEX IF NOT EXISTS idx_matter_doc_index_kb
        ON matter_doc_index(kb_doc_id);
    `,
  },
];

export const db: DatabaseInstance = openDb({
  path: config.db.path,
  migrations,
});
