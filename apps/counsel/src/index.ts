import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovalQueue, InMemoryApprovalStore } from '@teamsuzie/approvals';
import {
  connectMcpServers,
  loadSkills,
  parseMcpConfigFile,
  resolveAgentTarget,
  runChatTurn,
  tools as builtInTools,
  type AnyToolDefinition,
  type ChatMessage,
  type McpManager,
  type SkillLoadResult,
  type ToolContext,
} from '@teamsuzie/agent-loop';
import { config } from './config.js';
import {
  createAuthRouter,
  createSessionMiddleware,
  easyAuthBridgeMiddleware,
  getSessionUser,
  requireAuth,
} from './auth.js';
import {
  createCsrfMiddleware,
  createOAuthRouter,
  createTokenMeteredFetch,
  TokenBudgetStore,
  TokenLimitExceededError,
} from '@teamsuzie/hosted-demo';
import {
  buildAttachmentContext,
  buildCitationProtocolBlock,
  createFilesRouter,
  createMatterUploadsRouter,
  InMemoryFileStore,
} from './files.js';
import { InMemoryDocumentStore } from '@teamsuzie/markdown-document';
import { buildDocumentTools } from './document-tools.js';
import { buildCourtListenerTools } from './tools/courtlistener.js';
import { buildDiffTools } from './tools/diff.js';
import { buildProposeEditsTools } from './tools/propose-edits.js';
import { buildFindInDocumentTools } from './tools/find-in-document.js';
import { buildReplicateDocumentTools } from './tools/replicate-document.js';
import { buildGenerateDocxTools } from './tools/generate-docx.js';
import { applyWorkflowOverrides } from './workflow-overrides.js';
import { buildTemplateTools } from './tools/templates.js';
import { applyPersona, createPersonasRouter, PersonaRegistry } from '@teamsuzie/personas';
import { validateLocalAgentUrl } from '@teamsuzie/agent-loop';
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_IDS, providerForModel, wireModelIdFor } from './cloud-providers.js';
import type { Workspace, WorkspaceDocument } from '@counsel/workspaces';
import {
  backfillMatterOwnership,
  createMatterMembersRouter,
  createRequireMatterAccess,
  createWorkflowMembersRouter,
  listVisibleWorkflowsForUser,
  resolveWorkflowRole,
} from './sharing.js';
import type { CellFormat, ReviewColumn, ReviewDocument } from '@counsel/grid-review';
import type { RunCellAdapter } from '@teamsuzie/grid-review';
import { buildReviewRunAdapter } from './reviews-glue.js';
import type { Chat } from '@counsel/chats';
import type { WorkflowColumnConfig, WorkflowOutputMode } from '@counsel/workflows';
import { WORKFLOW_OUTPUT_MODES } from '@counsel/workflows';
import { seedAndMigrateWorkflows } from './seed-workflows.js';
import { parseResponse } from '@teamsuzie/citations';
import type { FileRecord } from './files.js';
import { MatterRag, type MatterDocIndexDB } from './matter-rag.js';
import type { Kysely as KyselyType } from 'kysely';
import { createKbRouter, createKbSearchTool } from './kb.js';
import { bootstrapCounselDb } from './pg-db.js';
import { draftColumnPrompt } from './column-draft.js';
import { buildReviewWorkbook } from './reviews-export.js';
import { runDocumentDiff } from './diff-engine.js';
import { composeRedlineDocx, redlineDownloadFilename } from './redline-export.js';
import { extractRedlineParagraphs } from './redline-view.js';
import { acceptRevision, loadDocx, rejectRevision } from '@teamsuzie/docx';
import { draftChatTitle } from './chat-title.js';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistDir = path.resolve(__dirname, '../client/dist');

// @counsel/* Postgres handle. Top-level await: tsconfig is ESM + NodeNext,
// so the runtime + tsx both resolve this without ceremony. bootstrapCounselDb()
// runs migrations, constructs every @counsel store, and caches the result —
// it's the single gate for every postgres-backed surface in this file.
const counselDb = await bootstrapCounselDb();

const approvals = new ApprovalQueue({ store: new InMemoryApprovalStore() });
const fileStore = new InMemoryFileStore();
const docStore = new InMemoryDocumentStore();
const tokenBudget = new TokenBudgetStore(db, config.tokenBudget.defaultLimit);

let skillState: SkillLoadResult = { skills: [], systemPrompt: '', derivedHosts: [] };
let mcp: McpManager = { tools: [], status: [], shutdown: async () => {} };
let templateTools: AnyToolDefinition[] = [];

const courtListenerTools = buildCourtListenerTools({
  token: config.courtlistener.token,
  baseUrl: config.courtlistener.baseUrl,
});
if (courtListenerTools.length > 0) {
  console.log(
    `CourtListener tools enabled${config.courtlistener.token ? ' (authenticated)' : ' (unauthenticated; lower rate limits)'}: ${courtListenerTools
      .map((t) => t.name)
      .join(', ')}`,
  );
}

const personaRegistry = new PersonaRegistry({
  filesystemDir: config.personas.dir,
  db,
});
if (personaRegistry.listBuiltins().length > 0) {
  console.log(
    `Loaded ${personaRegistry.listBuiltins().length} builtin persona(s): ${personaRegistry
      .listBuiltins()
      .map((p) => p.id)
      .join(', ')}`,
  );
}

// Per-user model-endpoint overrides (the editable config behind each Local row).
const modelSettings = counselDb.stores.modelSettings;

// Workspaces (legal apps surface them as "Matters") — backed by
// @counsel/workspaces. The /api/matters surface is inlined below
// (replaces upstream createWorkspacesRouter, whose signature is sync).
const workspaces = counselDb.stores.workspaces;

// Document version chains. Every matter-doc upload records a
// `source: 'upload'` version; chat-driven proposals branch from that
// with `source: 'proposal'`. No HTTP surface yet — host code reads it
// via the store directly.
const documentVersions = counselDb.stores.documentVersions;

// Cross-subject membership store. Ownership of matters is encoded as
// an owner-role member row added at matter-creation time (see the POST
// /api/matters shadow below). Existing pre-membership matters are
// backfilled to the demo user at boot — single-user demo bridge.
const members = counselDb.stores.members;
{
  const { granted } = await backfillMatterOwnership({
    members,
    workspaces,
    ownerEmail: config.demo.email,
  });
  if (granted > 0) {
    console.log(`Sharing: backfilled ${granted} matter(s) with owner=${config.demo.email}`);
  }
}
const requireMatterAccess = createRequireMatterAccess({ members, workspaces });

// Tabular reviews. Mounted under /api/matters/:matterId/reviews via the
// inline async router below (replaces upstream createReviewsRouter).
const reviews = counselDb.stores.reviews;
{
  const recovered = await reviews.recoverStaleStreaming();
  if (recovered > 0) {
    console.log(`Reviews: reset ${recovered} stale streaming cell(s) to pending after restart.`);
  }
}

// Persisted matter/review/assistant chats — backed by @counsel/chats. The
// `workspace_id` column is opaque, so the same store/table backs all three
// surfaces by namespace prefix (`<matterId>`, `review:<id>`, `assistant:<email>`).
const chats = counselDb.stores.chats;

/**
 * Inline async router factory mirroring the upstream `createChatsRouter`
 * shape from `@teamsuzie/chats`. Mounts the standard chat CRUD endpoints
 * against `chats` (the @counsel/chats store) under whatever prefix the
 * caller chooses, scoping ownership to a `getWorkspaceId(req)` callback.
 */
function createCounselChatsRouter(
  getWorkspaceId: (req: express.Request) => string,
): express.Router {
  const router: express.Router = express.Router();

  router.get('/', async (req, res) => {
    res.json({ items: await chats.listChats(getWorkspaceId(req)) });
  });

  router.post('/', async (req, res) => {
    const workspaceId = getWorkspaceId(req);
    const body = req.body as Record<string, unknown> | undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
    let personaId: string | null | undefined;
    if (body && 'personaId' in body) {
      const raw = body.personaId;
      personaId = typeof raw === 'string' && raw.length > 0 ? raw : null;
    }
    const chat = await chats.createChat({ workspaceId, name, personaId });
    res.status(201).json({ item: chat });
  });

  router.get('/:chatId', async (req, res) => {
    const chatId = String(req.params.chatId ?? '');
    const chat = await chats.getChat(chatId);
    if (!chat || chat.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ item: chat });
  });

  router.get('/:chatId/messages', async (req, res) => {
    const chatId = String(req.params.chatId ?? '');
    const chat = await chats.getChat(chatId);
    if (!chat || chat.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ items: await chats.listMessages(chatId) });
  });

  router.patch('/:chatId', async (req, res) => {
    const chatId = String(req.params.chatId ?? '');
    const chat = await chats.getChat(chatId);
    if (!chat || chat.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const patch: { name?: string; personaId?: string | null } = {};
    if (typeof body?.name === 'string') {
      const trimmed = body.name.trim();
      if (!trimmed) {
        res.status(400).json({ error: 'name cannot be empty' });
        return;
      }
      patch.name = trimmed;
    }
    if (body && 'personaId' in body) {
      const raw = body.personaId;
      patch.personaId = typeof raw === 'string' && raw.length > 0 ? raw : null;
    }
    const updated = await chats.updateChat(chatId, patch);
    res.json({ item: updated });
  });

  router.delete('/:chatId/messages', async (req, res) => {
    const chatId = String(req.params.chatId ?? '');
    const chat = await chats.getChat(chatId);
    if (!chat || chat.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const removed = await chats.clearMessages(chatId);
    res.json({ ok: true, removed });
  });

  router.delete('/:chatId', async (req, res) => {
    const chatId = String(req.params.chatId ?? '');
    const chat = await chats.getChat(chatId);
    if (!chat || chat.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await chats.deleteChat(chatId);
    res.json({ ok: true });
  });

  return router;
}

const VALID_REVIEW_FORMATS: ReadonlyArray<CellFormat> = [
  'text',
  'short_text',
  'date',
  'yes_no',
  'bullets',
  'money',
];

/**
 * Inline async router factory mirroring upstream `createReviewsRouter`,
 * scoped to the @counsel/grid-review store. Mounts CRUD + the SSE
 * cell/run + review/run streaming endpoints. The runner side
 * (`runCellWithFormat`, `LlmStream`, etc.) stays on @teamsuzie — the
 * runAdapter abstracts that so this factory only deals with persistence
 * + streaming framing.
 */
function createCounselReviewsRouter(
  getWorkspaceId: (req: express.Request) => string,
  runAdapter: RunCellAdapter | undefined,
): express.Router {
  const router: express.Router = express.Router();

  router.get('/', async (req, res) => {
    const workspaceId = getWorkspaceId(req);
    res.json({ items: await reviews.listReviews(workspaceId) });
  });

  router.post('/', async (req, res) => {
    const workspaceId = getWorkspaceId(req);
    const body = req.body as Record<string, unknown> | undefined;
    const name = String(body?.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const description =
      typeof body?.description === 'string' && body.description.trim().length > 0
        ? body.description.trim()
        : null;
    const review = await reviews.createReview({ workspaceId, name, description });
    res.status(201).json({ item: review });
  });

  router.get('/:reviewId', async (req, res) => {
    const reviewId = String(req.params.reviewId ?? '');
    const snap = await reviews.getReviewSnapshot(reviewId);
    if (!snap || snap.review.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ snapshot: snap });
  });

  router.patch('/:reviewId', async (req, res) => {
    const reviewId = String(req.params.reviewId ?? '');
    const review = await reviews.getReview(reviewId);
    if (!review || review.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const patch: { name?: string; description?: string | null } = {};
    if (typeof body?.name === 'string') {
      const trimmed = body.name.trim();
      if (!trimmed) {
        res.status(400).json({ error: 'name cannot be empty' });
        return;
      }
      patch.name = trimmed;
    }
    if (body && 'description' in body) {
      const d = body.description;
      if (d === null) patch.description = null;
      else if (typeof d === 'string') {
        const trimmed = d.trim();
        patch.description = trimmed.length > 0 ? trimmed : null;
      } else {
        res.status(400).json({ error: 'description must be a string or null' });
        return;
      }
    }
    const updated = await reviews.updateReview(reviewId, patch);
    res.json({ item: updated });
  });

  router.delete('/:reviewId', async (req, res) => {
    const reviewId = String(req.params.reviewId ?? '');
    const review = await reviews.getReview(reviewId);
    if (!review || review.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await reviews.deleteReview(reviewId);
    res.json({ ok: true });
  });

  router.post('/:reviewId/columns', async (req, res) => {
    const reviewId = String(req.params.reviewId ?? '');
    const review = await reviews.getReview(reviewId);
    if (!review || review.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const title = String(body?.title || '').trim();
    const prompt = String(body?.prompt || '').trim();
    if (!title || !prompt) {
      res.status(400).json({ error: 'title and prompt are required' });
      return;
    }
    let format: CellFormat = 'text';
    if (typeof body?.format === 'string') {
      if (!VALID_REVIEW_FORMATS.includes(body.format as CellFormat)) {
        res.status(400).json({ error: 'unknown format' });
        return;
      }
      format = body.format as CellFormat;
    }
    const position =
      typeof body?.position === 'number' && Number.isInteger(body.position)
        ? body.position
        : (await reviews.listColumns(reviewId)).length;
    const col = await reviews.addColumn({ reviewId, title, prompt, format, position });
    res.status(201).json({ item: col });
  });

  router.patch('/:reviewId/columns/:colId', async (req, res) => {
    const reviewId = String(req.params.reviewId ?? '');
    const colId = String(req.params.colId ?? '');
    const review = await reviews.getReview(reviewId);
    const column = await reviews.getColumn(colId);
    if (
      !review ||
      review.workspaceId !== getWorkspaceId(req) ||
      !column ||
      column.reviewId !== reviewId
    ) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const patch: {
      title?: string;
      prompt?: string;
      format?: CellFormat;
      position?: number;
    } = {};
    if (typeof body?.title === 'string') {
      const trimmed = body.title.trim();
      if (!trimmed) {
        res.status(400).json({ error: 'title cannot be empty' });
        return;
      }
      patch.title = trimmed;
    }
    if (typeof body?.prompt === 'string') {
      const trimmed = body.prompt.trim();
      if (!trimmed) {
        res.status(400).json({ error: 'prompt cannot be empty' });
        return;
      }
      patch.prompt = trimmed;
    }
    if (typeof body?.format === 'string') {
      if (!VALID_REVIEW_FORMATS.includes(body.format as CellFormat)) {
        res.status(400).json({ error: 'unknown format' });
        return;
      }
      patch.format = body.format as CellFormat;
    }
    if (typeof body?.position === 'number' && Number.isInteger(body.position)) {
      patch.position = body.position;
    }
    const updated = await reviews.updateColumn(colId, patch);
    res.json({ item: updated });
  });

  router.delete('/:reviewId/columns/:colId', async (req, res) => {
    const reviewId = String(req.params.reviewId ?? '');
    const colId = String(req.params.colId ?? '');
    const review = await reviews.getReview(reviewId);
    const column = await reviews.getColumn(colId);
    if (
      !review ||
      review.workspaceId !== getWorkspaceId(req) ||
      !column ||
      column.reviewId !== reviewId
    ) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await reviews.removeColumn(colId);
    res.json({ ok: true });
  });

  router.post('/:reviewId/documents', async (req, res) => {
    const reviewId = String(req.params.reviewId ?? '');
    const review = await reviews.getReview(reviewId);
    if (!review || review.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const externalDocId = String(body?.externalDocId || '').trim();
    const name = String(body?.name || '').trim();
    if (!externalDocId || !name) {
      res.status(400).json({ error: 'externalDocId and name are required' });
      return;
    }
    const mimeType =
      typeof body?.mimeType === 'string' && body.mimeType.length > 0
        ? body.mimeType
        : null;
    const position =
      typeof body?.position === 'number' && Number.isInteger(body.position)
        ? body.position
        : (await reviews.listDocuments(reviewId)).length;
    try {
      const row = await reviews.addDocument({
        reviewId,
        externalDocId,
        name,
        mimeType,
        position,
      });
      res.status(201).json({ item: row });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed';
      // The unique constraint on (review_id, external_doc_id) trips here.
      // Postgres surfaces this as `23505 duplicate key`; sqlite/upstream
      // surfaced it as a string match on `UNIQUE`. Match either.
      if (/UNIQUE|duplicate key/i.test(message)) {
        res.status(409).json({ error: 'document already in review' });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  router.delete('/:reviewId/documents/:rowId', async (req, res) => {
    const reviewId = String(req.params.reviewId ?? '');
    const rowId = String(req.params.rowId ?? '');
    const review = await reviews.getReview(reviewId);
    const row = await reviews.getDocument(rowId);
    if (
      !review ||
      review.workspaceId !== getWorkspaceId(req) ||
      !row ||
      row.reviewId !== reviewId
    ) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await reviews.removeDocument(rowId);
    res.json({ ok: true });
  });

  router.post('/:reviewId/cells/run', async (req, res) => {
    if (!runAdapter) {
      res.status(501).json({ error: 'run adapter not configured' });
      return;
    }
    const reviewId = String(req.params.reviewId ?? '');
    const review = await reviews.getReview(reviewId);
    if (!review || review.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const columnId = String(body?.columnId ?? '');
    const reviewDocumentId = String(body?.reviewDocumentId ?? '');
    const column = await reviews.getColumn(columnId);
    const document = await reviews.getDocument(reviewDocumentId);
    if (!column || column.reviewId !== reviewId) {
      res.status(404).json({ error: 'column not found' });
      return;
    }
    if (!document || document.reviewId !== reviewId) {
      res.status(404).json({ error: 'row not found' });
      return;
    }
    await reviews.upsertCell({
      reviewId,
      columnId: column.id,
      reviewDocumentId: document.id,
      status: 'pending',
      value: null,
      citations: null,
      error: null,
    });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      send({ type: 'start', columnId: column.id, rowId: document.id });
      let accumulated = '';
      let finalCell: Awaited<ReturnType<typeof reviews.upsertCell>> | null = null;
      try {
        for await (const event of runAdapter({
          request: req,
          workspaceId: review.workspaceId,
          // @counsel types use Date for added_at/created_at; upstream
          // RunCellAdapter expects number-typed timestamps. Adapter
          // implementations only read string fields, so the shape mismatch
          // is purely cosmetic — cast through unknown.
          document: document as unknown as Parameters<RunCellAdapter>[0]['document'],
          column: column as unknown as Parameters<RunCellAdapter>[0]['column'],
          signal: abort.signal,
        })) {
          if (event.type === 'token') {
            accumulated += event.text;
            await reviews.upsertCell({
              reviewId,
              columnId: column.id,
              reviewDocumentId: document.id,
              status: 'streaming',
              value: accumulated,
            });
            send({ type: 'cell_token', columnId: column.id, rowId: document.id, text: event.text });
          } else if (event.type === 'retrieved') {
            send({
              type: 'cell_retrieved',
              columnId: column.id,
              rowId: document.id,
              summary: event.summary,
              chunkCount: event.chunkCount,
              chunks: event.chunks,
              retrievalQuery: event.retrievalQuery,
            });
          } else if (event.type === 'done') {
            finalCell = await reviews.upsertCell({
              reviewId,
              columnId: column.id,
              reviewDocumentId: document.id,
              status: 'done',
              value: event.text,
              // @counsel/grid-review's jsonb column accepts arrays directly.
              citations: event.citations as unknown as unknown[],
              error: null,
            });
          } else if (event.type === 'error') {
            finalCell = await reviews.upsertCell({
              reviewId,
              columnId: column.id,
              reviewDocumentId: document.id,
              status: 'error',
              error: event.error.message,
            });
          }
        }
      } catch (err) {
        finalCell = await reviews.upsertCell({
          reviewId,
          columnId: column.id,
          reviewDocumentId: document.id,
          status: 'error',
          error: err instanceof Error ? err.message : 'failed',
        });
      }
      send({
        type: 'done',
        columnId: column.id,
        rowId: document.id,
        cellId: finalCell?.id ?? null,
        status: finalCell?.status ?? 'error',
      });
    } finally {
      res.end();
    }
  });

  router.post('/:reviewId/run', async (req, res) => {
    if (!runAdapter) {
      res.status(501).json({ error: 'run adapter not configured' });
      return;
    }
    const reviewId = String(req.params.reviewId ?? '');
    const review = await reviews.getReview(reviewId);
    if (!review || review.workspaceId !== getWorkspaceId(req)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const columns = await reviews.listColumns(reviewId);
    const docs = await reviews.listDocuments(reviewId);
    const cells = await reviews.listCells(reviewId);
    const cellByKey = new Map(cells.map((c) => [`${c.columnId}::${c.reviewDocumentId}`, c]));
    const pending: { column: ReviewColumn; document: ReviewDocument }[] = [];
    for (const doc of docs) {
      for (const col of columns) {
        const existing = cellByKey.get(`${col.id}::${doc.id}`);
        if (!existing || existing.status === 'pending' || existing.status === 'error') {
          pending.push({ column: col, document: doc });
        }
      }
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      send({ type: 'start', total: pending.length });
      for (const { column, document } of pending) {
        if (abort.signal.aborted) break;
        send({ type: 'cell_start', columnId: column.id, rowId: document.id });
        let accumulated = '';
        let finalCell: Awaited<ReturnType<typeof reviews.upsertCell>> | null = null;
        try {
          for await (const event of runAdapter({
            request: req,
            workspaceId: review.workspaceId,
            document: document as unknown as Parameters<RunCellAdapter>[0]['document'],
            column: column as unknown as Parameters<RunCellAdapter>[0]['column'],
            signal: abort.signal,
          })) {
            if (event.type === 'token') {
              accumulated += event.text;
              await reviews.upsertCell({
                reviewId,
                columnId: column.id,
                reviewDocumentId: document.id,
                status: 'streaming',
                value: accumulated,
              });
              send({ type: 'cell_token', columnId: column.id, rowId: document.id, text: event.text });
            } else if (event.type === 'retrieved') {
              send({
                type: 'cell_retrieved',
                columnId: column.id,
                rowId: document.id,
                summary: event.summary,
                chunkCount: event.chunkCount,
                chunks: event.chunks,
                retrievalQuery: event.retrievalQuery,
              });
            } else if (event.type === 'done') {
              finalCell = await reviews.upsertCell({
                reviewId,
                columnId: column.id,
                reviewDocumentId: document.id,
                status: 'done',
                value: event.text,
                citations: event.citations as unknown as unknown[],
                error: null,
              });
            } else if (event.type === 'error') {
              finalCell = await reviews.upsertCell({
                reviewId,
                columnId: column.id,
                reviewDocumentId: document.id,
                status: 'error',
                error: event.error.message,
              });
            }
          }
        } catch (err) {
          finalCell = await reviews.upsertCell({
            reviewId,
            columnId: column.id,
            reviewDocumentId: document.id,
            status: 'error',
            error: err instanceof Error ? err.message : 'failed',
          });
        }
        send({
          type: 'cell_done',
          columnId: column.id,
          rowId: document.id,
          cellId: finalCell?.id ?? null,
          status: finalCell?.status ?? 'error',
        });
      }
      send({ type: 'done' });
    } finally {
      res.end();
    }
  });

  return router;
}

// Workflows-as-data. System workflows seed at startup from code-defined
// catalogs; user workflows are created via UI.
const workflows = counselDb.stores.workflows;
await seedAndMigrateWorkflows(workflows);

// Knowledge base — Postgres + pgvector via @counsel/kb. Always available
// now: matter docs are indexed into it for cell runs (and later matter
// chats), regardless of the user-facing KB feature flag. The flag below
// only controls whether to expose the user-facing KB router + the
// `kb_search` chat tool.
const kbStore = counselDb.stores.kb;
{
  const stats = await kbStore.count(null);
  console.log(
    `Knowledge base store ready: ${stats.documents} document(s), ${stats.chunks} chunk(s); embeddings via ${config.kb.embeddingModel} (dim ${config.kb.embeddingDim}) at ${config.kb.embeddingBaseUrl}`,
  );
}
const kbSearchTool = config.kb.enabled
  ? createKbSearchTool({ store: kbStore })
  : null;

// Per-matter RAG glue: indexes uploaded matter docs into kbStore (with
// owner_id = matter:<matterId>) and exposes per-doc + per-matter search.
//
// The Kysely cast is the boundary between the broad app DB type (every
// @counsel/* table union'd) and MatterRag's narrow `matter_doc_index`
// view — Kysely's DB generic is invariant in TS, so the wider handle
// has to be re-typed at the seam.
const matterRag = new MatterRag({
  db: counselDb.kysely as unknown as KyselyType<MatterDocIndexDB>,
  kb: kbStore,
  markitdownBaseUrl: config.markitdown.baseUrl,
});

// Body-parsing helpers for the inline /api/workflows routes — same shape
// as the upstream router used to validate, kept tight to one file.
function parseWorkflowOutputMode(raw: unknown): WorkflowOutputMode | undefined {
  if (typeof raw !== 'string') return undefined;
  return WORKFLOW_OUTPUT_MODES.includes(raw as WorkflowOutputMode)
    ? (raw as WorkflowOutputMode)
    : undefined;
}

function parseWorkflowColumnConfig(
  raw: unknown,
): WorkflowColumnConfig[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) return undefined;
  const out: WorkflowColumnConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : '';
    const format = typeof e.format === 'string' ? e.format.trim() : '';
    if (!title || !prompt || !format) continue;
    out.push({ title, prompt, format });
  }
  return out;
}

function activeTools(): AnyToolDefinition[] {
  const out: AnyToolDefinition[] = [...builtInTools, ...courtListenerTools, ...templateTools, ...mcp.tools];
  if (kbSearchTool) out.push(kbSearchTool as unknown as AnyToolDefinition);
  return out;
}

async function bootstrapTemplates(): Promise<void> {
  try {
    templateTools = await buildTemplateTools({ templatesDir: config.templates.dir });
  } catch (error) {
    console.error('Template load failed:', error instanceof Error ? error.message : error);
  }
}

async function bootstrapMcp(): Promise<void> {
  if (!config.mcp.configPath) return;
  try {
    const servers = parseMcpConfigFile(config.mcp.configPath);
    if (servers.length === 0) return;
    mcp = await connectMcpServers({ servers });
    for (const status of mcp.status) {
      if (status.connected) {
        console.log(`MCP server "${status.name}" connected (${status.toolCount} tool(s))`);
      } else {
        console.warn(`MCP server "${status.name}" failed: ${status.error ?? 'unknown error'}`);
      }
    }
  } catch (error) {
    console.error('MCP bootstrap failed:', error instanceof Error ? error.message : error);
  }
}

async function bootstrapSkills(): Promise<void> {
  if (!config.skills.skillsDir && !config.skills.catalogUrl) return;
  try {
    skillState = await loadSkills({
      skillsDir: config.skills.skillsDir,
      catalogUrl: config.skills.catalogUrl,
      catalogToken: config.skills.catalogToken,
      allow: config.skills.allow.length ? config.skills.allow : undefined,
      renderContext: config.skills.renderContext,
    });
    if (skillState.skills.length > 0) {
      console.log(
        `Loaded ${skillState.skills.length} skill(s): ${skillState.skills
          .map((s) => `${s.skillName} (${s.sourceId})`)
          .join(', ')}`,
      );
    }
  } catch (error) {
    console.error('Skill load failed:', error instanceof Error ? error.message : error);
  }
}

let toolCtx: ToolContext = {
  approvals,
  vectorDbBaseUrl: config.vectorDb.baseUrl,
  vectorDbApiKey: config.vectorDb.apiKey,
  allowedHttpHosts: [...config.tools.allowedHttpHosts],
};

function rebuildToolCtx(): void {
  const hosts = [...new Set([...config.tools.allowedHttpHosts, ...skillState.derivedHosts])];
  toolCtx = {
    approvals,
    vectorDbBaseUrl: config.vectorDb.baseUrl,
    vectorDbApiKey: config.vectorDb.apiKey,
    allowedHttpHosts: hosts,
  };
}

const app = express();
app.use(cors({ origin: config.allowedOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(createSessionMiddleware());
// Bridge Container Apps Easy Auth → cookie-session. No-op when
// COUNSEL_TRUST_EASY_AUTH is unset (local dev). Must run BEFORE requireAuth
// is reachable so the auto-populated session is visible to it.
app.use(easyAuthBridgeMiddleware({ budget: tokenBudget }));
app.use(createCsrfMiddleware({ cookieName: 'suzielaw.csrf' }));
app.use('/api', createAuthRouter({ budget: tokenBudget }));
app.use(
  '/api',
  createOAuthRouter({
    providers: config.oauth.providers,
    budget: tokenBudget,
    defaultRole: 'attorney',
  }),
);
// /api/user-prompts is gone — replaced by /api/workflows. Existing
// rows are migrated into the workflows table at boot via
// `seedAndMigrateWorkflows`; the legacy `user_prompts` table stays
// for now as the migration source and gets dropped in a future
// migration.
app.use(
  '/api/personas',
  requireAuth,
  // Seed-on-first-login: every authenticated user gets an editable copy
  // of the file-based built-ins on their first /api/personas hit. The
  // call is idempotent — once seeded, it's a single SELECT against the
  // `personas_seeded` marker table.
  (req, _res, next) => {
    const email = getSessionUser(req)?.email;
    if (email) personaRegistry.seedFromBuiltinsIfNeeded(email);
    next();
  },
  createPersonasRouter({
    registry: personaRegistry,
    getOwnerId: (req) => getSessionUser(req)?.email,
  }),
);
// Inline /api/model-settings router (replaces upstream sync createModelSettingsRouter).
{
  const known = modelSettings.knownModelIds();
  const knownProviders = new Set<string>(CLOUD_PROVIDER_IDS);

  app.get('/api/model-settings/providers', requireAuth, async (req, res) => {
    const ownerId = getSessionUser(req)?.email;
    if (!ownerId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({
      providers: await modelSettings.publicProviderKeys(ownerId, CLOUD_PROVIDER_IDS),
    });
  });

  app.put('/api/model-settings/providers/:providerId', requireAuth, async (req, res) => {
    const ownerId = getSessionUser(req)?.email;
    if (!ownerId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const providerId = String(req.params.providerId);
    if (!knownProviders.has(providerId)) {
      res.status(404).json({ error: 'unknown_provider' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!apiKey) {
      res.status(400).json({ error: 'apiKey is required' });
      return;
    }
    await modelSettings.setProviderKey(ownerId, providerId, apiKey);
    res.json({
      providers: await modelSettings.publicProviderKeys(ownerId, CLOUD_PROVIDER_IDS),
    });
  });

  app.delete('/api/model-settings/providers/:providerId', requireAuth, async (req, res) => {
    const ownerId = getSessionUser(req)?.email;
    if (!ownerId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const providerId = String(req.params.providerId);
    if (!knownProviders.has(providerId)) {
      res.status(404).json({ error: 'unknown_provider' });
      return;
    }
    await modelSettings.clearProviderKey(ownerId, providerId);
    res.json({
      providers: await modelSettings.publicProviderKeys(ownerId, CLOUD_PROVIDER_IDS),
    });
  });

  app.get('/api/model-settings', requireAuth, async (req, res) => {
    const ownerId = getSessionUser(req)?.email;
    if (!ownerId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({ settings: await modelSettings.publicSettings(ownerId) });
  });

  app.put('/api/model-settings/:modelId', requireAuth, async (req, res) => {
    const ownerId = getSessionUser(req)?.email;
    if (!ownerId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const modelId = String(req.params.modelId);
    if (!known.has(modelId)) {
      res.status(404).json({ error: 'unknown_model' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const baseUrlInput = String(body?.baseUrl || '').trim();
    const apiKeyInput = body?.apiKey;
    const apiKey =
      typeof apiKeyInput === 'string' && apiKeyInput.trim() ? apiKeyInput.trim() : null;
    const validation = validateLocalAgentUrl(baseUrlInput);
    if (!validation.ok || !validation.url) {
      res.status(400).json({ error: validation.reason ?? 'invalid_url' });
      return;
    }
    await modelSettings.setOverride(ownerId, modelId, validation.url, apiKey);
    res.json({ settings: await modelSettings.publicSettings(ownerId) });
  });

  app.delete('/api/model-settings/:modelId', requireAuth, async (req, res) => {
    const ownerId = getSessionUser(req)?.email;
    if (!ownerId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const modelId = String(req.params.modelId);
    if (!known.has(modelId)) {
      res.status(404).json({ error: 'unknown_model' });
      return;
    }
    await modelSettings.clearOverride(ownerId, modelId);
    res.json({ settings: await modelSettings.publicSettings(ownerId) });
  });
}
// Shadow POST /api/matters so we can grant the creator owner role in
// the same call. The workspaces router's POST has no hook for this,
// and we don't want to add one upstream until/unless multi-tenant
// production needs it. Registered before the workspaces router so it
// matches first.
app.post('/api/matters', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const body = req.body as Record<string, unknown> | undefined;
  const name = String(body?.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const descriptionInput = body?.description;
  const description =
    typeof descriptionInput === 'string' ? descriptionInput.trim() : '';
  const created = await workspaces.createWorkspace({
    name,
    description: description.length > 0 ? description : null,
  });
  await members.addMember({
    subjectType: 'matter',
    subjectId: created.id,
    userId,
    role: 'owner',
    grantedBy: userId,
  });
  res.status(201).json({ item: created });
});

// Shadow GET /api/matters to filter by membership. The inline matter
// routes below serve PATCH/archive/delete/folders/documents — those run
// through the requireMatterAccess middleware mounted just below.
app.get('/api/matters', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const includeArchived = req.query.archived === 'true';
  const all = await workspaces.listWorkspaces({ includeArchived });
  const roles = await Promise.all(
    all.map((w) => members.getRole({ type: 'matter', id: w.id }, userId)),
  );
  const accessible = all.filter((_, i) => roles[i] !== null);
  res.json({ items: accessible });
});

// Gate every matter-scoped subroute on membership. Mounted before
// the workspaces router and the chats / reviews / files / diff routers
// so they all inherit the access check. Bare /api/matters (list +
// create) is shadowed above and not affected by this middleware.
app.use(
  '/api/matters/:matterId',
  requireAuth,
  requireMatterAccess,
);

app.use(
  '/api/matters/:matterId/members',
  requireAuth,
  createMatterMembersRouter({ members, workspaces }),
);

// Inline /api/matters routes against @counsel/workspaces. Replaces the
// upstream sync createWorkspacesRouter — store methods are now async and
// the cleanup callbacks call async matterRag methods, so the whole
// surface is async-aware. Mounted under the requireMatterAccess gate
// above; no per-route auth needed.

async function onMatterDocumentRemoved(
  workspace: Workspace,
  doc: WorkspaceDocument,
): Promise<void> {
  // Cascade: KB index → file bytes → review rows. Same logic the
  // upstream onDocumentRemoved callback ran, plus we no longer need the
  // upstream sync→async fire-and-forget bridge — every call below is
  // properly awaited.
  try {
    await matterRag.removeFile(workspace.id, doc.externalDocId);
  } catch (err) {
    console.warn(
      `[matter] matterRag.removeFile(${workspace.id}, ${doc.externalDocId}) rejected:`,
      err instanceof Error ? err.message : err,
    );
  }
  const filesRemoved = fileStore.delete(workspace.id, doc.externalDocId);
  const reviewRowsRemoved = await reviews.removeDocumentsByExternalId(
    workspace.id,
    doc.externalDocId,
  );
  if (filesRemoved || reviewRowsRemoved > 0) {
    console.log(
      `[matter] cleaned up ${doc.name}: ${filesRemoved ? 'file bytes,' : ''} ${reviewRowsRemoved} review row(s)`,
    );
  }
}

async function onMatterRemoved(workspaceId: string): Promise<void> {
  try {
    await matterRag.removeMatter(workspaceId);
  } catch (err) {
    console.warn(
      `[matter] matterRag.removeMatter(${workspaceId}) rejected:`,
      err instanceof Error ? err.message : err,
    );
  }
  await members.removeMembersFor({ type: 'matter', id: workspaceId });
}

async function wouldFolderMoveCreateCycle(
  workspaceId: string,
  folderId: string,
  newParentId: string | null,
): Promise<boolean> {
  if (newParentId === null) return false;
  if (newParentId === folderId) return true;
  let cursor: string | null = newParentId;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === folderId) return true;
    seen.add(cursor);
    const node = await workspaces.getFolder(cursor);
    if (!node || node.workspaceId !== workspaceId) break;
    cursor = node.parentFolderId ?? null;
  }
  return false;
}

app.get('/api/matters/:id', async (req, res) => {
  const item = await workspaces.getWorkspace(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ item });
});

app.patch('/api/matters/:id', async (req, res) => {
  const body = req.body as Record<string, unknown> | undefined;
  const patch: { name?: string; description?: string | null } = {};
  if (typeof body?.name === 'string') {
    const trimmed = body.name.trim();
    if (!trimmed) {
      res.status(400).json({ error: 'name cannot be empty' });
      return;
    }
    patch.name = trimmed;
  }
  if (body && 'description' in body) {
    const d = body.description;
    if (d === null) {
      patch.description = null;
    } else if (typeof d === 'string') {
      const trimmed = d.trim();
      patch.description = trimmed.length > 0 ? trimmed : null;
    } else {
      res.status(400).json({ error: 'description must be a string or null' });
      return;
    }
  }
  const updated = await workspaces.updateWorkspace(req.params.id, patch);
  if (!updated) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ item: updated });
});

app.post('/api/matters/:id/archive', async (req, res) => {
  if (!(await workspaces.getWorkspace(req.params.id))) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await workspaces.archiveWorkspace(req.params.id);
  res.json({ item: await workspaces.getWorkspace(req.params.id) });
});

app.post('/api/matters/:id/unarchive', async (req, res) => {
  if (!(await workspaces.getWorkspace(req.params.id))) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await workspaces.unarchiveWorkspace(req.params.id);
  res.json({ item: await workspaces.getWorkspace(req.params.id) });
});

app.delete('/api/matters/:id', async (req, res) => {
  const id = String(req.params.id ?? '');
  const ok = await workspaces.deleteWorkspace(id);
  if (!ok) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await onMatterRemoved(id);
  res.json({ ok: true });
});

app.get('/api/matters/:id/folders', async (req, res) => {
  if (!(await workspaces.getWorkspace(req.params.id))) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const parentRaw = req.query.parent;
  let parent: string | null | undefined;
  if (parentRaw === undefined) {
    parent = undefined;
  } else if (parentRaw === 'null' || parentRaw === '') {
    parent = null;
  } else if (typeof parentRaw === 'string') {
    parent = parentRaw;
  } else {
    res.status(400).json({ error: 'parent must be a string' });
    return;
  }
  res.json({ items: await workspaces.listFolders(req.params.id, parent) });
});

app.post('/api/matters/:id/folders', async (req, res) => {
  if (!(await workspaces.getWorkspace(req.params.id))) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const body = req.body as Record<string, unknown> | undefined;
  const name = String(body?.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const parentRaw = body?.parentFolderId;
  let parentFolderId: string | null = null;
  if (typeof parentRaw === 'string' && parentRaw.length > 0) {
    const parent = await workspaces.getFolder(parentRaw);
    if (!parent || parent.workspaceId !== req.params.id) {
      res.status(400).json({ error: 'parentFolderId does not belong to this workspace' });
      return;
    }
    parentFolderId = parentRaw;
  }
  const created = await workspaces.createFolder({
    workspaceId: req.params.id,
    parentFolderId,
    name,
  });
  res.status(201).json({ item: created });
});

app.get('/api/matters/:id/documents', async (req, res) => {
  if (!(await workspaces.getWorkspace(req.params.id))) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const folderRaw = req.query.folder;
  let folderId: string | null | undefined;
  if (folderRaw === undefined) {
    folderId = undefined;
  } else if (folderRaw === 'null' || folderRaw === '') {
    folderId = null;
  } else if (typeof folderRaw === 'string') {
    folderId = folderRaw;
  } else {
    res.status(400).json({ error: 'folder must be a string' });
    return;
  }
  res.json({ items: await workspaces.listDocuments(req.params.id, { folderId }) });
});

app.patch('/api/matters/:id/folders/:folderId', async (req, res) => {
  const folder = await workspaces.getFolder(req.params.folderId);
  if (!folder || folder.workspaceId !== req.params.id) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const body = req.body as Record<string, unknown> | undefined;
  const patch: { name?: string; parentFolderId?: string | null; position?: number } = {};
  if (typeof body?.name === 'string') {
    const trimmed = body.name.trim();
    if (!trimmed) {
      res.status(400).json({ error: 'name cannot be empty' });
      return;
    }
    patch.name = trimmed;
  }
  if (body && 'parentFolderId' in body) {
    const p = body.parentFolderId;
    let parentFolderId: string | null;
    if (p === null) {
      parentFolderId = null;
    } else if (typeof p === 'string') {
      if (p.length === 0) {
        parentFolderId = null;
      } else {
        const parent = await workspaces.getFolder(p);
        if (!parent || parent.workspaceId !== req.params.id) {
          res.status(400).json({
            error: 'parentFolderId does not belong to this workspace',
          });
          return;
        }
        parentFolderId = p;
      }
    } else {
      res.status(400).json({ error: 'parentFolderId must be a string or null' });
      return;
    }
    if (await wouldFolderMoveCreateCycle(req.params.id, req.params.folderId, parentFolderId)) {
      res.status(400).json({ error: 'parentFolderId would create a cycle' });
      return;
    }
    patch.parentFolderId = parentFolderId;
  }
  if (typeof body?.position === 'number' && Number.isInteger(body.position)) {
    patch.position = body.position;
  }
  const updated = await workspaces.updateFolder(req.params.folderId, patch);
  if (!updated) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ item: updated });
});

app.delete('/api/matters/:id/folders/:folderId', async (req, res) => {
  const folder = await workspaces.getFolder(req.params.folderId);
  if (!folder || folder.workspaceId !== req.params.id) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await workspaces.deleteFolder(req.params.folderId);
  res.json({ ok: true });
});

app.patch('/api/matters/:id/documents/:docId', async (req, res) => {
  const doc = await workspaces.getDocument(req.params.docId);
  if (!doc || doc.workspaceId !== req.params.id) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const body = req.body as Record<string, unknown> | undefined;
  const patch: { folderId?: string | null; name?: string; position?: number } = {};
  if (body && 'folderId' in body) {
    const f = body.folderId;
    if (f === null) {
      patch.folderId = null;
    } else if (typeof f === 'string') {
      if (f.length === 0) {
        patch.folderId = null;
      } else {
        const folder = await workspaces.getFolder(f);
        if (!folder || folder.workspaceId !== req.params.id) {
          res.status(400).json({
            error: 'folderId does not belong to this workspace',
          });
          return;
        }
        patch.folderId = f;
      }
    } else {
      res.status(400).json({ error: 'folderId must be a string or null' });
      return;
    }
  }
  if (typeof body?.name === 'string') {
    const trimmed = body.name.trim();
    if (!trimmed) {
      res.status(400).json({ error: 'name cannot be empty' });
      return;
    }
    patch.name = trimmed;
  }
  if (typeof body?.position === 'number' && Number.isInteger(body.position)) {
    patch.position = body.position;
  }
  const updated = await workspaces.updateDocument(req.params.docId, patch);
  if (!updated) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ item: updated });
});

app.delete('/api/matters/:id/documents/:docId', async (req, res) => {
  const doc = await workspaces.getDocument(req.params.docId);
  if (!doc || doc.workspaceId !== req.params.id) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await workspaces.removeDocument(req.params.docId);
  const workspace = await workspaces.getWorkspace(doc.workspaceId);
  if (workspace) {
    await onMatterDocumentRemoved(workspace, doc);
  }
  res.json({ ok: true });
});
app.use(
  '/api/matters',
  requireAuth,
  createMatterUploadsRouter({
    fileStore,
    workspaces,
    maxUploadBytes: config.files.maxUploadBytes,
    rag: matterRag,
    documentVersions,
  }),
);
const reviewRunAdapter = buildReviewRunAdapter({
  fileStore,
  rag: matterRag,
  markitdownBaseUrl: config.markitdown.baseUrl,
  agentBaseUrl: config.agent.baseUrl,
  agentApiKey: config.agent.apiKey,
  // Cells run against the lighter model — focused single-doc Q&A on
  // retrieved chunks doesn't need the heavyweight chat model.
  model: config.agent.simpleModel,
  // HyDE rewrite is a one-sentence completion; always run it on the
  // cheap model regardless of which chat model the user picked.
  hydeModel: config.agent.simpleModel,
  // Provider knobs (e.g. Qwen's enable_thinking:false) — without these
  // every cell-run + HyDE rewrite triggers Qwen3's thinking phase and
  // takes 20s+. The chat endpoint already passes this; cells need it too.
  extraBody: config.agent.extraBody,
  tokenBudget,
  fallbackTokensPerCall: config.tokenBudget.fallbackTokensPerCall,
});
app.use(
  '/api/matters/:matterId/chats',
  requireAuth,
  (req, _res, next) => {
    (req as unknown as { _matterId?: string })._matterId = String(
      req.params.matterId ?? '',
    );
    next();
  },
  createCounselChatsRouter(
    (req) => (req as unknown as { _matterId?: string })._matterId ?? '',
  ),
);
// Workflows library. Visibility scopes by the session user — system
// rows are shared, user rows are per-account, plus workflows shared
// explicitly via member rows.
//
// Custom GET / and GET /:id shadow the upstream router so explicitly-shared
// workflows are visible. Mount the members router before the upstream router
// so its routes match first.
app.get('/api/workflows', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const includeArchived = req.query.includeArchived === '1';
  res.json({
    items: await listVisibleWorkflowsForUser({
      workflows,
      members,
      ownerId: userId,
      includeArchived,
    }),
  });
});
app.get('/api/workflows/hidden', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  res.json({ items: await workflows.listHiddenIds(userId) });
});
app.post('/api/workflows', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const body = req.body as Record<string, unknown> | undefined;
  const name = String(body?.name || '').trim();
  const prompt = String(body?.prompt || '').trim();
  if (!name || !prompt) {
    res.status(400).json({ error: 'name and prompt are required' });
    return;
  }
  const description =
    typeof body?.description === 'string' ? body.description.trim() : '';
  const practiceAreas = Array.isArray(body?.practiceAreas)
    ? (body.practiceAreas as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const columnConfig = parseWorkflowColumnConfig(body?.columnConfig);
  const outputMode = parseWorkflowOutputMode(body?.outputMode);
  const workflow = await workflows.createUserWorkflow({
    ownerId: userId,
    name,
    description,
    prompt,
    practiceAreas,
    columnConfig: columnConfig ?? null,
    ...(outputMode ? { outputMode } : {}),
  });
  res.status(201).json({ item: workflow });
});
app.get('/api/workflows/:id', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const id = String(req.params.id ?? '');
  const role = await resolveWorkflowRole({
    workflows,
    members,
    workflowId: id,
    userId,
  });
  if (!role) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ item: await workflows.get(id), role });
});
app.patch('/api/workflows/:id', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const id = String(req.params.id ?? '');
  const body = req.body as Record<string, unknown> | undefined;
  const patch: {
    name?: string;
    description?: string;
    prompt?: string;
    practiceAreas?: string[];
    columnConfig?: WorkflowColumnConfig[] | null;
    outputMode?: WorkflowOutputMode;
  } = {};
  if (typeof body?.name === 'string') {
    const trimmed = body.name.trim();
    if (!trimmed) {
      res.status(400).json({ error: 'name cannot be empty' });
      return;
    }
    patch.name = trimmed;
  }
  if (typeof body?.description === 'string') patch.description = body.description.trim();
  if (typeof body?.prompt === 'string') {
    const trimmed = body.prompt.trim();
    if (!trimmed) {
      res.status(400).json({ error: 'prompt cannot be empty' });
      return;
    }
    patch.prompt = trimmed;
  }
  if (Array.isArray(body?.practiceAreas)) {
    patch.practiceAreas = (body.practiceAreas as unknown[])
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'columnConfig')) {
    const parsed = parseWorkflowColumnConfig(body.columnConfig);
    if (parsed !== undefined) patch.columnConfig = parsed;
  }
  const outputMode = parseWorkflowOutputMode(body?.outputMode);
  if (outputMode) patch.outputMode = outputMode;
  const updated = await workflows.updateUserWorkflow(id, userId, patch, userId);
  if (!updated) {
    res.status(404).json({ error: 'not_found_or_forbidden' });
    return;
  }
  res.json({ item: updated });
});
app.get('/api/workflows/:id/versions', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const id = String(req.params.id ?? '');
  const existing = await workflows.get(id);
  if (!existing) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (existing.source !== 'user' || existing.ownerId !== userId) {
    res.status(404).json({ error: 'not_found_or_forbidden' });
    return;
  }
  res.json({ items: await workflows.listVersions(id, userId) });
});
app.post('/api/workflows/:id/versions/:versionId/restore', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const id = String(req.params.id ?? '');
  const versionId = String(req.params.versionId ?? '');
  const restored = await workflows.restoreVersion(id, versionId, userId, userId);
  if (!restored) {
    res.status(404).json({ error: 'not_found_or_forbidden' });
    return;
  }
  res.json({ item: restored });
});
app.delete('/api/workflows/:id', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const id = String(req.params.id ?? '');
  const ok = await workflows.deleteUserWorkflow(id, userId);
  if (!ok) {
    res.status(404).json({ error: 'not_found_or_forbidden' });
    return;
  }
  res.json({ ok: true });
});
app.post('/api/workflows/:id/archive', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const ok = await workflows.archive(String(req.params.id ?? ''), userId);
  if (!ok) {
    res.status(404).json({ error: 'not_found_or_forbidden' });
    return;
  }
  res.json({ ok: true });
});
app.post('/api/workflows/:id/unarchive', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const ok = await workflows.unarchive(String(req.params.id ?? ''), userId);
  if (!ok) {
    res.status(404).json({ error: 'not_found_or_forbidden' });
    return;
  }
  res.json({ ok: true });
});
app.post('/api/workflows/:id/hide', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const id = String(req.params.id ?? '');
  if (!(await workflows.get(id))) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await workflows.hide(id, userId);
  res.json({ ok: true });
});
app.post('/api/workflows/:id/unhide', requireAuth, async (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  await workflows.unhide(String(req.params.id ?? ''), userId);
  res.json({ ok: true });
});
app.use(
  '/api/workflows/:workflowId/members',
  requireAuth,
  createWorkflowMembersRouter({ members, workflows }),
);
// Review-scoped chats live in the same chats table, namespaced by a
// `review:<reviewId>` workspace_id prefix. The chats package treats the
// workspace_id as opaque so this slots in with no upstream changes —
// the matter-scoped chats list filters by `<matterId>` and won't see
// these rows. /api/chat below detects the prefix and attaches the
// review's documents instead of the whole matter's.
app.use(
  '/api/matters/:matterId/reviews/:reviewId/chats',
  requireAuth,
  (req, _res, next) => {
    const reviewId = String(req.params.reviewId ?? '');
    (req as unknown as { _reviewWorkspaceId?: string })._reviewWorkspaceId =
      reviewId ? `review:${reviewId}` : '';
    next();
  },
  createCounselChatsRouter(
    (req) =>
      (req as unknown as { _reviewWorkspaceId?: string })._reviewWorkspaceId ?? '',
  ),
);
// Top-level Assistant chats — namespaced by an `assistant:<userEmail>` workspace_id
// prefix. Same chats table; per-user scoping keeps each demo user's history
// separate. /api/chat below detects the prefix and treats the chat as standalone
// (no auto-attach of matter/review documents).
app.use(
  '/api/assistant/chats',
  requireAuth,
  createCounselChatsRouter((req) => {
    const email = getSessionUser(req)?.email;
    return email ? `assistant:${email}` : '';
  }),
);
app.use(
  '/api/matters/:matterId/reviews',
  requireAuth,
  (req, _res, next) => {
    // Express 5 doesn't merge parent params into a sub-router by default —
    // stash matterId where the inline routes can find it.
    (req as unknown as { _matterId?: string })._matterId = String(
      req.params.matterId ?? '',
    );
    next();
  },
  createCounselReviewsRouter(
    (req) => (req as unknown as { _matterId?: string })._matterId ?? '',
    reviewRunAdapter,
  ),
);
// Files are user content — gate behind auth before mounting the router.
app.use('/api/files', requireAuth);

// Redline preview + accept/reject by revision id. Operates on proposal
// DOCX bytes living in the file store; both routes mutate or read by
// `:sessionId/:fileId`. Mounted before the generic files router so the
// more specific paths match first.
app.get('/api/files/:sessionId/:fileId/redline-view', requireAuth, (req, res) => {
  const sessionId = String(req.params.sessionId ?? '');
  const fileId = String(req.params.fileId ?? '');
  const rec = fileStore.get(sessionId, fileId);
  if (!rec) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (
    !rec.name.toLowerCase().endsWith('.docx') &&
    rec.mimeType !==
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    res.status(400).json({ error: 'redline_view requires a .docx file' });
    return;
  }
  try {
    const paragraphs = extractRedlineParagraphs(rec.bytes);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ paragraphs });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'extract failed' });
  }
});

app.post(
  '/api/files/:sessionId/:fileId/revisions/resolve',
  requireAuth,
  async (req, res) => {
    const sessionId = String(req.params.sessionId ?? '');
    const fileId = String(req.params.fileId ?? '');
    const rec = fileStore.get(sessionId, fileId);
    if (!rec) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (
      !rec.name.toLowerCase().endsWith('.docx') &&
      rec.mimeType !==
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      res.status(400).json({ error: 'resolve requires a .docx file' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const accept = Array.isArray(body?.accept)
      ? (body!.accept as unknown[])
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n))
      : [];
    const reject = Array.isArray(body?.reject)
      ? (body!.reject as unknown[])
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n))
      : [];
    if (accept.length === 0 && reject.length === 0) {
      res.status(400).json({ error: 'accept or reject must be non-empty' });
      return;
    }
    try {
      const file = loadDocx(rec.bytes);
      let changed = 0;
      for (const id of accept) if (acceptRevision(file, id)) changed++;
      for (const id of reject) if (rejectRevision(file, id)) changed++;
      const newBytes = file.save();
      // Mutate in place — same fileId, same bucket. The download_url
      // returned by the original tool call stays valid; the bytes behind
      // it are now the post-resolution version.
      fileStore.put({
        ...rec,
        bytes: newBytes,
        size: newBytes.length,
      });
      // Record one version row per resolution batch, branched from the
      // source's current head. Source label captures the operation.
      let versionId: string | undefined;
      try {
        const head = await documentVersions.getHead(fileId);
        const source = accept.length > 0 ? 'accept' : 'reject';
        const v = await documentVersions.addVersion({
          externalDocId: fileId,
          parentId: head?.id ?? null,
          source,
          storageId: fileId,
          byteSize: newBytes.length,
          notes: `Resolved ${changed} revision${changed === 1 ? '' : 's'} (${accept.length} accept, ${reject.length} reject)`,
        });
        versionId = v.id;
      } catch (err) {
        console.warn(
          '[revisions/resolve] addVersion failed:',
          err instanceof Error ? err.message : err,
        );
      }
      const paragraphs = extractRedlineParagraphs(newBytes);
      res.json({
        ok: true,
        accepted: accept,
        rejected: reject,
        changed,
        version_id: versionId,
        paragraphs,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'resolve failed' });
    }
  },
);

app.use(
  '/api',
  createFilesRouter({ store: fileStore, maxUploadBytes: config.files.maxUploadBytes }),
);
if (config.kb.enabled) {
  app.use(
    '/api/kb',
    requireAuth,
    createKbRouter({
      store: kbStore,
      markitdownBaseUrl: config.markitdown.baseUrl,
      maxUploadBytes: config.files.maxUploadBytes,
    }),
  );
}

app.get('/api/health', async (_req, res) => {
  try {
    let reachable = false;
    let runtimeError = '';

    try {
      await fetch(`${config.agent.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      reachable = true;
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : 'Health check failed';
    }

    if (!reachable) {
      try {
        const probe = await fetch(config.agent.baseUrl, {
          signal: AbortSignal.timeout(5_000),
        });
        reachable = probe.status > 0;
        runtimeError = '';
      } catch (error) {
        runtimeError = error instanceof Error ? error.message : runtimeError;
      }
    }

    res.json({
      status: 'ok',
      title: config.title,
      agent: {
        name: config.agent.name,
        description: config.agent.description,
        model: config.agent.model,
        reachable,
      },
      tools: activeTools().map((t) => ({ name: t.name, description: t.description })),
      skills: skillState.skills.map((s) => ({
        skillName: s.skillName,
        name: s.name,
        description: s.description,
        sourceId: s.sourceId,
      })),
      mcp: mcp.status,
      allowedHttpHosts: toolCtx.allowedHttpHosts ?? [],
      kb: config.kb.enabled
        ? { enabled: true, ...(await kbStore.count(null)) }
        : { enabled: false },
      modelAgents: Object.fromEntries(
        Object.entries(config.modelAgents).map(([id, t]) => [id, { baseUrl: t.baseUrl }]),
      ),
      authProviders: config.oauth.providers.map((p) => ({ id: p.id, label: p.label })),
      cloudProviders: CLOUD_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        modelIds: p.modelIds,
        ...(p.hint ? { hint: p.hint } : {}),
        ...(p.keyUrl ? { keyUrl: p.keyUrl } : {}),
      })),
      demo: config.demo.password ? { email: config.demo.email, password: config.demo.password } : undefined,
    });
  } catch (error) {
    res.json({
      status: 'ok',
      title: config.title,
      agent: {
        name: config.agent.name,
        description: config.agent.description,
        model: config.agent.model,
        reachable: false,
        error: error instanceof Error ? error.message : 'Health check failed',
      },
      tools: activeTools().map((t) => ({ name: t.name, description: t.description })),
      skills: skillState.skills.map((s) => ({
        skillName: s.skillName,
        name: s.name,
        description: s.description,
        sourceId: s.sourceId,
      })),
      mcp: mcp.status,
      allowedHttpHosts: toolCtx.allowedHttpHosts ?? [],
      kb: config.kb.enabled
        ? { enabled: true, ...(await kbStore.count(null)) }
        : { enabled: false },
      modelAgents: Object.fromEntries(
        Object.entries(config.modelAgents).map(([id, t]) => [id, { baseUrl: t.baseUrl }]),
      ),
      authProviders: config.oauth.providers.map((p) => ({ id: p.id, label: p.label })),
      cloudProviders: CLOUD_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        modelIds: p.modelIds,
        ...(p.hint ? { hint: p.hint } : {}),
        ...(p.keyUrl ? { keyUrl: p.keyUrl } : {}),
      })),
      demo: config.demo.password ? { email: config.demo.email, password: config.demo.password } : undefined,
    });
  }
});

app.get('/api/token-budget', requireAuth, (req, res) => {
  const ownerEmail = getSessionUser(req)?.email;
  if (!ownerEmail) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.json({ tokenBudget: tokenBudget.getSummary(ownerEmail) });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const message = String(req.body?.message || '').trim();
  const history = Array.isArray(req.body?.history) ? (req.body.history as ChatMessage[]) : [];
  const sessionId = String(req.body?.sessionId || '').trim();
  const attachmentIds = Array.isArray(req.body?.attachmentIds)
    ? (req.body.attachmentIds as unknown[]).map(String).filter(Boolean)
    : [];
  // When set, this is a matter-scoped persisted chat. Server auto-attaches
  // matter docs and persists user + assistant messages on completion.
  const chatId = String(req.body?.chatId || '').trim();
  // Per-request model override (from the Settings model picker). The
  // default model is always allowed — it's the demo-budget path. Other
  // models are accepted only when the user has a BYOK key for the
  // model's provider; the chat then routes to the provider's public
  // endpoint with the user's key, bypassing demo metering.
  const requestedModelRaw = String(req.body?.model || '').trim();
  const sessionEmailEarly = getSessionUser(req)?.email;
  if (requestedModelRaw && requestedModelRaw !== config.agent.model) {
    const provider = providerForModel(requestedModelRaw);
    const hasUserKey = !!(
      provider &&
      sessionEmailEarly &&
      (await modelSettings.getProviderKey(sessionEmailEarly, provider.id))
    );
    if (!provider || !hasUserKey) {
      res.status(400).json({
        error: 'model_not_allowed',
        allowed: [config.agent.model],
        message: provider
          ? `Add your ${provider.label} key in Settings to use ${requestedModelRaw}.`
          : `Model ${requestedModelRaw} is not configured for this app.`,
      });
      return;
    }
  }
  const requestedModel = requestedModelRaw;
  // Per-request persona — picked at "new chat" time and sent on every turn.
  const personaId = String(req.body?.personaId || '').trim();
  // When the user launches a workflow from the library, the client
  // sends its id on the next turn so the runtime can route based on the
  // workflow's `output_mode` (inject `generate_docx` and add a nudge for
  // tool-bound modes; pass through unchanged for `inline_chat`). One-shot:
  // the client sends this only on the launch turn, not on follow-ups.
  const workflowId = String(req.body?.workflowId || '').trim();
  const ownerEmail = getSessionUser(req)?.email;
  const persona = personaId && ownerEmail ? personaRegistry.get(personaId, ownerEmail) : null;

  // Per-model routing: env defaults overlaid with the user's per-model
  // overrides (saved via /api/model-settings). resolveAgentTarget picks the
  // right base URL + key for the requested model id. BYOK additionally
  // overlays a per-(user, provider) cloud key — when set, it routes the
  // call to the provider's public endpoint with the user's own key,
  // bypassing the demo-budget path entirely.
  const effectiveModel = requestedModel || persona?.model || config.agent.model;
  const userRegistry = await modelSettings.effectiveRegistry(ownerEmail ?? null);
  // BYOK overlay: for any model that maps to a known cloud provider AND
  // for which the caller has a saved key, rewrite the registry entry to
  // route the request through the provider's public endpoint with the
  // user's own credentials. We apply this to BOTH the chat model and
  // the simpleModel — auxiliary calls (auto-titling, column drafting,
  // KB hyde) all use simpleModel and would otherwise still hit the
  // demo backend even with a BYOK key set. The wire id rewrite handles
  // providers whose UI ids include a namespace prefix (`anthropic/...`,
  // `openai/...`) but whose APIs expect bare ids on the wire.
  async function overlayBYOK(uiModelId: string): Promise<void> {
    if (!ownerEmail) return;
    const cloudProvider = providerForModel(uiModelId);
    if (!cloudProvider) return;
    const userKey = await modelSettings.getProviderKey(ownerEmail, cloudProvider.id);
    if (!userKey) return;
    userRegistry[uiModelId] = {
      baseUrl: cloudProvider.baseUrl,
      apiKey: userKey,
      model: wireModelIdFor(uiModelId),
    };
  }
  await overlayBYOK(effectiveModel);
  await overlayBYOK(config.agent.simpleModel);
  const agent = resolveAgentTarget(effectiveModel, userRegistry, config.agent);
  const countHostedTokens =
    !!ownerEmail &&
    agent.baseUrl === config.agent.baseUrl &&
    (agent.apiKey || '') === (config.agent.apiKey || '');

  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  if (ownerEmail && countHostedTokens) {
    try {
      tokenBudget.assertCanSpend(ownerEmail);
    } catch (error) {
      res.status(402).json({
        error: 'token_limit_exceeded',
        message: error instanceof Error ? error.message : 'Demo token allowance used',
        tokenBudget: tokenBudget.getSummary(ownerEmail),
      });
      return;
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const abort = new AbortController();
  // res.close (not req.close): fires when the response stream ends — i.e.,
  // the client actually disconnected. req.close in Express 5 / Node 22+ can
  // fire as soon as the request body is fully consumed by middleware, which
  // would abort the upstream LLM call before it ever runs.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  // Per-turn paperclip uploads (chat session bucket).
  const turnAttachments: FileRecord[] =
    sessionId && attachmentIds.length > 0
      ? fileStore.getMany(sessionId, attachmentIds)
      : [];

  // Persisted-chat attachment: matter-scoped chats auto-attach every doc
  // in the matter; review-scoped chats (workspaceId prefixed `review:`)
  // narrow that to just the review's row set. Top-level Assistant chats
  // (workspaceId prefixed `assistant:`) are standalone — no auto-attach.
  // Matter and review chats resolve file bytes from the matter's bucket,
  // since that's where uploads land — the review-scoped chat's
  // `workspaceId` is just a namespace marker, not a file-store bucket.
  let persistedChat: Chat | null = null;
  // The matter id whose `fileStore` bucket holds the doc bytes for this
  // chat. For review-scoped chats this differs from `persistedChat.workspaceId`,
  // so we surface it for both attachment lookup and the docTools session.
  // Empty string for top-level Assistant chats — they have no matter bucket.
  let chatBucketMatterId = '';
  const matterAttachments: FileRecord[] = [];
  if (chatId) {
    persistedChat = await chats.getChat(chatId);
    if (!persistedChat) {
      send({ type: 'error', message: 'chat not found' });
      res.end();
      return;
    }
    if (persistedChat.workspaceId.startsWith('assistant:')) {
      // Top-level Assistant chat — standalone, no matter docs.
    } else if (persistedChat.workspaceId.startsWith('review:')) {
      const reviewId = persistedChat.workspaceId.slice('review:'.length);
      const review = await reviews.getReview(reviewId);
      if (!review) {
        send({ type: 'error', message: 'review not found for chat' });
        res.end();
        return;
      }
      chatBucketMatterId = review.workspaceId;
      for (const doc of await reviews.listDocuments(reviewId)) {
        const rec = fileStore.get(chatBucketMatterId, doc.externalDocId);
        if (rec) matterAttachments.push(rec);
      }
    } else {
      chatBucketMatterId = persistedChat.workspaceId;
      for (const doc of await workspaces.listDocuments(chatBucketMatterId, {})) {
        const rec = fileStore.get(chatBucketMatterId, doc.externalDocId);
        if (rec) matterAttachments.push(rec);
      }
    }
  }
  // For top-level Assistant chats we resolve attachment bytes from the
  // user's per-render session bucket (paperclip uploads), which is what
  // the docTools / file URLs already use.
  const docToolsSession = chatBucketMatterId || sessionId;

  // Dedupe by file id so a paperclip upload that's also a matter doc doesn't
  // appear twice in the [Attachments] block.
  const allAttachments: FileRecord[] = [];
  const seenAttachmentIds = new Set<string>();
  for (const rec of [...matterAttachments, ...turnAttachments]) {
    if (seenAttachmentIds.has(rec.id)) continue;
    seenAttachmentIds.add(rec.id);
    allAttachments.push(rec);
  }
  const attachmentContext = buildAttachmentContext(allAttachments);
  const citationProtocol = buildCitationProtocolBlock(allAttachments);
  const userContent = attachmentContext
    ? `${attachmentContext}\n\n${citationProtocol}\n\n[Message]\n${message}`
    : message;

  const messages: ChatMessage[] = [...history, { role: 'user', content: userContent }];

  // Per-turn document tools (lazy convert, navigate, draft, export). Only
  // appears when markitdown-agent is configured; otherwise just nav/draft on
  // any docs the app put in the store directly.
  //
  // In matter- or review-scoped chats, doc lookup has to use the matter's
  // bucket — that's where matter docs live in the file store. The
  // request's `sessionId` (= chatId) doesn't hold those bytes, and a
  // review-scoped chat's `workspaceId` is `review:<id>` (a namespace
  // marker, not a file-store key). `chatBucketMatterId` resolves to the
  // matter id for both kinds of persisted chats.
  const docTools = buildDocumentTools({
    sessionId: docToolsSession,
    fileStore,
    docStore,
    markitdownBaseUrl: config.markitdown.baseUrl,
  });
  const diffTools = buildDiffTools({
    sessionId: docToolsSession,
    fileStore,
    markitdownBaseUrl: config.markitdown.baseUrl,
    originUrl: config.publicUrl,
  });
  const proposeEditsTools = buildProposeEditsTools({
    sessionId: docToolsSession,
    fileStore,
    originUrl: config.publicUrl,
    documentVersions,
  });
  const findInDocumentTools = buildFindInDocumentTools({
    sessionId: docToolsSession,
    fileStore,
    docStore,
  });
  const replicateDocumentTools = buildReplicateDocumentTools({
    sessionId: docToolsSession,
    fileStore,
    originUrl: config.publicUrl,
    documentVersions,
  });

  // Workflow-bound tool injection. Lookup is best-effort: an unknown
  // workflowId silently degrades to inline_chat behaviour rather than
  // failing the turn, so a stale id never blocks the user.
  const activeWorkflow = workflowId ? await workflows.get(workflowId) : null;
  const workflowDocxTools =
    activeWorkflow?.outputMode === 'generate_docx'
      ? buildGenerateDocxTools({
          sessionId: docToolsSession,
          fileStore,
          originUrl: config.publicUrl,
          documentVersions,
        })
      : [];

  const turnTools = [
    ...activeTools(),
    ...docTools,
    ...diffTools,
    ...proposeEditsTools,
    ...findInDocumentTools,
    ...replicateDocumentTools,
  ];

  // Persona's system prompt replaces the default Counsel prompt; skills always
  // append; allowedTools/blockedTools filters the tool set for this turn.
  const turnConfig = applyPersona({
    defaultSystemPrompt: config.agent.systemPrompt,
    skillSystemPrompt: skillState.systemPrompt,
    tools: turnTools,
    persona,
  });

  // Apply per-turn overrides for the active workflow's output_mode.
  // For generate_docx, this injects the docx tools, filters out the
  // competing markdown-drafting + template tools, and appends a
  // system-prompt nudge — see workflow-overrides.ts for the routing
  // matrix and the rationale (the model otherwise reaches for
  // create_document/write_section despite the nudge, because the
  // baseline prompt's drafting guidance is longer than a single
  // paragraph). Pass-through for inline_chat / tabular_review / null.
  const overridden = applyWorkflowOverrides({
    baseTools: turnConfig.tools,
    baseSystemPrompt: turnConfig.systemPrompt,
    workflow: activeWorkflow,
    generateDocxTools: workflowDocxTools,
  });
  turnConfig.tools = overridden.tools;
  turnConfig.systemPrompt = overridden.systemPrompt;

  // Accumulators so we can persist the assistant turn into chat_messages
  // when the chat is matter-scoped. Tool events are kept as-is; the final
  // text gets parseResponse'd to strip the citation sentinel block.
  let assistantText = '';
  const collectedToolEvents: unknown[] = [];

  try {
    for await (const event of runChatTurn({
      agent,
      messages,
      tools: turnConfig.tools,
      toolCtx,
      systemPrompt: turnConfig.systemPrompt,
      maxIterations: config.tools.maxIterations,
      fetchImpl:
        ownerEmail && countHostedTokens
          ? createTokenMeteredFetch({
              budget: tokenBudget,
              ownerEmail,
              source: 'chat',
              model: agent.model,
              enabled: true,
              fallbackTokens: config.tokenBudget.fallbackTokensPerCall,
            })
          : fetch,
      signal: abort.signal,
    })) {
      send(event);
      if (persistedChat) {
        if (event.type === 'chunk') {
          assistantText += event.text;
        } else if (
          event.type === 'tool_call' ||
          event.type === 'tool_result' ||
          event.type === 'tool_error'
        ) {
          collectedToolEvents.push(event);
        }
      }
      if (event.type === 'done' || event.type === 'error') break;
    }
  } catch (error) {
    send({
      type: 'error',
      message: error instanceof Error ? error.message : 'Chat request failed',
      code: error instanceof TokenLimitExceededError ? 'token_limit_exceeded' : undefined,
    });
  } finally {
    if (persistedChat) {
      try {
        // Persist the user turn (the original message, not the embellished
        // userContent — we don't want the [Attachments] block in stored history).
        await chats.appendMessage({
          chatId: persistedChat.id,
          role: 'user',
          content: message,
        });

        const parsed = parseResponse(assistantText, {
          knownDocs: allAttachments.map((a) => a.id),
        });
        await chats.appendMessage({
          chatId: persistedChat.id,
          role: 'assistant',
          content: parsed.text,
          // @counsel/chats stores these as jsonb; pass arrays directly
          // and let the store handle serialization.
          toolEvents: collectedToolEvents.length > 0 ? collectedToolEvents : null,
          citations: parsed.citations.length > 0 ? parsed.citations : null,
        });

        // Auto-title in two passes: synchronous trim of the first message
        // so the sidebar updates immediately on first turn, then a
        // background LLM call that upgrades to a short, sentence-case
        // title (e.g. "NDA confidentiality scope" instead of "Can you
        // redline this NDA from buyer perspective"). Best-effort — any
        // failure leaves the synchronous title in place.
        if (persistedChat.name === 'New chat') {
          const firstLine = message.split('\n')[0]?.trim() ?? '';
          const provisional =
            firstLine.length > 0
              ? firstLine.slice(0, 60) + (firstLine.length > 60 ? '…' : '')
              : 'New chat';
          if (provisional !== persistedChat.name) {
            await chats.updateChat(persistedChat.id, { name: provisional });
          }
          // Fire-and-forget the polish pass after we end the response
          // stream so the user doesn't wait on it. Pinned to the simple
          // model + always-fresh fetch (no token-metering — it's cheap
          // and counts against the chat budget anyway).
          const titleAgent = resolveAgentTarget(
            config.agent.simpleModel,
            userRegistry,
            config.agent,
          );
          const persistedChatId = persistedChat.id;
          const userTurnText = message;
          const replyText = parsed.text;
          void (async () => {
            try {
              const polished = await draftChatTitle(userTurnText, replyText, {
                baseUrl: titleAgent.baseUrl,
                apiKey: titleAgent.apiKey,
                model: titleAgent.model,
                extraBody: config.agent.extraBody,
              });
              if (!polished) return;
              const current = await chats.getChat(persistedChatId);
              // Only overwrite if the chat is still on the provisional
              // title — if the user renamed it manually in the meantime,
              // respect that.
              if (current && current.name === provisional) {
                await chats.updateChat(persistedChatId, { name: polished });
              }
            } catch (err) {
              console.warn(
                '[chat-title] background polish failed:',
                err instanceof Error ? err.message : err,
              );
            }
          })();
        }
      } catch (err) {
        // Don't fail the response stream just because persistence broke.
        console.error(
          'Failed to persist chat messages:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    res.end();
  }
});

app.get('/api/approvals', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  const items = await approvals.list({
    status: status === 'all' ? undefined : (status as 'pending' | 'approved' | 'rejected' | 'dispatched' | 'failed'),
  });
  res.json({ items });
});

app.post('/api/approvals/:id/review', async (req, res) => {
  const id = req.params.id;
  const verdict = req.body?.verdict === 'approve' ? 'approve' : 'reject';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

  try {
    const reviewed = await approvals.review(id, {
      reviewer_id: 'human',
      verdict,
      reason,
    });
    res.json({ ok: true, item: reviewed });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Review failed',
    });
  }
});

/**
 * Wipe every user-content table — KB, matters/folders/docs, chats,
 * reviews, on-disk files. Auth-gated; the demo build only has one user
 * anyway. Returns counts so the UI can show "removed N matters, M docs,
 * K kb chunks". Personas, prompts, model-settings survive — those feel
 * more like configuration than content.
 */
app.post('/api/admin/reset', requireAuth, async (_req, res) => {
  const startedAt = Date.now();
  console.log('[admin/reset] starting full content wipe');
  try {
    // 1. KB. Delete each document through the store so vec0 / fts5
    //    sidecars stay in sync — direct DELETEs would leave orphans.
    const kbDocs = await kbStore.list(null);
    let kbDocsDeleted = 0;
    let kbChunksDeleted = 0;
    for (const doc of kbDocs) {
      try {
        await kbStore.delete(doc.id);
        kbDocsDeleted += 1;
        kbChunksDeleted += doc.chunkCount;
      } catch (err) {
        console.warn(`[admin/reset] kbStore.delete(${doc.id}) failed:`, err);
      }
    }
    // 2. Everything else, in dependency order. All but PersonaRegistry +
    //    hosted-demo's TokenBudgetStore now live in Postgres via @counsel/*,
    //    so the wipe runs against counselDb.kysely. Foreign-key cascades
    //    handle the dependents (chat_messages → chats, review_cells →
    //    review_columns/documents, etc.) so a top-down DELETE is enough.
    await counselDb.kysely.deleteFrom('matter_doc_index').execute();
    await counselDb.kysely.deleteFrom('chats').execute();
    await counselDb.kysely.deleteFrom('reviews').execute();
    await counselDb.kysely.deleteFrom('workspaces').execute();
    // 3. File bytes (in-memory + disk persistence). docStore lives per
    //    chat session and ages out naturally, so we don't touch it here.
    const filesDeleted = fileStore.clearAll();
    const elapsed = Date.now() - startedAt;
    console.log(
      `[admin/reset] complete in ${elapsed}ms: ${kbDocsDeleted} kb doc(s), ${kbChunksDeleted} chunk(s), ${filesDeleted} file(s)`,
    );
    res.json({
      ok: true,
      kbDocsDeleted,
      filesDeleted,
    });
  } catch (err) {
    console.warn('[admin/reset] failed:', err instanceof Error ? err.message : err);
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'reset failed',
    });
  }
});

/**
 * Title-driven column-prompt drafting. The review column editor calls
 * this on title blur in `create` mode — the response is a starter
 * `{prompt, format}` the user can immediately edit. Model-driven so it
 * handles arbitrary column titles, not just a fixed preset pack.
 */
/**
 * Stream an .xlsx export of a review. Header row + one row per review
 * document; citation quotes attach as cell comments so a reviewer can
 * verify each answer without leaving Excel.
 */
/**
 * Launch a workflow as a review. Picks up the workflow's column config
 * and instantiates a review with one column per entry, one row per
 * supplied document. Returns a snapshot the client can navigate to
 * immediately; cells start `pending` (the existing run-pending flow
 * fills them in).
 */
app.post(
  '/api/matters/:matterId/reviews/from-workflow',
  requireAuth,
  async (req, res) => {
    const matterId = String(req.params.matterId ?? '');
    const ownerId = getSessionUser(req)?.email;
    if (!ownerId) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const matter = await workspaces.getWorkspace(matterId);
    if (!matter) {
      res.status(404).json({ error: 'matter not found' });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const workflowId = String(body?.workflowId ?? '');
    const externalDocIds = Array.isArray(body?.externalDocIds)
      ? (body.externalDocIds as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (!workflowId) {
      res.status(400).json({ error: 'workflowId is required' });
      return;
    }
    if (externalDocIds.length === 0) {
      res.status(400).json({ error: 'select at least one document' });
      return;
    }
    const workflow = await workflows.get(workflowId);
    if (!workflow) {
      res.status(404).json({ error: 'workflow not found' });
      return;
    }
    // User-owned workflows are private to their creator unless shared
    // via the sharing surface — viewers can run, editors/owners can run.
    {
      const role = await resolveWorkflowRole({
        workflows,
        members,
        workflowId,
        userId: ownerId,
      });
      if (!role) {
        res.status(404).json({ error: 'workflow not found' });
        return;
      }
    }
    const columns = workflow.columnConfig ?? [];
    if (columns.length === 0) {
      res.status(400).json({ error: 'workflow has no review template' });
      return;
    }
    const REVIEW_VALID_FORMATS = [
      'text',
      'short_text',
      'date',
      'yes_no',
      'bullets',
      'money',
    ] as const;
    type ReviewCellFormat = (typeof REVIEW_VALID_FORMATS)[number];
    const validatedColumns = columns.filter((c) =>
      (REVIEW_VALID_FORMATS as readonly string[]).includes(c.format),
    );
    if (validatedColumns.length === 0) {
      res.status(400).json({ error: 'workflow has no valid columns' });
      return;
    }

    // Resolve doc names + mime types from the matter so we can populate
    // review_documents. Skip ids that aren't in the matter rather than
    // failing the whole call — the client may have stale data.
    const matterDocs = await workspaces.listDocuments(matterId, {});
    const docByExternalId = new Map(
      matterDocs.map((d) => [d.externalDocId, d]),
    );

    try {
      const today = new Date().toLocaleDateString();
      const review = await reviews.createReview({
        workspaceId: matterId,
        name: `${workflow.name} — ${today}`,
        description:
          workflow.description && workflow.description.trim().length > 0
            ? workflow.description
            : null,
      });
      for (let i = 0; i < validatedColumns.length; i++) {
        const c = validatedColumns[i]!;
        await reviews.addColumn({
          reviewId: review.id,
          title: c.title,
          prompt: c.prompt,
          format: c.format as ReviewCellFormat,
          position: i,
        });
      }
      let added = 0;
      for (const externalDocId of externalDocIds) {
        const matterDoc = docByExternalId.get(externalDocId);
        if (!matterDoc) continue;
        await reviews.addDocument({
          reviewId: review.id,
          externalDocId,
          name: matterDoc.name,
          mimeType: matterDoc.mimeType ?? null,
          position: added,
        });
        added += 1;
      }
      const snapshot = await reviews.getReviewSnapshot(review.id);
      res.status(201).json({
        item: snapshot,
        skipped: externalDocIds.length - added,
      });
    } catch (err) {
      console.warn(
        '[reviews/from-workflow] failed:',
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: err instanceof Error ? err.message : 'failed',
      });
    }
  },
);

/**
 * Paragraph-level diff between two of a matter's documents. Used by
 * the matter-detail "Compare versions" surface (and the chat tool, though
 * the chat path doesn't go through this endpoint — it calls runDocumentDiff
 * directly with the file records it already has). Both files must live in
 * the matter's bucket; cross-matter diffs aren't supported here.
 */
app.post(
  '/api/matters/:matterId/diff',
  requireAuth,
  async (req, res) => {
    const matterId = String(req.params.matterId ?? '');
    const matter = await workspaces.getWorkspace(matterId);
    if (!matter) {
      res.status(404).json({ error: 'matter not found' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const leftFileId = String(body?.leftFileId ?? '').trim();
    const rightFileId = String(body?.rightFileId ?? '').trim();
    if (!leftFileId || !rightFileId) {
      res.status(400).json({
        error: 'leftFileId and rightFileId are required',
      });
      return;
    }
    if (leftFileId === rightFileId) {
      res.status(400).json({
        error: 'leftFileId and rightFileId must reference different files',
      });
      return;
    }
    const left = fileStore.get(matterId, leftFileId);
    const right = fileStore.get(matterId, rightFileId);
    if (!left) {
      res.status(404).json({ error: `leftFileId not found: ${leftFileId}` });
      return;
    }
    if (!right) {
      res.status(404).json({ error: `rightFileId not found: ${rightFileId}` });
      return;
    }
    try {
      const result = await runDocumentDiff(left, right, {
        markitdownBaseUrl: config.markitdown.baseUrl,
      });
      res.json(result);
    } catch (err) {
      console.warn(
        '[matters/diff] failed:',
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: err instanceof Error ? err.message : 'diff failed',
      });
    }
  },
);

/**
 * Download the diff between two matter documents as a tracked-change
 * `.docx`. Word opens the result with native tracked changes; accept-all
 * reproduces the right document, reject-all reproduces the left. GET
 * (not POST) so a plain `<a download>` works.
 */
app.get(
  '/api/matters/:matterId/diff/download',
  requireAuth,
  async (req, res) => {
    const matterId = String(req.params.matterId ?? '');
    const matter = await workspaces.getWorkspace(matterId);
    if (!matter) {
      res.status(404).json({ error: 'matter not found' });
      return;
    }
    const leftFileId = String(req.query.leftFileId ?? '').trim();
    const rightFileId = String(req.query.rightFileId ?? '').trim();
    const author =
      String(req.query.author ?? '').trim() ||
      getSessionUser(req)?.email ||
      'Counsel';
    if (!leftFileId || !rightFileId) {
      res.status(400).json({
        error: 'leftFileId and rightFileId query params are required',
      });
      return;
    }
    if (leftFileId === rightFileId) {
      res.status(400).json({
        error: 'leftFileId and rightFileId must reference different files',
      });
      return;
    }
    const left = fileStore.get(matterId, leftFileId);
    const right = fileStore.get(matterId, rightFileId);
    if (!left || !right) {
      res.status(404).json({
        error: !left
          ? `leftFileId not found: ${leftFileId}`
          : `rightFileId not found: ${rightFileId}`,
      });
      return;
    }
    try {
      const diff = await runDocumentDiff(left, right, {
        markitdownBaseUrl: config.markitdown.baseUrl,
      });
      const bytes = composeRedlineDocx({
        leftBytes: left.bytes,
        rightBytes: right.bytes,
        diff,
        author,
      });
      const filename = redlineDownloadFilename(left.name, right.name);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      res.send(bytes);
    } catch (err) {
      console.warn(
        '[matters/diff/download] failed:',
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: err instanceof Error ? err.message : 'redline failed',
      });
    }
  },
);

app.get(
  '/api/matters/:matterId/reviews/:reviewId/export.xlsx',
  requireAuth,
  async (req, res) => {
    const matterId = String(req.params.matterId ?? '');
    const reviewId = String(req.params.reviewId ?? '');
    try {
      const { workbook, fileName } = await buildReviewWorkbook({
        reviews,
        workspaces,
        reviewId,
        matterId,
      });
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`,
      );
      // exceljs streams directly to the response.
      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'export failed';
      console.warn('[reviews/export]', message);
      const status = message === 'review not found' ? 404 : 500;
      res.status(status).json({ error: message });
    }
  },
);

app.post('/api/reviews/column/draft-prompt', requireAuth, async (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) {
    res.status(400).json({ ok: false, error: 'title is required' });
    return;
  }
  const VALID_FORMATS = [
    'text',
    'short_text',
    'date',
    'yes_no',
    'bullets',
    'money',
  ] as const;
  type CellFormatLiteral = (typeof VALID_FORMATS)[number];
  const formatHintRaw =
    typeof req.body?.formatHint === 'string'
      ? req.body.formatHint.trim().toLowerCase()
      : undefined;
  const formatHint = (VALID_FORMATS as readonly string[]).includes(
    formatHintRaw ?? '',
  )
    ? (formatHintRaw as CellFormatLiteral)
    : undefined;
  const formatLocked = req.body?.formatLocked === true;
  try {
    const draft = await draftColumnPrompt(title, {
      baseUrl: config.agent.baseUrl,
      apiKey: config.agent.apiKey,
      model: config.agent.simpleModel,
      extraBody: config.agent.extraBody,
      formatHint,
      formatLocked,
    });
    // If the user explicitly picked the format, never let the model
    // override it — the lock is a UX promise, not just a hint.
    const finalFormat =
      formatLocked && formatHint ? formatHint : draft.format;
    res.json({ ok: true, prompt: draft.prompt, format: finalFormat });
  } catch (err) {
    console.warn(
      '[column-draft] failed:',
      err instanceof Error ? err.message : err,
    );
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : 'draft failed',
    });
  }
});

app.post('/api/session/reset', (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  if (sessionId) {
    fileStore.clearSession(sessionId);
    docStore.clearSession(sessionId);
  }
  res.json({ ok: true });
});

app.use(express.static(clientDistDir));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }

  res.sendFile(path.join(clientDistDir, 'index.html'), (error) => {
    if (error) {
      next();
    }
  });
});

async function main(): Promise<void> {
  await bootstrapSkills();
  rebuildToolCtx();
  await bootstrapMcp();
  await bootstrapTemplates();

  const server = app.listen(config.port, () => {
    console.log(`${config.title} listening on ${config.publicUrl}`);
    if (toolCtx.allowedHttpHosts && toolCtx.allowedHttpHosts.length > 0) {
      console.log(`http_request allow-list: ${toolCtx.allowedHttpHosts.join(', ')}`);
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    server.close();
    await mcp.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});
