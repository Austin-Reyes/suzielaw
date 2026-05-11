import type { ColumnType, Generated } from 'kysely';

// Public domain types.

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  /** ISO timestamp; null = active. */
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Folder {
  id: string;
  workspaceId: string;
  /** Null = root-level under the workspace. */
  parentFolderId: string | null;
  name: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceDocument {
  id: string;
  workspaceId: string;
  /** Null = at the workspace root, not in any folder. */
  folderId: string | null;
  /** Opaque pointer into the host's document store. */
  externalDocId: string;
  name: string;
  mimeType: string | null;
  size: number | null;
  /** SHA-256 of the file bytes, hex-encoded. Null for legacy rows + non-archive
   *  uploads. Used by the zip-ingest path to skip re-ingesting identical bytes. */
  sha256: string | null;
  position: number;
  addedAt: Date;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string | null;
}

export interface UpdateWorkspaceInput {
  name?: string;
  description?: string | null;
}

export interface CreateFolderInput {
  workspaceId: string;
  parentFolderId?: string | null;
  name: string;
  position?: number;
}

export interface UpdateFolderInput {
  name?: string;
  parentFolderId?: string | null;
  position?: number;
}

export interface AddDocumentInput {
  workspaceId: string;
  folderId?: string | null;
  externalDocId: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
  sha256?: string | null;
  position?: number;
}

export interface UpdateDocumentInput {
  folderId?: string | null;
  name?: string;
  position?: number;
}

export interface ListWorkspacesOptions {
  /** Default false. When true, archived workspaces are included. */
  includeArchived?: boolean;
}

export interface ListDocumentsOptions {
  /**
   * Filter by folder. Pass `null` for root-level docs only; a folder id for
   * that folder's docs only; omit to list every doc in the workspace.
   */
  folderId?: string | null | undefined;
}

// Kysely table types.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface WorkspacesTable {
  id: string;
  name: string;
  description: string | null;
  archived_at: Timestamp | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Timestamp | null;
}

export interface FoldersTable {
  id: string;
  workspace_id: string;
  parent_folder_id: string | null;
  name: string;
  position: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Timestamp | null;
}

export interface WorkspaceDocumentsTable {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  external_doc_id: string;
  name: string;
  mime_type: string | null;
  size: ColumnType<string | null, string | number | bigint | null, string | number | bigint | null>;
  sha256: string | null;
  position: Generated<number>;
  added_at: Generated<Date>;
  deleted_at: Timestamp | null;
}

export interface WorkspacesDB {
  workspaces: WorkspacesTable;
  folders: FoldersTable;
  workspace_documents: WorkspaceDocumentsTable;
}
