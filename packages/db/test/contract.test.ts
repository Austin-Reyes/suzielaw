import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { startTestDb, type TestDb } from './setup.js';
import { withRequestContext, getRequestContext, requireRequestContext } from '../src/requestContext.js';

describe('@counsel/db — schema bootstrap', () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await startTestDb();
  });
  afterAll(async () => {
    await tdb?.stop();
  });

  it('creates the counsel schema', async () => {
    const r = await sql<{ schema_name: string }>`
      SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'counsel'
    `.execute(tdb.kysely);
    expect(r.rows.length).toBe(1);
  });

  it('enables vector + pg_trgm + pgcrypto extensions', async () => {
    const r = await sql<{ extname: string }>`
      SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm', 'pgcrypto')
    `.execute(tdb.kysely);
    expect(r.rows.map((x) => x.extname).sort()).toEqual(['pg_trgm', 'pgcrypto', 'vector']);
  });

  it('seeds db_metadata with embedding model + dim', async () => {
    const rows = await tdb.kysely
      .selectFrom('db_metadata')
      .selectAll()
      .where('key', 'in', ['embedding_model', 'embedding_dim'])
      .execute();
    expect(rows.length).toBe(2);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.embedding_dim).toBe(1536);
    expect(byKey.embedding_model).toBe('text-embedding-3-small');
  });

  it('updated_at trigger fires on db_metadata UPDATE', async () => {
    const before = await tdb.kysely
      .selectFrom('db_metadata')
      .select('updated_at')
      .where('key', '=', 'schema_version')
      .executeTakeFirstOrThrow();

    await new Promise((r) => setTimeout(r, 50));

    await sql`
      UPDATE db_metadata SET value = '"1"'::jsonb WHERE key = 'schema_version'
    `.execute(tdb.kysely);

    const after = await tdb.kysely
      .selectFrom('db_metadata')
      .select('updated_at')
      .where('key', '=', 'schema_version')
      .executeTakeFirstOrThrow();

    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());
  });

  it('app_audit_log accepts inserts', async () => {
    await tdb.kysely
      .insertInto('app_audit_log')
      .values({
        id: '01900000-0000-7000-8000-000000000001',
        actor_id: 'austin@reyeslaw.com',
        entity_type: 'matter',
        entity_id: 'm-1',
        action: 'read',
        request_id: 'req-1',
        ip: '127.0.0.1',
        route: 'GET /api/matters/m-1',
        reason: null,
      })
      .execute();

    const rows = await tdb.kysely.selectFrom('app_audit_log').selectAll().execute();
    expect(rows.length).toBe(1);
    expect(rows[0]?.actor_id).toBe('austin@reyeslaw.com');
  });
});

describe('@counsel/db — requestContext ALS', () => {
  it('isolates context between concurrent calls', async () => {
    const seen: Array<string | null> = [];
    await Promise.all([
      withRequestContext(
        { actorId: 'a', requestId: 'r1', ip: null, route: null, reason: null },
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          seen.push(getRequestContext()?.actorId ?? null);
        },
      ),
      withRequestContext(
        { actorId: 'b', requestId: 'r2', ip: null, route: null, reason: null },
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          seen.push(getRequestContext()?.actorId ?? null);
        },
      ),
    ]);
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('requireRequestContext throws outside scope', () => {
    expect(() => requireRequestContext()).toThrow(/RequestContext/);
  });
});
