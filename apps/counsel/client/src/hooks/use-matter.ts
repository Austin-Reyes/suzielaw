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

export type ZipEntryKind = 'text' | 'ocrd' | 'attached' | 'duplicate' | 'failed';

export interface ZipEntryResult {
  path: string;
  displayName: string;
  kind: ZipEntryKind;
  sha256?: string;
  size: number;
  documentId?: string;
  duplicateOfDocumentId?: string;
  reason?: string;
}

export interface ZipManifest {
  zipFilename: string;
  totalEntries: number;
  processedEntries: number;
  summary: {
    text: number;
    ocrd: number;
    attached: number;
    duplicates: number;
    failed: number;
  };
  entries: ZipEntryResult[];
}

export interface ZipUploadProgress {
  processed: number;
  total: number;
  stage: 'reading' | 'classify' | 'ocr' | 'index' | 'done';
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
  /** Zip-archive upload with SSE progress. Resolves with the final manifest;
   *  call `onProgress` ticks fire as each entry finishes. Refreshes the doc
   *  + folder lists on completion. */
  uploadArchive: (
    file: File,
    onProgress?: (p: ZipUploadProgress) => void,
  ) => Promise<ZipManifest>;
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

  const uploadArchive = useCallback(
    async (
      file: File,
      onProgress?: (p: ZipUploadProgress) => void,
    ): Promise<ZipManifest> => {
      if (!matterId) throw new Error('No matter id');
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(
        `/api/matters/${encodeURIComponent(matterId)}/documents/upload-archive`,
        { method: 'POST', credentials: 'include', body: form },
      );
      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed (${response.status})`);
      }
      const manifest = await consumeSseStream(response.body, onProgress);
      // Refresh so the new folders + docs appear in the panel. Cheaper than
      // optimistically threading 200+ inserts through setState.
      await refresh();
      return manifest;
    },
    [matterId, refresh],
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
    uploadArchive,
    moveDocument,
    removeDocument,
  };
}

async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (p: ZipUploadProgress) => void,
): Promise<ZipManifest> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let manifest: ZipManifest | null = null;
  let errorPayload: { error?: string; message?: string } | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line. Pull complete frames; leave
    // any trailing partial frame in the buffer for the next chunk.
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseSseFrame(frame);
      if (parsed) {
        if (parsed.event === 'progress' && onProgress) {
          onProgress(parsed.data as ZipUploadProgress);
        } else if (parsed.event === 'manifest') {
          manifest = parsed.data as ZipManifest;
        } else if (parsed.event === 'error') {
          errorPayload = parsed.data as { error?: string; message?: string };
        }
      }
      idx = buffer.indexOf('\n\n');
    }
  }
  if (errorPayload) {
    throw new Error(errorPayload.message || errorPayload.error || 'Archive upload failed');
  }
  if (!manifest) {
    throw new Error('Archive upload ended without a manifest event');
  }
  return manifest;
}

function parseSseFrame(frame: string): { event: string; data: unknown } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
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
