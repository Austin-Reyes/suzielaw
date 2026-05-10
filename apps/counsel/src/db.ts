import { openDb, type DatabaseInstance, type Migration } from '@teamsuzie/db-sqlite';
import { PERSONAS_MIGRATIONS } from '@teamsuzie/personas';
import { HOSTED_DEMO_MIGRATIONS } from '@teamsuzie/hosted-demo';
import { config } from './config.js';

/**
 * Legacy SQLite singleton — surviving consumers after the @counsel/*
 * Postgres migration are:
 *   1. PersonaRegistry (filesystem + DB merge stays upstream — see the
 *      handoff "Open questions" decision).
 *   2. TokenBudgetStore from @teamsuzie/hosted-demo (token-metered fetch
 *      for cloud BYOK; sqlite is fine for per-user counters).
 *
 * Every other store has been ported to @counsel/* under
 * `bootstrapCounselDb()` (see ./pg-db.ts). The migrations imported
 * here are scoped to those two surviving consumers.
 */
const migrations: Migration[] = [
  ...PERSONAS_MIGRATIONS,
  ...HOSTED_DEMO_MIGRATIONS,
];

export const db: DatabaseInstance = openDb({
  path: config.db.path,
  migrations,
});
