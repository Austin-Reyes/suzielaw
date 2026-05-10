import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { KnowledgeBaseStore } from '@counsel/kb';
import type { AnyToolDefinition } from '@teamsuzie/agent-loop';
import { convertDocxToMarkdown, isDocxMimeType } from '@teamsuzie/markdown-document';
import { config } from './config.js';
import { getSessionUser } from './auth.js';

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|x-markdown|markdown))/i;

interface IngestOptions {
  store: KnowledgeBaseStore;
  /** markitdown-agent base URL for non-DOCX/non-text binaries. Empty = those
   *  uploads will be rejected. */
  markitdownBaseUrl: string;
}

async function ingestFile(
  opts: IngestOptions,
  file: Express.Multer.File,
  ownerId?: string,
): Promise<{ id: string; chunkCount: number }> {
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
    throw new Error(
      `Unsupported file type: ${file.mimetype}. Configure COUNSEL_MARKITDOWN_AGENT_BASE_URL to ingest non-DOCX binaries.`,
    );
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

/**
 * Build a `kb_search` tool for `@teamsuzie/agent-loop` that wraps the
 * @counsel/kb store. Mirrors the upstream `createKbSearchTool` from
 * `@teamsuzie/kb` so the agent prompt + UX stays identical — this lives
 * here because the upstream factory is typed against the SQLite store.
 */
export interface KbSearchToolOptions {
  store: KnowledgeBaseStore;
  defaultTopK?: number;
  maxTopK?: number;
  getOwnerId?: () => string | null | undefined;
  name?: string;
  description?: string;
}

export function createKbSearchTool(opts: KbSearchToolOptions): AnyToolDefinition {
  const defaultTopK = opts.defaultTopK ?? 5;
  const maxTopK = opts.maxTopK ?? 20;
  return {
    name: opts.name ?? 'kb_search',
    description:
      opts.description ??
      "Semantic search over the user's knowledge base. Use this when answering a question that may be addressed by previously uploaded documents — contracts, memos, policies, prior matters, or any reference material the user has indexed. Returns the most relevant chunks with their parent document name and a distance score (lower = closer).",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The semantic query. Phrase as a natural-language question or topic — not as keywords.',
        },
        top_k: {
          type: 'number',
          description: `How many chunks to return. Default ${defaultTopK}, max ${maxTopK}.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args: { query: string; top_k?: number }) {
      const topK = Math.min(Math.max(1, Math.floor(args.top_k ?? defaultTopK)), maxTopK);
      const ownerId = opts.getOwnerId?.() ?? null;
      const hits = await opts.store.search(args.query, { topK, ownerId });
      return {
        query: args.query,
        hits: hits.map((h) => ({
          document_id: h.document.id,
          document_name: h.document.name,
          chunk_index: h.chunk.chunkIndex,
          content: h.chunk.content,
          distance: h.distance,
        })),
      };
    },
  } as unknown as AnyToolDefinition;
}

export function createKbRouter(opts: CreateKbRouterOptions): Router {
  const router: Router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: opts.maxUploadBytes },
  });

  router.get('/documents', async (req, res) => {
    try {
      const ownerId = getSessionUser(req)?.email;
      const [docs, stats] = await Promise.all([
        Promise.resolve(opts.store.list(ownerId ?? null)),
        Promise.resolve(opts.store.count(ownerId ?? null)),
      ]);
      res.json({ documents: docs, stats });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'list_failed' });
    }
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

  router.delete('/documents/:id', async (req, res) => {
    try {
      const ok = await Promise.resolve(opts.store.delete(req.params.id));
      if (!ok) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'delete_failed' });
    }
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
