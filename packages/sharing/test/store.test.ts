import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { MembersStore } from '../src/store.js';
import { startShTestEnv, type ShTestEnv } from './setup.js';

describe('@counsel/sharing — MembersStore', () => {
  let env: ShTestEnv;
  let store: MembersStore;

  beforeAll(async () => {
    env = await startShTestEnv();
    store = new MembersStore({ db: env.kysely });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('addMember inserts a new row', async () => {
    const m = await store.addMember({
      subjectType: 'matter',
      subjectId: 'm-1',
      userId: 'austin@reyeslaw.com',
      role: 'editor',
      grantedBy: 'admin',
    });
    expect(m.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.role).toBe('editor');
    expect(m.grantedBy).toBe('admin');
  });

  it('addMember on existing (subject, user) upserts role + bumps granted_at', async () => {
    const m1 = await store.addMember({
      subjectType: 'matter',
      subjectId: 'm-2',
      userId: 'avi',
      role: 'viewer',
    });
    await new Promise((r) => setTimeout(r, 10));
    const m2 = await store.addMember({
      subjectType: 'matter',
      subjectId: 'm-2',
      userId: 'avi',
      role: 'editor',
      grantedBy: 'austin',
    });
    // Same id (upsert preserves the row).
    expect(m2.id).toBe(m1.id);
    expect(m2.role).toBe('editor');
    expect(m2.grantedBy).toBe('austin');
    expect(m2.grantedAt.getTime()).toBeGreaterThan(m1.grantedAt.getTime());
  });

  it('listMembersFor returns rows ordered by granted_at asc', async () => {
    await store.addMember({ subjectType: 'r', subjectId: 'r-1', userId: 'u1', role: 'owner' });
    await new Promise((r) => setTimeout(r, 5));
    await store.addMember({ subjectType: 'r', subjectId: 'r-1', userId: 'u2', role: 'editor' });
    await new Promise((r) => setTimeout(r, 5));
    await store.addMember({ subjectType: 'r', subjectId: 'r-1', userId: 'u3', role: 'viewer' });

    const list = await store.listMembersFor({ type: 'r', id: 'r-1' });
    expect(list.map((m) => m.userId)).toEqual(['u1', 'u2', 'u3']);
  });

  it('listSubjectsFor returns subjects of one type for a user, newest first', async () => {
    await store.addMember({ subjectType: 'matter', subjectId: 'A', userId: 'k', role: 'viewer' });
    await new Promise((r) => setTimeout(r, 5));
    await store.addMember({ subjectType: 'matter', subjectId: 'B', userId: 'k', role: 'editor' });
    await store.addMember({ subjectType: 'review', subjectId: 'rev-1', userId: 'k', role: 'editor' });

    const matters = await store.listSubjectsFor('k', 'matter');
    expect(matters.map((m) => m.subjectId)).toEqual(['B', 'A']);

    const reviews = await store.listSubjectsFor('k', 'review');
    expect(reviews.map((m) => m.subjectId)).toEqual(['rev-1']);
  });

  it('removeMember + removeMembersFor', async () => {
    await store.addMember({ subjectType: 's', subjectId: 's1', userId: 'u1', role: 'editor' });
    await store.addMember({ subjectType: 's', subjectId: 's1', userId: 'u2', role: 'viewer' });

    expect(await store.removeMember('s', 's1', 'u1')).toBe(true);
    expect(await store.removeMember('s', 's1', 'u1')).toBe(false);

    const remaining = await store.listMembersFor({ type: 's', id: 's1' });
    expect(remaining.map((m) => m.userId)).toEqual(['u2']);

    const removed = await store.removeMembersFor({ type: 's', id: 's1' });
    expect(removed).toBe(1);
    expect(await store.listMembersFor({ type: 's', id: 's1' })).toEqual([]);
  });

  it('rejects unknown role', async () => {
    await expect(
      store.addMember({
        subjectType: 'x',
        subjectId: 'y',
        userId: 'u',
        // @ts-expect-error testing runtime guard
        role: 'admin',
      }),
    ).rejects.toThrow(/invalid role/);
  });

  it('CHECK constraint rejects bad role at DB level', async () => {
    await expect(
      sql`INSERT INTO members (id, subject_type, subject_id, user_id, role) VALUES ('z', 'x', 'y', 'u', 'admin')`.execute(
        env.kysely,
      ),
    ).rejects.toThrow(/ck_members_role|check constraint/i);
  });

  it('UNIQUE constraint rejects duplicate (subject_type, subject_id, user_id) at DB level', async () => {
    await sql`INSERT INTO members (id, subject_type, subject_id, user_id, role) VALUES ('a', 'q', 'q1', 'u', 'editor')`.execute(
      env.kysely,
    );
    await expect(
      sql`INSERT INTO members (id, subject_type, subject_id, user_id, role) VALUES ('b', 'q', 'q1', 'u', 'viewer')`.execute(
        env.kysely,
      ),
    ).rejects.toThrow(/uq_members_subject_user|unique/i);
  });

  it('canAccess: explicit grant', async () => {
    await store.addMember({ subjectType: 'm', subjectId: 'a', userId: 'u', role: 'editor' });
    expect(await store.canAccess({ type: 'm', id: 'a' }, 'u')).toBe('editor');
    expect(await store.canAccess({ type: 'm', id: 'a' }, 'somebody-else')).toBeNull();
  });

  it('canAccess: implicit owner via lookup wins when explicit is weaker', async () => {
    await store.addMember({ subjectType: 'm', subjectId: 'b', userId: 'u', role: 'viewer' });
    const lookup = async () => 'u';
    expect(await store.canAccess({ type: 'm', id: 'b' }, 'u', lookup)).toBe('owner');
  });

  it('canAccess: no explicit + no implicit = null', async () => {
    const lookup = async () => 'someone-else';
    expect(await store.canAccess({ type: 'm', id: 'never-shared' }, 'u', lookup)).toBeNull();
  });

  it('canAccess: explicit owner short-circuits', async () => {
    await store.addMember({ subjectType: 'm', subjectId: 'c', userId: 'u', role: 'owner' });
    let lookupCalled = false;
    const lookup = async () => {
      lookupCalled = true;
      return null;
    };
    expect(await store.canAccess({ type: 'm', id: 'c' }, 'u', lookup)).toBe('owner');
    expect(lookupCalled).toBe(false);
  });
});
