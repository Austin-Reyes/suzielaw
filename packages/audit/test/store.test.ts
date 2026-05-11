import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { AuditStore } from '../src/store.js';
import { startAuditTestEnv, type AuditTestEnv } from './setup.js';

describe('@counsel/audit — AuditStore', () => {
  let env: AuditTestEnv;
  let store: AuditStore;

  beforeAll(async () => {
    env = await startAuditTestEnv();
    store = new AuditStore({ db: env.kysely });
  });

  afterAll(async () => {
    await env?.stop();
  });

  it('appends an audit row with the expected shape', async () => {
    const ok = await store.log({
      actorEmail: 'austin@reyeslaw.com',
      actorName: 'Austin Reyes',
      event: 'matter.open',
      subjectType: 'matter',
      subjectId: 'm-1',
      metadata: { source: 'test' },
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    });

    expect(ok).toBe(true);
    const rows = await store.query({ actorEmail: 'austin@reyeslaw.com', event: 'matter.open' });
    expect(rows[0]).toMatchObject({
      actorEmail: 'austin@reyeslaw.com',
      actorName: 'Austin Reyes',
      event: 'matter.open',
      subjectType: 'matter',
      subjectId: 'm-1',
      metadata: { source: 'test' },
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    });
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]?.at).toBeInstanceOf(Date);
  });

  it('rejects UPDATE with the append-only trigger', async () => {
    await expect(
      sql`UPDATE audit_log SET event = 'auth.logout' WHERE subject_id = 'm-1'`.execute(env.kysely),
    ).rejects.toThrow(/audit_log is append-only/);
  });

  it('rejects DELETE with the append-only trigger', async () => {
    await expect(
      sql`DELETE FROM audit_log WHERE subject_id = 'm-1'`.execute(env.kysely),
    ).rejects.toThrow(/audit_log is append-only/);
  });

  it('rejects oversize metadata with the CHECK constraint', async () => {
    await expect(
      sql`
        INSERT INTO audit_log (id, actor_email, event, metadata)
        VALUES (
          '01900000-0000-7000-8000-000000000099',
          'austin@reyeslaw.com',
          'matter.open',
          jsonb_build_object('x', repeat('x', 3000))
        )
      `.execute(env.kysely),
    ).rejects.toThrow(/ck_audit_log_metadata_size|check constraint/i);
  });

  it('filters by actor, event, and time window in descending time order', async () => {
    const scoped = new AuditStore({
      db: env.kysely,
      idFactory: (() => {
        let i = 0;
        return () => `01900000-0000-7000-8000-${String(++i).padStart(12, '0')}`;
      })(),
    });

    await scoped.log({ actorEmail: 'filter@example.com', event: 'file.upload' });
    await new Promise((r) => setTimeout(r, 10));
    const since = new Date();
    await new Promise((r) => setTimeout(r, 10));
    await scoped.log({ actorEmail: 'filter@example.com', event: 'matter.open' });
    await new Promise((r) => setTimeout(r, 10));
    await scoped.log({ actorEmail: 'filter@example.com', event: 'matter.open' });
    const until = new Date();
    await scoped.log({ actorEmail: 'other@example.com', event: 'matter.open' });

    const rows = await store.query({
      actorEmail: 'filter@example.com',
      event: 'matter.open',
      since,
      until,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]!.at.getTime()).toBeGreaterThanOrEqual(rows[1]!.at.getTime());
    expect(rows.every((r) => r.actorEmail === 'filter@example.com')).toBe(true);
    expect(rows.every((r) => r.event === 'matter.open')).toBe(true);
  });

  it('store.log returns false instead of throwing on failure', async () => {
    const duplicate = new AuditStore({
      db: env.kysely,
      idFactory: () => '01900000-0000-7000-8000-000000000123',
    });
    expect(await duplicate.log({ actorEmail: 'dup@example.com', event: 'auth.login' })).toBe(true);
    await expect(
      duplicate.log({ actorEmail: 'dup@example.com', event: 'auth.login' }),
    ).resolves.toBe(false);
  });
});
