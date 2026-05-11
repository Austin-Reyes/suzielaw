import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import type { AuditDB } from '../src/types.js';

const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', '..', 'db', 'migrations');

export interface AuditTestEnv {
  kysely: Kysely<AuditDB>;
  pool: Pool;
  stop: () => Promise<void>;
}

export async function startAuditTestEnv(): Promise<AuditTestEnv> {
  const container: StartedTestContainer = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_DB: 'counsel',
      POSTGRES_USER: 'counsel',
      POSTGRES_PASSWORD: 'counsel',
    })
    .withExposedPorts(5432)
    .withStartupTimeout(120_000)
    .start();

  const url = `postgres://counsel:counsel@${container.getHost()}:${container.getMappedPort(5432)}/counsel`;

  await runner({
    databaseUrl: url,
    dir: migrationsDir,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    schema: 'counsel',
    createSchema: true,
    singleTransaction: true,
  });

  const pool = new Pool({
    connectionString: url,
    max: 5,
    options: '-c search_path=counsel,public',
  });
  const kysely = new Kysely<AuditDB>({ dialect: new PostgresDialect({ pool }) });

  return {
    kysely,
    pool,
    stop: async (): Promise<void> => {
      await kysely.destroy();
      await container.stop();
    },
  };
}
