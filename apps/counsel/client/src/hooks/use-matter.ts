import { useCallback, useEffect, useState } from 'react';
import type { Matter } from './use-matters.js';

export interface MatterFolder {
  id: string;
  workspaceId: string;
  parentFolderId: string | null;
  name: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface MatterDocument {
  id: string;
  workspaceId: string;
  folderId: string | null;
  externalDocId: string;
  name: string;
  mimeType: string | null;
  size: number | null;
  position: number;
  addedAt: number;
}

interface UseMatterResult {
  matter: Matter | null;
  folders: MatterFolder[];
  documents: MatterDocument[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createFolder: (name: string, parentFolderId?: string | null) => Promise<MatterFolder>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  moveFolder: (folderId: string, newParentFolderId: string | null) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  uploadDocument: (file: File, folderId?: string | null) => Promise<MatterDocument>;
  moveDocument: (docId: string, newFolderId: string | null) => Promise<void>;
  removeDocument: (docId: string) => Promise<void>;
}

export function useMatter(matterId: string | undefined): UseMatterResult {
  const [matter, setMatter] = useState<Matter | null>(null);
  const [folders, setFolders] = useState<MatterFolder[]>([]);
  const [documents, setDocuments] = useState<MatterDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!matterId) return;
    setLoading(true);
    setError(null);
    try {
      const [matterRes, foldersRes, docsRes] = await Promise.all([
        fetch(`/api/matters/${encodeURIComponent(matterId)}`, { credentials: 'include' }),
        fetch(`/api/matters/${encodeURIComponent(matterId)}/folders`, { credentials: 'include' }),
        fetch(`/api/matters/${encodeURIComponent(matterId)}/documents`, { credentials: 'include' }),
      ]);
      if (!matterRes.ok) {
        throw new Error(`Failed to load matter (${matterRes.status})`);
      }
      const matterData = (await matterRes.json()) as { item: Matter };
      setMatter(matterData.item);
      const foldersData = foldersRes.ok
        ? ((await foldersRes.json()) as { items: MatterFolder[] })
        : { items: [] };
      setFolders(foldersData.items);
      const docsData = docsRes.ok
        ? ((await docsRes.json()) as { items: MatterDocument[] })
        : { items: [] };
      setDocuments(docsData.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load matter');
    } finally {
      setLoading(false);
    }
  }, [matterId]);

  const createFolder = useCallback(
    async (name: string, parentFolderId: string | null = null): Promise<MatterFolder> => {
      if (!matterId) throw new Error('No matter id');
      const response = await fetch(
        `/api/matters/${encodeURIComponent(matterId)}/folders`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name, parentFolderId }),
        },
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${response.status})`);
      }
      const data = (await response.json()) as { item: MatterFolder };
      setFolders((current) => [...current, data.item]);
      return data.item;
    },
    [matterId],
  );

  const uploadDocument = useCallback(
    async (file: File, folderId: string | null = null): Promise<MatterDocument> => {
      if (!matterId) throw new Error('No matter id');
      const form = new FormData();
      form.append('file', file);
      if (folderId) form.append('folderId', folderId);
      const response = await fetch(
        `/api/matters/${encodeURIComponent(matterId)}/documents/upload`,
        {
          method: 'POST',
          credentials: 'include',
          body: form,
        },
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${response.status})`);
      }
      const data = (await response.json()) as { item: MatterDocument };
      setDocuments((current) => [...current, data.item]);
      return data.item;
    },
    [matterId],
  );

  const removeDocument = useCallback(
    async (docId: string): Promise<void> => {
      if (!matterId) return;
      const response = await fetch(
        `/api/matters/${encodeURIComponent(matterId)}/documents/${encodeURIComponent(docId)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed (${response.status})`);
      }
      setDocuments((current) => current.filter((d) => d.id !== docId));
    },
    [matterId],
  );

  const renameFolder = useCallback(
    async (folderId: string, name: string): Promise<void> => {
      if (!matterId) return;
      const response = await fetch(
        `/api/matters/${encodeURIComponent(matterId)}/folders/${encodeURIComponent(folderId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name }),
        },
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${response.status})`);
      }
      const data = (await response.json()) as { item: MatterFolder };
      setFolders((current) => current.map((f) => (f.id === folderId ? data.item : f)));
    },
    [matterId],
  );

  const moveFolder = useCallback(
    async (folderId: string, newParentFolderId: string | null): Promise<void> => {
      if (!matterId) return;
      const response = await fetch(
        `/api/matters/${encodeURIComponent(matterId)}/folders/${encodeURIComponent(folderId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ parentFolderId: newParentFolderId }),
        },
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${response.status})`);
      }
      const data = (await response.json()) as { item: MatterFolder };
      setFolders((current) => current.map((f) => (f.id === folderId ? data.item : f)));
    },
    [matterId],
  );

  const deleteFolder = useCallback(
    async (folderId: string): Promise<void> => {
      if (!matterId) return;
      const response = await fetch(
        `/api/matters/${encodeURIComponent(matterId)}/folders/${encodeURIComponent(folderId)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!response.ok && response.status !== 404) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${response.status})`);
      }
      // Cascade fix-up locally so the UI reflects the same rules the server
      // applied: subfolders (and their subfolders) gone; matching docs move
      // to the matter root.
      const cascade = collectDescendants(folders, folderId);
      cascade.add(folderId);
      setFolders((current) => current.filter((f) => !cascade.has(f.id)));
      setDocuments((current) =>
        current.map((d) =>
          d.folderId !== null && cascade.has(d.folderId) ? { ...d, folderId: null } : d,
        ),
      );
    },
    [matterId, folders],
  );

  const moveDocument = useCallback(
    async (docId: string, newFolderId: string | null): Promise<void> => {
      if (!matterId) return;
      const response = await fetch(
        `/api/matters/${encodeURIComponent(matterId)}/documents/${encodeURIComponent(docId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ folderId: newFolderId }),
        },
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${response.status})`);
      }
      const data = (await response.json()) as { item: MatterDocument };
      setDocuments((current) => current.map((d) => (d.id === docId ? data.item : d)));
    },
    [matterId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    matter,
    folders,
    documents,
    loading,
    error,
    refresh,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    uploadDocument,
    moveDocument,
    removeDocument,
  };
}

function collectDescendants(folders: MatterFolder[], rootId: string): Set<string> {
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const f of folders) {
      if (f.parentFolderId === id && !out.has(f.id)) {
        out.add(f.id);
        stack.push(f.id);
      }
    }
  }
  return out;
}
