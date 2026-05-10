import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import type { KbDB } from '../src/types.js';
import type { Embedder } from '../src/embedder.js';

const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
const here = dirname(fileURLToPath(import.meta.url));
// Migrations live in @counsel/db.
const migrationsDir = resolve(here, '..', '..', 'db', 'migrations');

export interface KbTestEnv {
  kysely: Kysely<KbDB>;
  pool: Pool;
  embedder: Embedder;
  stop: () => Promise<void>;
}

export async function startKbTestEnv(opts: { dim?: number } = {}): Promise<KbTestEnv> {
  const dim = opts.dim ?? 1536;

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

  const kysely = new Kysely<KbDB>({ dialect: new PostgresDialect({ pool }) });

  return {
    kysely,
    pool,
    embedder: makeFakeEmbedder(dim),
    stop: async (): Promise<void> => {
      await kysely.destroy();
      await container.stop();
    },
  };
}

/**
 * Deterministic in-process embedder. Hashes each input into a fixed-dim
 * unit-normalized vector. Two identical strings → identical vectors;
 * "cat" and "dog" → very different vectors. Good enough for behavioral
 * tests without paying real OpenAI calls.
 */
export function makeFakeEmbedder(dim: number): Embedder {
  return {
    model: 'fake-deterministic',
    dim,
    embed: async (inputs: string[]): Promise<number[][]> => {
      return inputs.map((s) => embedOne(s, dim));
    },
  };
}

function embedOne(s: string, dim: number): number[] {
  // Simple feature hash — each token contributes to one slot.
  const v = new Array<number>(dim).fill(0);
  const tokens = (s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  for (const t of tokens) {
    const slot = hash32(t) % dim;
    v[slot] = (v[slot] ?? 0) + 1;
    // Spread a little to neighbors so cosine isn't all-or-nothing.
    v[(slot + 1) % dim] = (v[(slot + 1) % dim] ?? 0) + 0.5;
  }
  // Unit-normalize so cosine is well-behaved.
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
