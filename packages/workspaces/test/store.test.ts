import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkspacesStore } from '../src/store.js';
import { startWorkspacesTestEnv, type WorkspacesTestEnv } from './setup.js';

describe('@counsel/workspaces — WorkspacesStore', () => {
  let env: WorkspacesTestEnv;
  let store: WorkspacesStore;

  beforeAll(async () => {
    env = await startWorkspacesTestEnv();
    store = new WorkspacesStore({ db: env.kysely });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('creates and reads a workspace', async () => {
    const ws = await store.createWorkspace({ name: 'Cortez v Acme', description: 'PI matter' });
    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ws.archivedAt).toBeNull();

    const fetched = await store.getWorkspace(ws.id);
    expect(fetched?.name).toBe('Cortez v Acme');
    expect(fetched?.description).toBe('PI matter');
  });

  it('updates a workspace and bumps updated_at via trigger', async () => {
    const ws = await store.createWorkspace({ name: 'Original' });
    await new Promise((r) => setTimeout(r, 10));
    const updated = await store.updateWorkspace(ws.id, { name: 'Renamed' });
    expect(updated?.name).toBe('Renamed');
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(ws.updatedAt.getTime());
  });

  it('archives + unarchives + filters list', async () => {
    const ws = await store.createWorkspace({ name: 'Archive me' });
    expect(await store.archiveWorkspace(ws.id)).toBe(true);
    expect(await store.archiveWorkspace(ws.id)).toBe(false); // idempotent: already archived

    const active = await store.listWorkspaces();
    expect(active.find((w) => w.id === ws.id)).toBeUndefined();

    const all = await store.listWorkspaces({ includeArchived: true });
    expect(all.find((w) => w.id === ws.id)).toBeDefined();

    expect(await store.unarchiveWorkspace(ws.id)).toBe(true);
    const activeAgain = await store.listWorkspaces();
    expect(activeAgain.find((w) => w.id === ws.id)).toBeDefined();
  });

  it('soft-deletes a workspace', async () => {
    const ws = await store.createWorkspace({ name: 'Goodbye' });
    expect(await store.deleteWorkspace(ws.id)).toBe(true);
    expect(await store.getWorkspace(ws.id)).toBeNull();
    expect(await store.deleteWorkspace(ws.id)).toBe(false); // already gone
  });

  it('builds nested folder tree and lists at depth', async () => {
    const ws = await store.createWorkspace({ name: 'Folders' });
    const root = await store.createFolder({ workspaceId: ws.id, name: 'Litigation' });
    const child = await store.createFolder({
      workspaceId: ws.id,
      parentFolderId: root.id,
      name: 'Pleadings',
    });
    const sibling = await store.createFolder({ workspaceId: ws.id, name: 'Medical' });

    const rootLevel = await store.listFolders(ws.id, null);
    expect(rootLevel.map((f) => f.name).sort()).toEqual(['Litigation', 'Medical']);

    const children = await store.listFolders(ws.id, root.id);
    expect(children.map((f) => f.name)).toEqual(['Pleadings']);

    const all = await store.listFolders(ws.id);
    expect(all.length).toBe(3);
    expect(all.map((f) => f.id).sort()).toEqual([root.id, child.id, sibling.id].sort());
  });

  it('moves a folder by updating parent_folder_id', async () => {
    const ws = await store.createWorkspace({ name: 'Move' });
    const a = await store.createFolder({ workspaceId: ws.id, name: 'A' });
    const b = await store.createFolder({ workspaceId: ws.id, name: 'B' });
    const c = await store.createFolder({
      workspaceId: ws.id,
      parentFolderId: a.id,
      name: 'C',
    });

    const moved = await store.updateFolder(c.id, { parentFolderId: b.id });
    expect(moved?.parentFolderId).toBe(b.id);

    expect(await store.listFolders(ws.id, a.id)).toEqual([]);
    expect((await store.listFolders(ws.id, b.id)).map((f) => f.name)).toEqual(['C']);
  });

  it('adds, lists, and removes documents — folder vs root scoping', async () => {
    const ws = await store.createWorkspace({ name: 'Docs' });
    const folder = await store.createFolder({ workspaceId: ws.id, name: 'Folder' });

    const rootDoc = await store.addDocument({
      workspaceId: ws.id,
      externalDocId: 'ext-1',
      name: 'root.pdf',
      mimeType: 'application/pdf',
      size: 1024,
    });
    const folderDoc = await store.addDocument({
      workspaceId: ws.id,
      folderId: folder.id,
      externalDocId: 'ext-2',
      name: 'inside.pdf',
      size: 2048,
    });

    const rootList = await store.listDocuments(ws.id, { folderId: null });
    expect(rootList.map((d) => d.id)).toEqual([rootDoc.id]);

    const folderList = await store.listDocuments(ws.id, { folderId: folder.id });
    expect(folderList.map((d) => d.id)).toEqual([folderDoc.id]);

    const all = await store.listDocuments(ws.id);
    expect(all.map((d) => d.id).sort()).toEqual([rootDoc.id, folderDoc.id].sort());

    expect(folderList[0]?.size).toBe(2048);
    expect(folderList[0]?.mimeType).toBeNull();

    expect(await store.removeDocument(rootDoc.id)).toBe(true);
    expect(await store.getDocument(rootDoc.id)).toBeNull();
  });

  it('moves a document between folders via updateDocument', async () => {
    const ws = await store.createWorkspace({ name: 'DocMove' });
    const folder = await store.createFolder({ workspaceId: ws.id, name: 'F' });
    const doc = await store.addDocument({
      workspaceId: ws.id,
      externalDocId: 'x',
      name: 'd.pdf',
    });
    expect(doc.folderId).toBeNull();

    const moved = await store.updateDocument(doc.id, { folderId: folder.id, position: 7 });
    expect(moved?.folderId).toBe(folder.id);
    expect(moved?.position).toBe(7);

    const back = await store.updateDocument(doc.id, { folderId: null });
    expect(back?.folderId).toBeNull();
  });

  it('cascade-deletes folders+docs when workspace is hard-deleted (FK CASCADE)', async () => {
    const ws = await store.createWorkspace({ name: 'Cascade' });
    const folder = await store.createFolder({ workspaceId: ws.id, name: 'F' });
    await store.addDocument({
      workspaceId: ws.id,
      folderId: folder.id,
      externalDocId: 'x',
      name: 'd',
    });

    // Bypass the soft-delete API to verify the FK behavior directly.
    await env.kysely.deleteFrom('workspaces').where('id', '=', ws.id).execute();

    const folders = await env.kysely
      .selectFrom('folders')
      .selectAll()
      .where('workspace_id', '=', ws.id)
      .execute();
    const docs = await env.kysely
      .selectFrom('workspace_documents')
      .selectAll()
      .where('workspace_id', '=', ws.id)
      .execute();
    expect(folders).toEqual([]);
    expect(docs).toEqual([]);
  });

  it('SET NULL cascade: hard-deleting a folder orphans its docs to root', async () => {
    const ws = await store.createWorkspace({ name: 'SetNull' });
    const folder = await store.createFolder({ workspaceId: ws.id, name: 'Temp' });
    const doc = await store.addDocument({
      workspaceId: ws.id,
      folderId: folder.id,
      externalDocId: 'x',
      name: 'd',
    });

    await env.kysely.deleteFrom('folders').where('id', '=', folder.id).execute();

    const after = await store.getDocument(doc.id);
    expect(after?.folderId).toBeNull();
  });
});
