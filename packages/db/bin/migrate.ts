#!/usr/bin/env tsx
import { runner } from 'node-pg-migrate';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DefaultAzureCredential } from '@azure/identity';

loadDotenv();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', 'migrations');

type Direction = 'up' | 'down';
const arg = process.argv[2];
if (arg !== 'up' && arg !== 'down') {
  console.error('Usage: migrate.ts <up|down> [count]');
  process.exit(2);
}
const direction: Direction = arg;
const count = process.argv[3] ? Number.parseInt(process.argv[3], 10) : Infinity;

async function buildDatabaseUrl(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = required('PGHOST');
  const port = process.env.PGPORT ?? '5432';
  const db = required('PGDATABASE');
  const user = required('PGUSER');
  let password = process.env.PGPASSWORD;

  // AAD bootstrap: no password set means we're hitting Azure Postgres Flex.
  // Fetch a fresh token. node-pg-migrate creates a single connection so we
  // don't need the per-connection refresh that the app pool does.
  if (!password) {
    const cred = new DefaultAzureCredential();
    const tok = await cred.getToken('https://ossrdbms-aad.database.windows.net/.default');
    if (!tok) throw new Error('AAD token fetch returned null');
    password = tok.token;
  }

  // URL-encode the password — AAD tokens contain '+' and '/' which the URL
  // parser would otherwise mangle. (Same hazard as the alembic skill, only
  // the failure mode here is silent auth failure rather than a parser
  // exception.)
  const enc = encodeURIComponent;
  const sslmode = process.env.PGSSLMODE ?? 'require';
  return `postgres://${enc(user)}:${enc(password)}@${host}:${port}/${db}?sslmode=${sslmode}`;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const databaseUrl = await buildDatabaseUrl();
  const schema = process.env.PGSCHEMA ?? 'counsel';

  await runner({
    databaseUrl,
    dir: migrationsDir,
    migrationsTable: 'pgmigrations',
    direction,
    count,
    schema,
    createSchema: true,
    verbose: true,
    singleTransaction: true,
  });
}

main().catch((err: unknown) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
