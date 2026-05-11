import { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type {
  AddDocumentInput,
  CreateFolderInput,
  CreateWorkspaceInput,
  Folder,
  ListDocumentsOptions,
  ListWorkspacesOptions,
  UpdateDocumentInput,
  UpdateFolderInput,
  UpdateWorkspaceInput,
  Workspace,
  WorkspaceDocument,
  WorkspacesDB,
} from './types.js';

export interface WorkspacesStoreOptions<TDB extends WorkspacesDB> {
  db: Kysely<TDB>;
  /** Override the id generator. Default: UUIDv7. */
  idFactory?: () => string;
}

export class WorkspacesStore<TDB extends WorkspacesDB = WorkspacesDB> {
  private readonly db: Kysely<TDB>;
  private readonly newId: () => string;

  constructor(opts: WorkspacesStoreOptions<TDB>) {
    this.db = opts.db;
    this.newId = opts.idFactory ?? uuidv7;
  }

  // --- Workspace ---------------------------------------------------------

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const id = this.newId();
    await this.kbDb()
      .insertInto('workspaces')
      .values({ id, name: input.name, description: input.description ?? null })
      .execute();
    return (await this.getWorkspace(id))!;
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const row = await this.kbDb()
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? rowToWorkspace(row) : null;
  }

  async listWorkspaces(opts: ListWorkspacesOptions = {}): Promise<Workspace[]> {
    let q = this.kbDb()
      .selectFrom('workspaces')
      .selectAll()
      .where('deleted_at', 'is', null);
    if (!opts.includeArchived) q = q.where('archived_at', 'is', null);
    const rows = await q.orderBy('created_at', 'desc').execute();
    return rows.map(rowToWorkspace);
  }

  async updateWorkspace(
    id: string,
    patch: UpdateWorkspaceInput,
  ): Promise<Workspace | null> {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (Object.keys(set).length === 0) return this.getWorkspace(id);

    const result = await this.kbDb()
      .updateTable('workspaces')
      .set(set)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return null;
    return this.getWorkspace(id);
  }

  async archiveWorkspace(id: string): Promise<boolean> {
    const result = await this.kbDb()
      .updateTable('workspaces')
      .set({ archived_at: new Date() })
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  async unarchiveWorkspace(id: string): Promise<boolean> {
    const result = await this.kbDb()
      .updateTable('workspaces')
      .set({ archived_at: null })
      .where('id', '=', id)
      .where('archived_at', 'is not', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  /** Soft-delete: stamps deleted_at. Cascade-deletes (CASCADE FKs) of folders/docs
   *  remain intact for the not-yet-deleted parent — if you want to hide them,
   *  ensure the workspace is treated as the access boundary. */
  async deleteWorkspace(id: string): Promise<boolean> {
    const result = await this.kbDb()
      .updateTable('workspaces')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  // --- Folder ------------------------------------------------------------

  async createFolder(input: CreateFolderInput): Promise<Folder> {
    const id = this.newId();
    await this.kbDb()
      .insertInto('folders')
      .values({
        id,
        workspace_id: input.workspaceId,
        parent_folder_id: input.parentFolderId ?? null,
        name: input.name,
        position: input.position,
      })
      .execute();
    return (await this.getFolder(id))!;
  }

  async getFolder(id: string): Promise<Folder | null> {
    const row = await this.kbDb()
      .selectFrom('folders')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? rowToFolder(row) : null;
  }

  async listFolders(
    workspaceId: string,
    parentFolderId?: string | null | undefined,
  ): Promise<Folder[]> {
    let q = this.kbDb()
      .selectFrom('folders')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('deleted_at', 'is', null);

    if (parentFolderId === undefined) {
      // every folder in the workspace
      q = q.orderBy('parent_folder_id').orderBy('position').orderBy('name');
    } else if (parentFolderId === null) {
      q = q.where('parent_folder_id', 'is', null).orderBy('position').orderBy('name');
    } else {
      q = q.where('parent_folder_id', '=', parentFolderId).orderBy('position').orderBy('name');
    }
    const rows = await q.execute();
    return rows.map(rowToFolder);
  }

  async updateFolder(id: string, patch: UpdateFolderInput): Promise<Folder | null> {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.parentFolderId !== undefined) set.parent_folder_id = patch.parentFolderId;
    if (patch.position !== undefined) set.position = patch.position;
    if (Object.keys(set).length === 0) return this.getFolder(id);

    const result = await this.kbDb()
      .updateTable('folders')
      .set(set)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return null;
    return this.getFolder(id);
  }

  /** Soft-delete the folder. Workspace_documents.folder_id refs are kept;
   *  the FK has ON DELETE SET NULL but soft-delete leaves the row, so docs
   *  still point at this (now-hidden) folder until reassigned by the app. */
  async deleteFolder(id: string): Promise<boolean> {
    const result = await this.kbDb()
      .updateTable('folders')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  // --- Document ----------------------------------------------------------

  async addDocument(input: AddDocumentInput): Promise<WorkspaceDocument> {
    const id = this.newId();
    await this.kbDb()
      .insertInto('workspace_documents')
      .values({
        id,
        workspace_id: input.workspaceId,
        folder_id: input.folderId ?? null,
        external_doc_id: input.externalDocId,
        name: input.name,
        mime_type: input.mimeType ?? null,
        size: input.size ?? null,
        sha256: input.sha256 ?? null,
        position: input.position,
      })
      .execute();
    return (await this.getDocument(id))!;
  }

  /**
   * Find an existing (non-deleted) document in this workspace whose bytes
   * hash to `sha256`. Used by the zip-ingest path to skip re-ingesting
   * files that were already uploaded under any path. Returns null when no
   * match exists. The uq_workspace_documents_workspace_sha256 partial index
   * makes this a single-row lookup.
   */
  async findDocumentBySha256(
    workspaceId: string,
    sha256: string,
  ): Promise<WorkspaceDocument | null> {
    const row = await this.kbDb()
      .selectFrom('workspace_documents')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('sha256', '=', sha256)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? rowToDocument(row) : null;
  }

  async getDocument(id: string): Promise<WorkspaceDocument | null> {
    const row = await this.kbDb()
      .selectFrom('workspace_documents')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? rowToDocument(row) : null;
  }

  async listDocuments(
    workspaceId: string,
    opts: ListDocumentsOptions = {},
  ): Promise<WorkspaceDocument[]> {
    const folderId = opts.folderId;
    let q = this.kbDb()
      .selectFrom('workspace_documents')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('deleted_at', 'is', null);

    if (folderId === undefined) {
      q = q.orderBy('folder_id').orderBy('position').orderBy('name');
    } else if (folderId === null) {
      q = q.where('folder_id', 'is', null).orderBy('position').orderBy('name');
    } else {
      q = q.where('folder_id', '=', folderId).orderBy('position').orderBy('name');
    }
    const rows = await q.execute();
    return rows.map(rowToDocument);
  }

  async updateDocument(
    id: string,
    patch: UpdateDocumentInput,
  ): Promise<WorkspaceDocument | null> {
    const set: Record<string, unknown> = {};
    if (patch.folderId !== undefined) set.folder_id = patch.folderId;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.position !== undefined) set.position = patch.position;
    if (Object.keys(set).length === 0) return this.getDocument(id);

    const result = await this.kbDb()
      .updateTable('workspace_documents')
      .set(set)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return null;
    return this.getDocument(id);
  }

  async removeDocument(id: string): Promise<boolean> {
    const result = await this.kbDb()
      .updateTable('workspace_documents')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  private kbDb(): Kysely<WorkspacesDB> {
    return this.db as unknown as Kysely<WorkspacesDB>;
  }
}

interface WorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface FolderRow {
  id: string;
  workspace_id: string;
  parent_folder_id: string | null;
  name: string;
  position: number;
  created_at: Date;
  updated_at: Date;
}

interface DocumentRow {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  external_doc_id: string;
  name: string;
  mime_type: string | null;
  size: string | null;
  sha256: string | null;
  position: number;
  added_at: Date;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFolder(row: FolderRow): Folder {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentFolderId: row.parent_folder_id,
    name: row.name,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDocument(row: DocumentRow): WorkspaceDocument {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    folderId: row.folder_id,
    externalDocId: row.external_doc_id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size === null ? null : Number(row.size),
    sha256: row.sha256,
    position: row.position,
    addedAt: row.added_at,
  };
}
