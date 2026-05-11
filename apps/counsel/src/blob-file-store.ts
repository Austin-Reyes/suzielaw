import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import {
  BlobServiceClient,
  type BlobClient,
  type BlockBlobClient,
  type ContainerClient,
  type HttpAuthorization,
} from '@azure/storage-blob';
import { Readable } from 'node:stream';

import type {
  FileMetaSidecar,
  FileMetadata,
  FileRecord,
  FileStore,
} from './files.js';

const FOUR_MIB = 4 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;
const MAX_BATCH_DELETE = 256;
const STORAGE_SCOPE = 'https://storage.azure.com/.default';

export interface BlobFileStoreOptions {
  /** Storage account name, e.g. "stcounsel20bf". */
  account: string;
  /** Container name, e.g. "matter-uploads". */
  container: string;
  /** Credential — defaults to DefaultAzureCredential. Override for tests. */
  credential?: TokenCredential;
}

/**
 * Azure Blob-backed FileStore.
 *
 * Blob layout:
 *   {container}/{sessionId-url-encoded}/{fileId-url-encoded}.bin
 *   {container}/{sessionId-url-encoded}/{fileId-url-encoded}.meta.json
 *
 * The public FileStore contract is async because blob I/O cannot be made
 * synchronous honestly. InMemoryFileStore implements the same async surface
 * for local dev and tests.
 */
export class BlobFileStore implements FileStore {
  private readonly credential: TokenCredential;
  private readonly service: BlobServiceClient;
  private readonly container: ContainerClient;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(opts: BlobFileStoreOptions) {
    this.credential = opts.credential ?? new DefaultAzureCredential();
    this.service = new BlobServiceClient(
      `https://${opts.account}.blob.core.windows.net`,
      this.credential,
    );
    this.container = this.service.getContainerClient(opts.container);
  }

  async put(record: FileRecord): Promise<void> {
    await this.withKeyLock(record.sessionId, record.id, async () => {
      await this.uploadBytes(record);
      await this.uploadMeta(toMeta(record));
    });
  }

  async get(sessionId: string, fileId: string): Promise<FileRecord | undefined> {
    try {
      const meta = await this.downloadMeta(sessionId, fileId);
      if (!meta) return undefined;
      const bytes = await this.binClient(sessionId, fileId).downloadToBuffer();
      return { ...meta, bytes };
    } catch (err) {
      if (isBlobNotFound(err)) return undefined;
      throw err;
    }
  }

  async getMany(sessionId: string, fileIds: string[]): Promise<FileRecord[]> {
    const records = await Promise.all(
      fileIds.map((fileId) => this.get(sessionId, fileId)),
    );
    return records.filter((rec): rec is FileRecord => rec !== undefined);
  }

  async copyMany(
    fromSessionId: string,
    toSessionId: string,
    fileIds: string[],
  ): Promise<FileMetadata[]> {
    const copied = await Promise.all(
      fileIds.map((fileId) =>
        this.copyOne(fromSessionId, toSessionId, fileId),
      ),
    );
    return copied.filter((meta): meta is FileMetadata => meta !== null);
  }

  async delete(sessionId: string, fileId: string): Promise<boolean> {
    return this.withKeyLock(sessionId, fileId, async () => {
      const [binRemoved, metaRemoved] = await Promise.all([
        this.deleteBlobIfExists(this.binClient(sessionId, fileId)),
        this.deleteBlobIfExists(this.metaClient(sessionId, fileId)),
      ]);
      return binRemoved || metaRemoved;
    });
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.deletePrefix(`${encodeURIComponent(sessionId)}/`);
  }

  /**
   * Expensive admin reset path: lists every blob in the container and deletes
   * in 256-blob batches. Only used by /api/admin/reset.
   */
  async clearAll(): Promise<number> {
    return this.deletePrefix('');
  }

  private async copyOne(
    fromSessionId: string,
    toSessionId: string,
    fileId: string,
  ): Promise<FileMetadata | null> {
    const meta = await this.downloadMeta(fromSessionId, fileId);
    if (!meta) return null;

    const next: FileMetaSidecar = { ...meta, sessionId: toSessionId };
    const sourceBin = this.binClient(fromSessionId, fileId);
    const destBin = this.binClient(toSessionId, fileId);
    const sourceAuthorization = await this.sourceAuthorization();

    try {
      await this.withKeyLock(toSessionId, fileId, async () => {
        await destBin.syncCopyFromURL(sourceBin.url, { sourceAuthorization });
        await this.uploadMeta(next);
      });
    } catch (err) {
      if (isBlobNotFound(err)) return null;
      throw err;
    }

    return {
      id: next.id,
      name: next.name,
      mimeType: next.mimeType,
      size: next.size,
    };
  }

  private async uploadBytes(record: FileRecord): Promise<void> {
    await this.binClient(record.sessionId, record.id).uploadStream(
      Readable.from([record.bytes]),
      FOUR_MIB,
      UPLOAD_CONCURRENCY,
      {
        blobHTTPHeaders: {
          blobContentType: record.mimeType || 'application/octet-stream',
        },
      },
    );
  }

  private async uploadMeta(meta: FileMetaSidecar): Promise<void> {
    const json = JSON.stringify(meta);
    await this.metaClient(meta.sessionId, meta.id).uploadStream(
      Readable.from([Buffer.from(json, 'utf8')]),
      FOUR_MIB,
      1,
      {
        blobHTTPHeaders: { blobContentType: 'application/json' },
      },
    );
  }

  private async downloadMeta(
    sessionId: string,
    fileId: string,
  ): Promise<FileMetaSidecar | undefined> {
    try {
      const bytes = await this.metaClient(sessionId, fileId).downloadToBuffer();
      return JSON.parse(bytes.toString('utf8')) as FileMetaSidecar;
    } catch (err) {
      if (isBlobNotFound(err)) return undefined;
      throw err;
    }
  }

  private async sourceAuthorization(): Promise<HttpAuthorization> {
    const token = await this.credential.getToken(STORAGE_SCOPE);
    if (!token) throw new Error('Azure credential returned no storage token');
    return { scheme: 'Bearer', value: token.token };
  }

  private async deletePrefix(prefix: string): Promise<number> {
    const batchClient = this.container.getBlobBatchClient();
    let blobClients: BlobClient[] = [];
    let recordCount = 0;

    const flush = async () => {
      if (blobClients.length === 0) return;
      const current = blobClients;
      blobClients = [];
      await batchClient.deleteBlobs(current, { deleteSnapshots: 'include' });
    };

    for await (const blob of this.container.listBlobsFlat({ prefix })) {
      if (blob.name.endsWith('.meta.json')) recordCount += 1;
      blobClients.push(this.container.getBlobClient(blob.name));
      if (blobClients.length >= MAX_BATCH_DELETE) await flush();
    }
    await flush();
    return recordCount;
  }

  private async deleteBlobIfExists(client: BlobClient): Promise<boolean> {
    try {
      await client.delete({ deleteSnapshots: 'include' });
      return true;
    } catch (err) {
      if (isBlobNotFound(err)) return false;
      throw err;
    }
  }

  private binClient(sessionId: string, fileId: string): BlockBlobClient {
    return this.container.getBlockBlobClient(blobName(sessionId, fileId, '.bin'));
  }

  private metaClient(sessionId: string, fileId: string): BlockBlobClient {
    return this.container.getBlockBlobClient(
      blobName(sessionId, fileId, '.meta.json'),
    );
  }

  private async withKeyLock<T>(
    sessionId: string,
    fileId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `${encodeURIComponent(sessionId)}/${encodeURIComponent(fileId)}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tracked = run.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.locks.get(key) === tracked) this.locks.delete(key);
    });
    this.locks.set(key, tracked);
    return run;
  }
}

function blobName(sessionId: string, fileId: string, suffix: string): string {
  return `${encodeURIComponent(sessionId)}/${encodeURIComponent(fileId)}${suffix}`;
}

function toMeta(record: FileRecord): FileMetaSidecar {
  return {
    id: record.id,
    sessionId: record.sessionId,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    createdAt: record.createdAt,
  };
}

function isBlobNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    statusCode?: number;
    code?: string;
    details?: { errorCode?: string };
  };
  return (
    e.statusCode === 404 ||
    e.code === 'BlobNotFound' ||
    e.details?.errorCode === 'BlobNotFound'
  );
}
