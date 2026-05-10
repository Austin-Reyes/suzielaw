import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkflowsStore } from '../src/store.js';
import { startWfTestEnv, type WfTestEnv } from './setup.js';

describe('@counsel/workflows — WorkflowsStore', () => {
  let env: WfTestEnv;
  let store: WorkflowsStore;

  beforeAll(async () => {
    env = await startWfTestEnv();
    store = new WorkflowsStore({ db: env.kysely });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('upsertSystem inserts then re-runs as update', async () => {
    const w1 = await store.upsertSystem({
      id: 'demand-letter',
      name: 'Demand Letter',
      description: 'd',
      prompt: 'p1',
      practiceAreas: ['pi'],
    });
    expect(w1.source).toBe('system');
    expect(w1.ownerId).toBeNull();
    expect(w1.outputMode).toBe('inline_chat');

    const w2 = await store.upsertSystem({
      id: 'demand-letter',
      name: 'Demand Letter v2',
      prompt: 'p2',
    });
    expect(w2.id).toBe(w1.id);
    expect(w2.name).toBe('Demand Letter v2');
    expect(w2.prompt).toBe('p2');
    expect((await store.listBySource('system')).length).toBe(1);
  });

  it("output_mode auto-derives 'tabular_review' from columnConfig", async () => {
    const w = await store.upsertSystem({
      id: 'med-review',
      name: 'Medical Review',
      prompt: 'p',
      columnConfig: [{ title: 'Diagnosis', prompt: 'q', format: 'short_text' }],
    });
    expect(w.outputMode).toBe('tabular_review');
    expect(w.columnConfig?.length).toBe(1);
  });

  it('seedSystem upserts the input set + drops stale system rows', async () => {
    await store.upsertSystem({ id: 'a', name: 'A', prompt: 'p' });
    await store.upsertSystem({ id: 'b', name: 'B', prompt: 'p' });
    await store.upsertSystem({ id: 'c', name: 'C', prompt: 'p' });
    expect((await store.listBySource('system')).length).toBeGreaterThanOrEqual(3);

    const result = await store.seedSystem([
      { id: 'a', name: 'A', prompt: 'p' },
      { id: 'd', name: 'D', prompt: 'p' },
    ]);
    expect(result.upserted).toBe(2);
    expect(result.removed).toBeGreaterThanOrEqual(2); // b, c, plus anything from earlier tests

    const surviving = (await store.listBySource('system')).map((w) => w.id);
    expect(surviving).toContain('a');
    expect(surviving).toContain('d');
    expect(surviving).not.toContain('b');
    expect(surviving).not.toContain('c');
  });

  it('createUserWorkflow + get scopes by ownership', async () => {
    const w = await store.createUserWorkflow({
      ownerId: 'austin',
      name: 'My Custom',
      prompt: 'p',
      practiceAreas: ['custom'],
    });
    expect(w.source).toBe('user');
    expect(w.ownerId).toBe('austin');
    expect(w.practiceAreas).toEqual(['custom']);
  });

  it('updateUserWorkflow rejects non-owner; captures version on success', async () => {
    const w = await store.createUserWorkflow({
      ownerId: 'austin',
      name: 'orig',
      prompt: 'p1',
    });
    expect(await store.updateUserWorkflow(w.id, 'avi', { name: 'hijack' })).toBeNull();

    const u1 = await store.updateUserWorkflow(w.id, 'austin', { name: 'edited', prompt: 'p2' });
    expect(u1?.name).toBe('edited');
    expect(u1?.prompt).toBe('p2');

    const versions = await store.listVersions(w.id, 'austin');
    expect(versions.length).toBe(1);
    expect(versions[0]?.reason).toBe('update');
    expect(versions[0]?.name).toBe('orig');
    expect(versions[0]?.prompt).toBe('p1');
  });

  it('updateUserWorkflow tri-state on columnConfig: undefined leaves; null clears; array replaces', async () => {
    const w = await store.createUserWorkflow({
      ownerId: 'u-tri',
      name: 'tri',
      prompt: 'p',
      columnConfig: [{ title: 't', prompt: 'q', format: 'text' }],
    });
    expect(w.columnConfig?.length).toBe(1);

    // undefined: leave alone.
    const u1 = await store.updateUserWorkflow(w.id, 'u-tri', { name: 'renamed' });
    expect(u1?.columnConfig?.length).toBe(1);

    // null: clear.
    const u2 = await store.updateUserWorkflow(w.id, 'u-tri', { columnConfig: null });
    expect(u2?.columnConfig).toBeNull();

    // array: replace.
    const u3 = await store.updateUserWorkflow(w.id, 'u-tri', {
      columnConfig: [
        { title: 'a', prompt: 'q', format: 'text' },
        { title: 'b', prompt: 'q', format: 'date' },
      ],
    });
    expect(u3?.columnConfig?.length).toBe(2);
  });

  it('restoreVersion rewrites live row + records a restore-reason version', async () => {
    const w = await store.createUserWorkflow({
      ownerId: 'r',
      name: 'v0',
      prompt: 'p0',
    });
    await store.updateUserWorkflow(w.id, 'r', { name: 'v1', prompt: 'p1' });
    const versions = await store.listVersions(w.id, 'r');
    expect(versions[0]?.name).toBe('v0');

    const restored = await store.restoreVersion(w.id, versions[0]!.id, 'r');
    expect(restored?.name).toBe('v0');
    expect(restored?.prompt).toBe('p0');

    // The restore itself should have written a new version row of the
    // pre-restore state ('v1') with reason='restore'.
    const after = await store.listVersions(w.id, 'r');
    expect(after.length).toBe(2);
    expect(after[0]?.reason).toBe('restore');
    expect(after[0]?.name).toBe('v1');
  });

  it('archive + unarchive are owner-scoped; affect listVisible', async () => {
    const w = await store.createUserWorkflow({ ownerId: 'arch', name: 'a', prompt: 'p' });
    expect(await store.archive(w.id, 'somebody-else')).toBe(false);
    expect(await store.archive(w.id, 'arch')).toBe(true);

    const visible = await store.listVisible({ ownerId: 'arch' });
    expect(visible.find((x) => x.id === w.id)).toBeUndefined();

    const all = await store.listVisible({ ownerId: 'arch', includeArchived: true });
    expect(all.find((x) => x.id === w.id)).toBeDefined();

    expect(await store.unarchive(w.id, 'arch')).toBe(true);
    const after = await store.listVisible({ ownerId: 'arch' });
    expect(after.find((x) => x.id === w.id)).toBeDefined();
  });

  it('hide + unhide on system rows; listVisible respects hides', async () => {
    await store.seedSystem([{ id: 'sys-1', name: 'sys-1', prompt: 'p' }]);
    const ownerId = 'hide-test';
    let visible = await store.listVisible({ ownerId });
    expect(visible.find((w) => w.id === 'sys-1')).toBeDefined();

    await store.hide('sys-1', ownerId);
    visible = await store.listVisible({ ownerId });
    expect(visible.find((w) => w.id === 'sys-1')).toBeUndefined();

    // idempotent
    await store.hide('sys-1', ownerId);

    const hiddenIds = await store.listHiddenIds(ownerId);
    expect(hiddenIds).toContain('sys-1');

    expect(await store.unhide('sys-1', ownerId)).toBe(true);
    visible = await store.listVisible({ ownerId });
    expect(visible.find((w) => w.id === 'sys-1')).toBeDefined();
  });

  it('deleteUserWorkflow CASCADEs versions; cannot delete system rows', async () => {
    const w = await store.createUserWorkflow({ ownerId: 'del', name: 'gone', prompt: 'p' });
    await store.updateUserWorkflow(w.id, 'del', { name: 'gone-v2' });
    expect((await store.listVersions(w.id, 'del')).length).toBe(1);

    expect(await store.deleteUserWorkflow(w.id, 'del')).toBe(true);
    expect(await store.get(w.id)).toBeNull();
    // versions should be CASCADE-deleted.
    const orphans = await env.kysely
      .selectFrom('workflow_versions')
      .selectAll()
      .where('workflow_id', '=', w.id)
      .execute();
    expect(orphans).toEqual([]);

    // System rows: deleteUserWorkflow returns false
    await store.upsertSystem({ id: 'protected-sys', name: 'sys', prompt: 'p' });
    expect(await store.deleteUserWorkflow('protected-sys', 'del')).toBe(false);
    expect(await store.get('protected-sys')).not.toBeNull();
  });

  it('listVisible mixes user rows with non-hidden system rows', async () => {
    await store.seedSystem([{ id: 'shared', name: 'Shared', prompt: 'p' }]);
    const ownerId = 'mixed';
    await store.createUserWorkflow({ ownerId, name: 'Mine', prompt: 'p' });
    const list = await store.listVisible({ ownerId });
    const ids = list.map((w) => w.id);
    expect(ids).toContain('shared');
    expect(list.find((w) => w.name === 'Mine')).toBeDefined();
    // User rows owned by SOMEBODY ELSE shouldn't appear.
    await store.createUserWorkflow({ ownerId: 'other-user', name: 'TheirOwn', prompt: 'p' });
    const list2 = await store.listVisible({ ownerId });
    expect(list2.find((w) => w.name === 'TheirOwn')).toBeUndefined();
  });
});
