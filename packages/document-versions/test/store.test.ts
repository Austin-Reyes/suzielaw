import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { DocumentVersionsStore } from '../src/store.js';
import { startDvTestEnv, type DvTestEnv } from './setup.js';

describe('@counsel/document-versions — DocumentVersionsStore', () => {
  let env: DvTestEnv;
  let store: DocumentVersionsStore;

  beforeAll(async () => {
    env = await startDvTestEnv();
    store = new DocumentVersionsStore({ db: env.kysely });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('addVersion(upload) creates root + sets head', async () => {
    const v1 = await store.addVersion({
      externalDocId: 'doc-1',
      source: 'upload',
      storageId: 'st-1',
      byteSize: 1024,
      contentHash: 'sha-1',
    });
    expect(v1.parentId).toBeNull();
    expect(v1.source).toBe('upload');
    expect(v1.byteSize).toBe(1024);

    const head = await store.getHead('doc-1');
    expect(head?.id).toBe(v1.id);
  });

  it('addVersion(proposal) chains via parent_id and updates head', async () => {
    const v1 = await store.addVersion({ externalDocId: 'doc-2', source: 'upload', storageId: 's1' });
    const v2 = await store.addVersion({
      externalDocId: 'doc-2',
      parentId: v1.id,
      source: 'proposal',
      storageId: 's2',
      notes: 'redline draft',
    });
    expect(v2.parentId).toBe(v1.id);
    expect((await store.getHead('doc-2'))!.id).toBe(v2.id);
  });

  it('rejects unknown source', async () => {
    await expect(
      store.addVersion({
        externalDocId: 'd',
        // @ts-expect-error testing runtime guard
        source: 'whatever',
        storageId: 's',
      }),
    ).rejects.toThrow(/invalid source/);
  });

  it('rejects parentId from a different document', async () => {
    const a = await store.addVersion({ externalDocId: 'docA', source: 'upload', storageId: 'a' });
    await expect(
      store.addVersion({
        externalDocId: 'docB',
        parentId: a.id,
        source: 'proposal',
        storageId: 'b',
      }),
    ).rejects.toThrow(/different document/);
  });

  it('rejects unknown parentId', async () => {
    await expect(
      store.addVersion({
        externalDocId: 'docX',
        parentId: 'nope',
        source: 'proposal',
        storageId: 's',
      }),
    ).rejects.toThrow(/parentId not found/);
  });

  it('listVersions returns oldest-first', async () => {
    const v1 = await store.addVersion({ externalDocId: 'doc-3', source: 'upload', storageId: 'u' });
    const v2 = await store.addVersion({
      externalDocId: 'doc-3',
      parentId: v1.id,
      source: 'proposal',
      storageId: 'p',
    });
    const v3 = await store.addVersion({
      externalDocId: 'doc-3',
      parentId: v2.id,
      source: 'accept',
      storageId: 'a',
    });
    const list = await store.listVersions('doc-3');
    expect(list.map((v) => v.id)).toEqual([v1.id, v2.id, v3.id]);
  });

  it('setHead repoints without writing a new version', async () => {
    const v1 = await store.addVersion({ externalDocId: 'doc-4', source: 'upload', storageId: 'u' });
    const v2 = await store.addVersion({
      externalDocId: 'doc-4',
      parentId: v1.id,
      source: 'proposal',
      storageId: 'p',
    });
    expect((await store.getHead('doc-4'))!.id).toBe(v2.id);

    await store.setHead('doc-4', v1.id);
    expect((await store.getHead('doc-4'))!.id).toBe(v1.id);

    expect((await store.listVersions('doc-4')).length).toBe(2);
  });

  it('walkAncestors returns self → root via recursive CTE', async () => {
    const v1 = await store.addVersion({ externalDocId: 'doc-5', source: 'upload', storageId: 'u' });
    const v2 = await store.addVersion({
      externalDocId: 'doc-5',
      parentId: v1.id,
      source: 'proposal',
      storageId: 'p',
    });
    const v3 = await store.addVersion({
      externalDocId: 'doc-5',
      parentId: v2.id,
      source: 'accept',
      storageId: 'a',
    });
    const chain = await store.walkAncestors(v3.id);
    expect(chain.map((v) => v.id)).toEqual([v3.id, v2.id, v1.id]);
  });

  it('walkDescendants traverses branches', async () => {
    const v1 = await store.addVersion({ externalDocId: 'doc-6', source: 'upload', storageId: 'u' });
    const v2a = await store.addVersion({
      externalDocId: 'doc-6',
      parentId: v1.id,
      source: 'proposal',
      storageId: 'p1',
    });
    const v2b = await store.addVersion({
      externalDocId: 'doc-6',
      parentId: v1.id,
      source: 'proposal',
      storageId: 'p2',
    });
    const v3 = await store.addVersion({
      externalDocId: 'doc-6',
      parentId: v2a.id,
      source: 'accept',
      storageId: 'a',
    });

    const all = await store.walkDescendants(v1.id);
    const ids = all.map((v) => v.id).sort();
    expect(ids).toEqual([v2a.id, v2b.id, v3.id].sort());

    // Descendants of v2b alone = empty.
    const v2bChildren = await store.walkDescendants(v2b.id);
    expect(v2bChildren).toEqual([]);
  });

  it('CHECK constraint rejects bad source at the DB level', async () => {
    const v1 = await store.addVersion({ externalDocId: 'doc-7', source: 'upload', storageId: 'u' });
    await expect(
      sql`INSERT INTO document_versions (id, external_doc_id, source, storage_id) VALUES ('z', 'doc-7', 'bogus', 's')`.execute(
        env.kysely,
      ),
    ).rejects.toThrow(/ck_document_versions_source|check constraint/i);
    expect(v1).toBeDefined();
  });

  it('deleteAllForDocument wipes versions + head', async () => {
    const v1 = await store.addVersion({ externalDocId: 'doc-8', source: 'upload', storageId: 'u' });
    await store.addVersion({
      externalDocId: 'doc-8',
      parentId: v1.id,
      source: 'proposal',
      storageId: 'p',
    });
    expect((await store.listVersions('doc-8')).length).toBe(2);

    const removed = await store.deleteAllForDocument('doc-8');
    expect(removed).toBe(2);
    expect(await store.getHead('doc-8')).toBeNull();
    expect(await store.listVersions('doc-8')).toEqual([]);
  });

  it("'generated' source is accepted (no parent)", async () => {
    const v = await store.addVersion({
      externalDocId: 'doc-9',
      source: 'generated',
      storageId: 'g',
      notes: 'from generate_docx',
    });
    expect(v.source).toBe('generated');
    expect(v.parentId).toBeNull();
  });
});
