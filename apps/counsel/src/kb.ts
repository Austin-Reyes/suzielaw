import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { KnowledgeBaseStore, createOpenAIEmbedder } from '@teamsuzie/kb';
import { convertDocxToMarkdown, isDocxMimeType } from '@teamsuzie/markdown-document';
import { db } from './db.js';
import { config } from './config.js';
import { getSessionUser } from './auth.js';

/**
 * Boot a KnowledgeBaseStore using the app's existing SQLite db + the
 * configured OpenAI-compatible embeddings endpoint. Returns null when KB is
 * disabled in config — callers should treat null as "no KB available".
 */
export function buildKbStore(): KnowledgeBaseStore {
  const embedder = createOpenAIEmbedder({
    baseUrl: config.kb.embeddingBaseUrl,
    apiKey: config.kb.embeddingApiKey,
    model: config.kb.embeddingModel,
    dim: config.kb.embeddingDim,
  });
  return new KnowledgeBaseStore({
    db,
    embedder,
    // Tighter chunks than the upstream default (3200/4800). Matter docs
    // are typically heading-organized contracts; smaller chunks mean
    // top-K retrieval actually focuses the model's context instead of
    // returning most of the doc. ~250 tokens per chunk, 800 token max.
    chunker: { targetSize: 1000, overlap: 150, maxSize: 1600 },
  });
}

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|x-markdown|markdown))/i;

interface IngestOptions {
  store: KnowledgeBaseStore;
  /** markitdown-agent base URL for non-DOCX/non-text binaries. Empty = those
   *  uploads will be rejected. */
  markitdownBaseUrl: string;
}

/**
 * Convert a binary upload to markdown using whichever path fits the mime
 * type, then insert into the KB. Mirrors the `convert_to_markdown` tool's
 * routing: DOCX uses mammoth in-process, text-like uploads pass through,
 * everything else routes to markitdown-agent.
 */
async function ingestFile(opts: IngestOptions, file: Express.Multer.File, ownerId?: string): Promise<{ id: string; chunkCount: number }> {
  let markdown: string;

  if (isDocxMimeType(file.mimetype) || file.originalname.toLowerCase().endsWith('.docx')) {
    const result = await convertDocxToMarkdown(file.buffer);
    markdown = result.markdown;
  } else if (TEXT_MIME.test(file.mimetype)) {
    markdown = file.buffer.toString('utf-8');
  } else if (opts.markitdownBaseUrl) {
    const form = new FormData();
    form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
    const response = await fetch(`${opts.markitdownBaseUrl}/convert`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`markitdown-agent /convert returned ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = (await response.json()) as { markdown: string };
    markdown = data.markdown;
  } else {
    throw new Error(`Unsupported file type: ${file.mimetype}. Configure SUZIELAW_MARKITDOWN_AGENT_BASE_URL to ingest non-DOCX binaries.`);
  }

  if (!markdown.trim()) throw new Error('Uploaded file converted to empty markdown — nothing to index.');

  const inserted = await opts.store.insert({
    name: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    markdown,
    ...(ownerId ? { ownerId } : {}),
  });
  return { id: inserted.id, chunkCount: inserted.chunkCount };
}

export interface CreateKbRouterOptions {
  store: KnowledgeBaseStore;
  markitdownBaseUrl: string;
  maxUploadBytes: number;
}

export function createKbRouter(opts: CreateKbRouterOptions): Router {
  const router: Router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: opts.maxUploadBytes },
  });

  router.get('/documents', (req, res) => {
    const ownerId = getSessionUser(req)?.email;
    const docs = opts.store.list(ownerId ?? null);
    const stats = opts.store.count(ownerId ?? null);
    res.json({ documents: docs, stats });
  });

  router.post('/documents', upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'file_required' });
      return;
    }
    try {
      const ownerId = getSessionUser(req)?.email;
      const result = await ingestFile(
        { store: opts.store, markitdownBaseUrl: opts.markitdownBaseUrl },
        req.file,
        ownerId,
      );
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'ingest_failed' });
    }
  });

  router.delete('/documents/:id', (req, res) => {
    const ok = opts.store.delete(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/search', async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (!query) {
      res.status(400).json({ error: 'query_required' });
      return;
    }
    const topK = Math.min(20, Math.max(1, parseInt(String(req.body?.top_k ?? 5), 10) || 5));
    try {
      const ownerId = getSessionUser(req)?.email ?? null;
      const hits = await opts.store.search(query, { topK, ownerId });
      res.json({ query, hits });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'search_failed' });
    }
  });

  return router;
}
