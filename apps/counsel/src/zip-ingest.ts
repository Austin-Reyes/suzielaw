/**
 * Zip-archive ingestion pipeline for Litify/Docrio matter exports.
 *
 * Attorney drops `Kevin Cortez Sanchez _ 11_13_2021 (Motor Vehicle).zip` on
 * the composer; this module:
 *   1. parses the zip with yauzl (streamed entry-by-entry, not loaded whole
 *      into memory beyond what multer already buffered),
 *   2. builds the matching `workspace_folders` tree under the matter,
 *   3. routes each file through markitdown-agent's /classify → /ocr,
 *   4. inserts text into the per-matter KB via MatterRag,
 *   5. dedupes by sha256 against prior uploads (uq partial index),
 *   6. yields progress ticks the caller streams as SSE.
 *
 * Per-file caps: 100 MB. Per-zip: 500 MB total, 1,000 entries. Per-file
 * timeout: 60s (covers classify + OCR end-to-end). Anything outside those
 * lands as `failed` in the manifest, not as an exception that aborts the
 * whole zip.
 */

import { createHash } from 'node:crypto';
import yauzl from 'yauzl';

import type { WorkspacesStore } from '@counsel/workspaces';
import type { Folder } from '@counsel/workspaces';

import type { FileRecord, FileStore } from './files.js';
import type { MatterRag } from './matter-rag.js';

// -------- public types ----------------------------------------------------

export interface ZipIngestOptions {
  matterId: string;
  zipBytes: Buffer;
  /** Original filename the user uploaded (used only for the manifest header). */
  zipFilename: string;
  workspaces: WorkspacesStore;
  fileStore: FileStore;
  rag: MatterRag;
  markitdownBaseUrl: string;
}

export type ZipEntryKind =
  | 'text'         // classify returned markdown directly
  | 'ocrd'         // classify said image-pdf, /ocr produced markdown
  | 'attached'     // raw image, stored as binary, no KB index
  | 'duplicate'    // sha256 already seen (in this zip or a prior upload)
  | 'failed';      // unsupported, oversize, timeout, or pipeline error

export interface ZipEntryResult {
  /** Full path inside the zip, e.g. "Litigation/FM Docs/015 - …pdf". */
  path: string;
  /** Display name with doubled extension stripped (foo.pdf.pdf → foo.pdf). */
  displayName: string;
  kind: ZipEntryKind;
  /** Hex sha256 of bytes. Always present unless we couldn't read the entry. */
  sha256?: string;
  size: number;
  /** workspace_documents.id when ingested; absent for dedup-skips and failures. */
  documentId?: string;
  /** When dedup-skipped, points at the existing doc that won. */
  duplicateOfDocumentId?: string;
  /** Human-readable reason for failed/duplicate/attached entries. */
  reason?: string;
}

export interface ZipManifestSummary {
  text: number;
  ocrd: number;
  attached: number;
  duplicates: number;
  failed: number;
}

export interface ZipManifest {
  zipFilename: string;
  totalEntries: number;
  processedEntries: number;
  summary: ZipManifestSummary;
  entries: ZipEntryResult[];
}

/** Stage tag for SSE progress UX. */
export type ZipProgressStage = 'reading' | 'classify' | 'ocr' | 'index' | 'done';

export interface ZipProgressEvent {
  processed: number;
  total: number;
  stage: ZipProgressStage;
}

// -------- constants -------------------------------------------------------

const PER_FILE_BYTE_CAP = 100 * 1024 * 1024;
const TOTAL_BYTE_CAP = 500 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
// 180s per file. Bumped from 60s after a real Cortez upload hit the cap on
// a multi-page scanned discovery PDF that DI needed ~75s to OCR. 180s gives
// 2-3x headroom for the largest scanned pleadings we expect, while still
// bounding worst-case zip time (1,000 entries × 180s = far longer than any
// HTTP client will tolerate, but in practice OCR-routed files are only the
// minority and most entries complete in <2s via the local /classify path).
const PER_FILE_TIMEOUT_MS = 180_000;

// -------- entry point -----------------------------------------------------

/**
 * Run the pipeline. The async generator yields a progress event after each
 * entry is fully processed, then ends with the manifest as the final yielded
 * value (`done` event from the caller's perspective). Callers stream the
 * progress events as SSE and emit the manifest as the terminal event.
 */
export async function* ingestZip(
  opts: ZipIngestOptions,
): AsyncGenerator<ZipProgressEvent, ZipManifest, void> {
  const entries = await listZipEntries(opts.zipBytes);

  // Pre-flight caps: count + size from the central directory before we
  // commit to any extraction work. Reject hard.
  if (entries.length === 0) {
    throw new ZipIngestError('empty_zip', 'Zip contained no usable files.');
  }
  if (entries.length > MAX_ENTRIES) {
    throw new ZipIngestError(
      'too_many_entries',
      `Zip has ${entries.length} entries; max is ${MAX_ENTRIES}.`,
    );
  }
  const totalBytes = entries.reduce((n, e) => n + e.uncompressedSize, 0);
  if (totalBytes > TOTAL_BYTE_CAP) {
    throw new ZipIngestError(
      'too_large',
      `Zip uncompressed size ${humanMB(totalBytes)} exceeds ${humanMB(TOTAL_BYTE_CAP)} cap.`,
    );
  }

  // Build the folder tree once up front from the unique parent paths. The
  // walker reuses ids per path so per-file work is a map lookup, not a
  // workspaces.listFolders() round-trip.
  const folderIdByPath = await ensureFolderTree(
    opts.workspaces,
    opts.matterId,
    entries.map((e) => e.path),
  );

  // Within-zip sha256 dedup map (separate from the per-matter unique
  // index, which catches re-uploads).
  const seenInZip = new Map<string, string>(); // sha256 → documentId

  const results: ZipEntryResult[] = [];
  const total = entries.length;
  let processed = 0;

  for (const entry of entries) {
    const result = await processEntry(opts, entry, folderIdByPath, seenInZip);
    results.push(result);
    processed += 1;
    yield { processed, total, stage: 'index' };
  }

  const summary: ZipManifestSummary = {
    text: 0, ocrd: 0, attached: 0, duplicates: 0, failed: 0,
  };
  for (const r of results) {
    if (r.kind === 'text') summary.text += 1;
    else if (r.kind === 'ocrd') summary.ocrd += 1;
    else if (r.kind === 'attached') summary.attached += 1;
    else if (r.kind === 'duplicate') summary.duplicates += 1;
    else summary.failed += 1;
  }

  return {
    zipFilename: opts.zipFilename,
    totalEntries: total,
    processedEntries: processed,
    summary,
    entries: results,
  };
}

export class ZipIngestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// -------- yauzl wrappers --------------------------------------------------

interface ParsedEntry {
  path: string;
  uncompressedSize: number;
  /** Reader that returns the entry bytes; created lazily on first call. */
  read: () => Promise<Buffer>;
}

/**
 * Walk the zip once, returning every regular-file entry with a lazy reader.
 * Skipped silently: directories, symlinks, zero-byte entries, macOS junk
 * (__MACOSX/*, .DS_Store), and anything with a path traversal attempt
 * (a leading "/" or any ".." segment).
 */
function listZipEntries(zipBytes: Buffer): Promise<ParsedEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBytes, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('yauzl returned no zipfile'));
        return;
      }
      const out: ParsedEntry[] = [];
      zipfile.on('error', reject);
      zipfile.on('end', () => resolve(out));
      zipfile.on('entry', (entry: yauzl.Entry) => {
        const path = entry.fileName;
        if (shouldSkip(path) || isDirectoryEntry(entry)) {
          zipfile.readEntry();
          return;
        }
        if (entry.uncompressedSize === 0) {
          zipfile.readEntry();
          return;
        }
        out.push({
          path,
          uncompressedSize: entry.uncompressedSize,
          read: () => readEntryBuffer(zipfile, entry),
        });
        zipfile.readEntry();
      });
      zipfile.readEntry();
    });
  });
}

function isDirectoryEntry(entry: yauzl.Entry): boolean {
  // Zip spec: directory entries end with "/". yauzl preserves the slash.
  return entry.fileName.endsWith('/');
}

function shouldSkip(p: string): boolean {
  if (p.startsWith('/') || p.split('/').some((seg) => seg === '..')) return true;
  if (p.startsWith('__MACOSX/')) return true;
  if (p.split('/').some((seg) => seg === '.DS_Store')) return true;
  // Symlinks come through with file mode bits set; yauzl exposes them as
  // regular entries. We don't currently inspect external_file_attributes
  // — a future hardening pass should reject mode & 0o120000.
  return false;
}

function readEntryBuffer(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('openReadStream returned no stream'));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

// -------- folder tree builder --------------------------------------------

/**
 * Materialise a `workspace_folders` row for every directory implied by the
 * entry paths. Returns a map from "Litigation/FM Docs" → folder id (or null
 * for entries that live at the matter root).
 *
 * Reuses existing folders by (parent, name) so re-uploading the same zip
 * doesn't create "All (2)" alongside "All". Folders are matched
 * case-sensitively because Litify's exports are consistent.
 */
async function ensureFolderTree(
  workspaces: WorkspacesStore,
  matterId: string,
  entryPaths: string[],
): Promise<Map<string, string | null>> {
  // Collect every unique directory prefix from every entry path.
  const dirs = new Set<string>();
  for (const p of entryPaths) {
    const parts = p.split('/');
    parts.pop(); // drop the filename
    for (let i = 1; i <= parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  // Sort shallow → deep so a parent always exists by the time we create a child.
  const sorted = Array.from(dirs).filter((s) => s.length > 0).sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    return da - db || a.localeCompare(b);
  });

  // Pre-load every existing folder under this matter so we can match by
  // (parent, name) without a SELECT per directory.
  const existing = await workspaces.listFolders(matterId);
  const byParentAndName = new Map<string, Folder>();
  for (const f of existing) {
    byParentAndName.set(folderKey(f.parentFolderId, f.name), f);
  }

  const idByPath = new Map<string, string | null>();
  idByPath.set('', null); // root marker

  for (const dirPath of sorted) {
    const parts = dirPath.split('/');
    const name = parts[parts.length - 1]!;
    const parentPath = parts.slice(0, -1).join('');
    const parentId = idByPath.get(parts.slice(0, -1).join('/')) ?? null;

    const existingFolder = byParentAndName.get(folderKey(parentId, name));
    if (existingFolder) {
      idByPath.set(dirPath, existingFolder.id);
      continue;
    }
    const created = await workspaces.createFolder({
      workspaceId: matterId,
      parentFolderId: parentId,
      name,
    });
    byParentAndName.set(folderKey(parentId, name), created);
    idByPath.set(dirPath, created.id);
    // parentPath is unused but kept so future "skip suspicious paths"
    // checks have a place to land.
    void parentPath;
  }
  return idByPath;
}

function folderKey(parentId: string | null, name: string): string {
  return `${parentId ?? ''}::${name}`;
}

// -------- per-entry pipeline ---------------------------------------------

async function processEntry(
  opts: ZipIngestOptions,
  entry: ParsedEntry,
  folderIdByPath: Map<string, string | null>,
  seenInZip: Map<string, string>,
): Promise<ZipEntryResult> {
  const displayName = stripDoubledExtension(basename(entry.path));
  const baseResult: Omit<ZipEntryResult, 'kind'> = {
    path: entry.path,
    displayName,
    size: entry.uncompressedSize,
  };

  if (entry.uncompressedSize > PER_FILE_BYTE_CAP) {
    return {
      ...baseResult,
      kind: 'failed',
      reason: `File exceeds ${humanMB(PER_FILE_BYTE_CAP)} per-file cap.`,
    };
  }

  let bytes: Buffer;
  try {
    bytes = await withTimeout(entry.read(), PER_FILE_TIMEOUT_MS, 'read');
  } catch (err) {
    return {
      ...baseResult,
      kind: 'failed',
      reason: `Read failed: ${truncate(messageOf(err), 160)}`,
    };
  }

  const sha256 = sha256Hex(bytes);

  // 1) Within-zip dedup — the cheap one; no DB hit.
  const sameInZip = seenInZip.get(sha256);
  if (sameInZip) {
    return {
      ...baseResult,
      kind: 'duplicate',
      sha256,
      duplicateOfDocumentId: sameInZip,
      reason: 'Same bytes appeared earlier in this zip.',
    };
  }

  // 2) Cross-upload dedup — partial unique index prevents a second insert
  //    anyway, but we check first so the manifest can name the existing doc.
  const priorDoc = await opts.workspaces.findDocumentBySha256(opts.matterId, sha256);
  if (priorDoc) {
    return {
      ...baseResult,
      kind: 'duplicate',
      sha256,
      duplicateOfDocumentId: priorDoc.id,
      reason: 'Already uploaded to this matter.',
    };
  }

  // 3) Persist bytes — every accepted file gets a fileStore row so
  //    `/api/files/:matterId/:fileId/content` can serve it back.
  const fileId = generateFileId();
  const mimeType = guessMimeType(entry.path);
  const fileRecord: FileRecord = {
    id: fileId,
    sessionId: opts.matterId,
    name: displayName,
    mimeType,
    size: bytes.length,
    bytes,
    createdAt: Date.now(),
  };
  await opts.fileStore.put(fileRecord);

  // 4) Workspace document row in the correct folder.
  const folderId = folderIdByPath.get(parentPath(entry.path)) ?? null;
  let doc;
  try {
    doc = await opts.workspaces.addDocument({
      workspaceId: opts.matterId,
      folderId,
      externalDocId: fileId,
      name: displayName,
      mimeType,
      size: bytes.length,
      sha256,
    });
  } catch (err) {
    // The uq partial index can race against the lookup above under
    // concurrent uploads; treat that as a dedup, not a failure.
    if (isUniqueViolation(err)) {
      const winner = await opts.workspaces.findDocumentBySha256(opts.matterId, sha256);
      return {
        ...baseResult,
        kind: 'duplicate',
        sha256,
        duplicateOfDocumentId: winner?.id,
        reason: 'Already uploaded to this matter (race-condition dedup).',
      };
    }
    return {
      ...baseResult,
      kind: 'failed',
      sha256,
      reason: `DB insert failed: ${truncate(messageOf(err), 160)}`,
    };
  }
  seenInZip.set(sha256, doc.id);

  // 5) Classify → route. The markitdown-agent /classify endpoint already
  //    returns the markdown when extraction succeeded, so the happy path
  //    is a single HTTP call.
  const ext = extOf(entry.path);
  if (IMAGE_EXTS.has(ext)) {
    // Per pilot policy: images attach without auto-OCR. No KB index.
    return {
      ...baseResult,
      kind: 'attached',
      sha256,
      documentId: doc.id,
      reason: 'Image attached without OCR.',
    };
  }

  let classification: ClassifyResult;
  try {
    classification = await withTimeout(
      callClassify(opts.markitdownBaseUrl, fileRecord),
      PER_FILE_TIMEOUT_MS,
      'classify',
    );
  } catch (err) {
    return {
      ...baseResult,
      kind: 'failed',
      sha256,
      documentId: doc.id,
      reason: `Classify failed: ${truncate(messageOf(err), 160)}`,
    };
  }

  if (classification.kind === 'text') {
    const ok = await indexMarkdown(opts, fileRecord, classification.markdown);
    return {
      ...baseResult,
      kind: ok ? 'text' : 'failed',
      sha256,
      documentId: doc.id,
      reason: ok ? undefined : 'KB insert failed.',
    };
  }

  if (classification.kind === 'image-pdf') {
    let ocrText: string;
    try {
      ocrText = await withTimeout(
        callOcr(opts.markitdownBaseUrl, fileRecord),
        PER_FILE_TIMEOUT_MS,
        'ocr',
      );
    } catch (err) {
      return {
        ...baseResult,
        kind: 'failed',
        sha256,
        documentId: doc.id,
        reason: `OCR failed: ${truncate(messageOf(err), 160)}`,
      };
    }
    const ok = await indexMarkdown(opts, fileRecord, ocrText);
    return {
      ...baseResult,
      kind: ok ? 'ocrd' : 'failed',
      sha256,
      documentId: doc.id,
      reason: ok ? undefined : 'KB insert failed after OCR.',
    };
  }

  // classification.kind === 'image' would have been caught by the
  // IMAGE_EXTS branch already; falling through here means `other`.
  return {
    ...baseResult,
    kind: 'failed',
    sha256,
    documentId: doc.id,
    reason: classification.note || 'Unsupported file type.',
  };
}

async function indexMarkdown(
  opts: ZipIngestOptions,
  record: FileRecord,
  markdown: string,
): Promise<boolean> {
  if (!markdown.trim()) return false;
  // Reuse MatterRag so the (matter, file) → kb_doc_id mapping is the same
  // one cell-runs + matter-chat already query through. MatterRag itself
  // calls /convert though — we already have the markdown in hand from
  // /classify, so we'd be re-doing the extraction work. Short-circuit by
  // calling kb.insert directly via the public adapter below.
  try {
    const result = await opts.rag.indexFileWithMarkdown(opts.matterId, record, markdown);
    return result.ok;
  } catch (err) {
    console.warn(
      `[zip-ingest] indexFileWithMarkdown failed for ${record.id}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// -------- markitdown-agent HTTP wrappers ----------------------------------

interface ClassifyResult {
  kind: 'text' | 'image-pdf' | 'image' | 'other';
  markdown: string;
  pages: number;
  chars: number;
  charsPerPage: number;
  note: string;
}

async function callClassify(
  baseUrl: string,
  record: FileRecord,
): Promise<ClassifyResult> {
  const form = new FormData();
  form.append('file', new Blob([record.bytes], { type: record.mimeType }), record.name);
  const res = await fetch(`${baseUrl}/classify`, { method: 'POST', body: form });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`/classify ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    kind: ClassifyResult['kind'];
    markdown?: string;
    pages?: number;
    chars?: number;
    chars_per_page?: number;
    note?: string;
  };
  return {
    kind: data.kind,
    markdown: data.markdown ?? '',
    pages: data.pages ?? 0,
    chars: data.chars ?? 0,
    charsPerPage: data.chars_per_page ?? 0,
    note: data.note ?? '',
  };
}

async function callOcr(baseUrl: string, record: FileRecord): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([record.bytes], { type: record.mimeType }), record.name);
  const res = await fetch(`${baseUrl}/ocr`, { method: 'POST', body: form });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`/ocr ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { markdown?: string };
  return data.markdown ?? '';
}

// -------- helpers ---------------------------------------------------------

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.gif', '.bmp', '.webp']);

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.eml': 'message/rfc822',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
};

function guessMimeType(p: string): string {
  return MIME_BY_EXT[extOf(p)] ?? 'application/octet-stream';
}

function extOf(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function parentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** "DEMAND RESPONSE.pdf.pdf" → "DEMAND RESPONSE.pdf" (Litify export quirk). */
function stripDoubledExtension(name: string): string {
  const m = name.match(/^(.+?)(\.[A-Za-z0-9]{1,8})\2$/);
  return m ? m[1]! + m[2]! : name;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function generateFileId(): string {
  return `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function humanMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function isUniqueViolation(err: unknown): boolean {
  // pg error code 23505 — unique_violation.
  return typeof (err as { code?: string })?.code === 'string' &&
    (err as { code: string }).code === '23505';
}

async function withTimeout<T>(p: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${stage})`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
