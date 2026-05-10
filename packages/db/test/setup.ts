import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Pool } from 'pg';
import type { Kysely } from 'kysely';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { createDb } from '../src/index.js';
import type { DB } from '../src/types.js';

// Match prod's Postgres major. psql-counsel-scus is on pg16 today; pin
// here so test/prod schema behavior never diverges silently.
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', 'migrations');

export interface TestDb {
  kysely: Kysely<DB>;
  pool: Pool;
  url: string;
  schema: string;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container: StartedTestContainer = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_DB: 'counsel',
      POSTGRES_USER: 'counsel',
      POSTGRES_PASSWORD: 'counsel',
    })
    .withExposedPorts(5432)
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://counsel:counsel@${host}:${port}/counsel`;
  const schema = 'counsel';

  await runner({
    databaseUrl: url,
    dir: migrationsDir,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    schema,
    createSchema: true,
    singleTransaction: true,
  });

  const pool = new Pool({
    connectionString: url,
    max: 5,
    // Set search_path on every new connection so Kysely query builder
    // resolves unqualified table names to the counsel schema.
    options: `-c search_path=${schema},public`,
  });

  const db = createDb({ pool, disableObservability: true });

  return {
    kysely: db.kysely,
    pool,
    url,
    schema,
    stop: async (): Promise<void> => {
      await db.close();
      await container.stop();
    },
  };
}
