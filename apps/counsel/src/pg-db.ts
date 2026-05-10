import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import {
  createAadPool,
  createStaticPool,
  createDb as createCounselDb,
  type DbHandle,
} from '@counsel/db';
import type { KbDB } from '@counsel/kb';
import type { WorkspacesDB } from '@counsel/workspaces';
import type { ChatsDB } from '@counsel/chats';
import type { DocumentVersionsDB } from '@counsel/document-versions';
import type { ModelSettingsDB } from '@counsel/model-settings';
import type { SharingDB } from '@counsel/sharing';
import type { PersonasDB } from '@counsel/personas';
import type { GridReviewDB } from '@counsel/grid-review';
import type { WorkflowsDB } from '@counsel/workflows';
import type { MatterDocIndexDB } from './matter-rag.js';
import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { KnowledgeBaseStore, createOpenAIEmbedder } from '@counsel/kb';
import { WorkspacesStore } from '@counsel/workspaces';
import { ChatsStore } from '@counsel/chats';
import { DocumentVersionsStore } from '@counsel/document-versions';
import { ModelSettingsStore } from '@counsel/model-settings';
import { MembersStore } from '@counsel/sharing';
import { PersonaStore } from '@counsel/personas';
import { ReviewsStore } from '@counsel/grid-review';
import { WorkflowsStore } from '@counsel/workflows';

import { config } from './config.js';

/**
 * Composed app DB type — every @counsel/* table union'd. Pass
 * `Kysely<AppDB>` to any @counsel/* store; each one narrows internally
 * to its slice via its own Kysely<TDB extends ScopedDB> generic.
 */
export type AppDB = KbDB &
  WorkspacesDB &
  ChatsDB &
  DocumentVersionsDB &
  ModelSettingsDB &
  SharingDB &
  PersonasDB &
  GridReviewDB &
  WorkflowsDB &
  MatterDocIndexDB;

export interface CounselDbHandle {
  kysely: Kysely<AppDB>;
  pool: Pool;
  stores: {
    kb: KnowledgeBaseStore;
    workspaces: WorkspacesStore;
    chats: ChatsStore;
    documentVersions: DocumentVersionsStore;
    modelSettings: ModelSettingsStore;
    members: MembersStore;
    personas: PersonaStore;
    reviews: ReviewsStore;
    workflows: WorkflowsStore;
  };
  close: () => Promise<void>;
}

let cached: Promise<CounselDbHandle> | null = null;

/**
 * Lazy-initialize the @counsel/* Postgres handle on first call. Subsequent
 * calls return the same Promise — call sites can await this from anywhere
 * without coordinating boot order.
 *
 * The first call:
 *  1. Constructs a Pool (AAD when PGUSER set + no PGPASSWORD; static
 *     password otherwise — covers Azure prod and local docker postgres).
 *  2. Runs migrations against schema `counsel`.
 *  3. Sets `search_path` for the runtime Pool so unqualified Kysely
 *     queries resolve into `counsel.*`.
 *  4. Constructs every @counsel/* store and returns the handle.
 */
export function bootstrapCounselDb(): Promise<CounselDbHandle> {
  if (cached) return cached;
  cached = doBootstrap().catch((err) => {
    cached = null; // allow retry on next call
    throw err;
  });
  return cached;
}

async function doBootstrap(): Promise<CounselDbHandle> {
  const host = required('PGHOST');
  const database = required('PGDATABASE');
  const user = required('PGUSER');
  const password = process.env.PGPASSWORD;
  const port = process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432;
  const schema = process.env.PGSCHEMA ?? 'counsel';
  const sslmode = process.env.PGSSLMODE ?? (password ? 'disable' : 'require');

  // Run migrations FIRST — uses a one-shot connection, doesn't enter the
  // app pool. AAD path: pre-fetch a token and stuff it into PGPASSWORD on
  // process.env so node-pg-migrate's databaseUrl picks it up.
  await runMigrations({ host, database, user, password, port, schema, sslmode });

  const sslConfig = sslmode === 'disable' ? false : { rejectUnauthorized: false };
  const runtimePool = password
    ? createStaticPool({
        host,
        database,
        user,
        password,
        port,
        ssl: sslConfig,
        applicationName: 'counsel-api',
      })
    : createAadPool({
        host,
        database,
        user,
        port,
        ssl: sslConfig === false ? undefined : sslConfig,
        applicationName: 'counsel-api',
      });

  // Set search_path on every checkout so unqualified Kysely queries land
  // in the counsel schema. pg fires 'connect' once per new connection.
  runtimePool.on('connect', (client) => {
    void client.query(`SET search_path TO ${schema}, public`);
  });

  const dbHandle: DbHandle = createCounselDb({ pool: runtimePool });
  const kysely = dbHandle.kysely as unknown as Kysely<AppDB>;

  const embedder = createOpenAIEmbedder({
    baseUrl: config.kb.embeddingBaseUrl,
    apiKey: config.kb.embeddingApiKey,
    model: config.kb.embeddingModel,
    dim: config.kb.embeddingDim,
  });

  const stores = {
    kb: new KnowledgeBaseStore({
      db: kysely,
      embedder,
      // Tighter chunks than upstream defaults; matter docs are heading-
      // organized contracts where smaller chunks focus retrieval.
      chunker: { targetSize: 1000, overlap: 150, maxSize: 1600 },
    }),
    workspaces: new WorkspacesStore({ db: kysely }),
    chats: new ChatsStore({ db: kysely }),
    documentVersions: new DocumentVersionsStore({ db: kysely }),
    modelSettings: new ModelSettingsStore({
      db: kysely,
      envRegistry: config.modelAgents,
    }),
    members: new MembersStore({ db: kysely }),
    personas: new PersonaStore({ db: kysely }),
    reviews: new ReviewsStore({ db: kysely }),
    workflows: new WorkflowsStore({ db: kysely }),
  } as const;

  return {
    kysely,
    pool: runtimePool,
    stores,
    close: dbHandle.close,
  };
}

interface MigrateOpts {
  host: string;
  database: string;
  user: string;
  password: string | undefined;
  port: number;
  schema: string;
  sslmode: string;
}

async function runMigrations(opts: MigrateOpts): Promise<void> {
  let password = opts.password;
  if (!password) {
    // AAD bootstrap for migrations: fetch a token before runner builds its
    // single-use connection. (The app pool refreshes per-connection at
    // runtime; this one-shot doesn't need that infra.)
    const { DefaultAzureCredential } = await import('@azure/identity');
    const cred = new DefaultAzureCredential();
    const tok = await cred.getToken('https://ossrdbms-aad.database.windows.net/.default');
    if (!tok) throw new Error('AAD token fetch returned null for Postgres migrations');
    password = tok.token;
  }
  const enc = encodeURIComponent;
  const url = `postgres://${enc(opts.user)}:${enc(password)}@${opts.host}:${opts.port}/${opts.database}?sslmode=${opts.sslmode}`;

  // Migrations live in @counsel/db. Resolve via require.resolve-style
  // path math: this file is at app/apps/counsel/src/pg-db.ts; migrations
  // are at app/packages/db/migrations/.
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = resolve(here, '..', '..', '..', 'packages', 'db', 'migrations');

  // schema accepts an array — the first entry is the schema migrations
  // run in, the rest become part of search_path. Including 'public' is
  // required on Azure Postgres Flex because:
  //   1. CREATE EXTENSION is restricted to azure_pg_admin members AND
  //      Azure refuses ALTER EXTENSION ... SET SCHEMA, so extensions
  //      stay in 'public' regardless of where the app schema lives.
  //   2. Migrations reference type `vector` (from pgvector) without a
  //      schema qualifier; without 'public' on search_path the migration
  //      fails with `type "vector" does not exist`.
  await runner({
    databaseUrl: url,
    dir: migrationsDir,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    schema: [opts.schema, 'public'],
    createSchema: true,
    singleTransaction: true,
    verbose: process.env.PGMIGRATE_VERBOSE === 'true',
  });
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
