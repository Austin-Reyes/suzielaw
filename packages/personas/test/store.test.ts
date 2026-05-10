import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PersonaStore } from '../src/store.js';
import { startPerTestEnv, type PerTestEnv } from './setup.js';

describe('@counsel/personas — PersonaStore', () => {
  let env: PerTestEnv;
  let store: PersonaStore;

  beforeAll(async () => {
    env = await startPerTestEnv();
    store = new PersonaStore({ db: env.kysely });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('creates and reads back full persona', async () => {
    const p = await store.create({
      ownerId: 'austin',
      name: 'PI Counsel',
      description: 'Texas PI plaintiff voice',
      avatar: '/avatars/pi.png',
      model: 'gpt-5.4-mini',
      allowedTools: ['search', 'cite'],
      blockedTools: ['exec'],
      systemPrompt: 'Be a Texas PI attorney.',
    });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.source).toBe('user');
    expect(p.ownerId).toBe('austin');
    expect(p.allowedTools).toEqual(['search', 'cite']);
    expect(p.blockedTools).toEqual(['exec']);

    const fetched = await store.get(p.id, 'austin');
    expect(fetched?.systemPrompt).toBe('Be a Texas PI attorney.');
  });

  it('scopes get to ownerId — different owner cannot read', async () => {
    const p = await store.create({
      ownerId: 'avi',
      name: 'Private',
      description: 'd',
      systemPrompt: 's',
    });
    expect(await store.get(p.id, 'avi')).not.toBeNull();
    expect(await store.get(p.id, 'austin')).toBeNull();
  });

  it('list paginates + filters via ILIKE on name OR description', async () => {
    const ownerId = 'list-owner';
    await store.create({ ownerId, name: 'Alpha intake', description: 'd1', systemPrompt: 's' });
    await store.create({ ownerId, name: 'Beta', description: 'About INTAKE flow', systemPrompt: 's' });
    await store.create({ ownerId, name: 'Gamma', description: 'd3', systemPrompt: 's' });

    const all = await store.list(ownerId);
    expect(all.map((p) => p.name)).toEqual(['Alpha intake', 'Beta', 'Gamma']);

    const filtered = await store.list(ownerId, { q: 'intake' });
    expect(filtered.map((p) => p.name).sort()).toEqual(['Alpha intake', 'Beta']);

    const paged = await store.list(ownerId, { limit: 1, offset: 1 });
    expect(paged.map((p) => p.name)).toEqual(['Beta']);

    expect(await store.count(ownerId)).toBe(3);
    expect(await store.count(ownerId, { q: 'intake' })).toBe(2);
  });

  it('update applies tri-state nullable patch', async () => {
    const p = await store.create({
      ownerId: 'u-update',
      name: 'orig',
      description: 'd',
      systemPrompt: 's',
      avatar: 'old',
      model: 'm1',
      allowedTools: ['a', 'b'],
    });

    // Patch without `avatar` — leave alone.
    const u1 = await store.update(p.id, 'u-update', { name: 'renamed' });
    expect(u1?.name).toBe('renamed');
    expect(u1?.avatar).toBe('old');

    // Patch with avatar=null — clear.
    const u2 = await store.update(p.id, 'u-update', { avatar: null });
    expect(u2?.avatar).toBeUndefined();

    // Patch with allowedTools=null — clear.
    const u3 = await store.update(p.id, 'u-update', { allowedTools: null });
    expect(u3?.allowedTools).toBeUndefined();

    // Patch with allowedTools=[…] — set new value.
    const u4 = await store.update(p.id, 'u-update', { allowedTools: ['x'] });
    expect(u4?.allowedTools).toEqual(['x']);
  });

  it('soft-delete hides from list/get', async () => {
    const p = await store.create({
      ownerId: 'u-del',
      name: 'gone',
      description: 'd',
      systemPrompt: 's',
    });
    expect(await store.delete(p.id, 'u-del')).toBe(true);
    expect(await store.get(p.id, 'u-del')).toBeNull();
    const list = await store.list('u-del');
    expect(list.find((x) => x.id === p.id)).toBeUndefined();
    expect(await store.delete(p.id, 'u-del')).toBe(false);
  });

  it('seed tracker — markSeeded is idempotent; hasBeenSeeded reflects state', async () => {
    expect(await store.hasBeenSeeded('seed-A')).toBe(false);
    await store.markSeeded('seed-A');
    expect(await store.hasBeenSeeded('seed-A')).toBe(true);
    // Idempotent — second mark shouldn't error.
    await store.markSeeded('seed-A');
    expect(await store.hasBeenSeeded('seed-A')).toBe(true);

    expect(await store.hasBeenSeeded('seed-B')).toBe(false);
  });

  it('updated_at trigger fires on update', async () => {
    const p = await store.create({
      ownerId: 'trigger-test',
      name: 'orig',
      description: 'd',
      systemPrompt: 's',
    });
    const before = p.updatedAt!;
    await new Promise((r) => setTimeout(r, 10));
    const u = await store.update(p.id, 'trigger-test', { name: 'new' });
    expect(u!.updatedAt!.getTime()).toBeGreaterThan(before.getTime());
  });
});
