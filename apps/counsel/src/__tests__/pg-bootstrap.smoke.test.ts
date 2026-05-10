import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { v7 as uuidv7 } from 'uuid';

/**
 * End-to-end smoke test for the app's @counsel/* bootstrap path.
 *
 * Boots a real pgvector/pgvector:pg16 container, points the app's
 * `bootstrapCounselDb()` at it, and exercises every store via the
 * returned handle. This is the integration evidence that the in-app
 * factory (pg-db.ts) wires everything correctly — distinct from the
 * per-package contract tests, which only prove each store works in
 * isolation.
 *
 * If this test passes, we have empirical evidence that:
 *   - Migrations resolve correctly via the relative-path lookup in pg-db.ts
 *   - search_path is set per-connection (unqualified table names work)
 *   - Static-password Pool path constructs cleanly
 *   - Every store in the handle is wired to the same kysely + pool
 *   - The composed AppDB type is assignable to each store's narrower scope
 */

let container: StartedTestContainer;

beforeAll(async () => {
  container = await new GenericContainer('pgvector/pgvector:pg16')
    .withEnvironment({
      POSTGRES_DB: 'counsel',
      POSTGRES_USER: 'counsel',
      POSTGRES_PASSWORD: 'counsel',
    })
    .withExposedPorts(5432)
    .withStartupTimeout(120_000)
    .start();

  // Wire env vars BEFORE importing pg-db.ts — the bootstrap reads from
  // process.env at the moment of the first await.
  process.env.PGHOST = container.getHost();
  process.env.PGPORT = String(container.getMappedPort(5432));
  process.env.PGDATABASE = 'counsel';
  process.env.PGUSER = 'counsel';
  process.env.PGPASSWORD = 'counsel';
  process.env.PGSCHEMA = 'counsel';
  process.env.PGSSLMODE = 'disable';

  // Embedder env (the bootstrap pulls these from app config, which reads env).
  // Use the test-friendly fake values; we don't actually call OpenAI here.
  process.env.COUNSEL_EMBEDDING_BASE_URL = 'http://nowhere.invalid';
  process.env.COUNSEL_EMBEDDING_API_KEY = 'unused';
  process.env.COUNSEL_EMBEDDING_MODEL = 'text-embedding-3-small';
  process.env.COUNSEL_EMBEDDING_DIM = '1536';
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe('@counsel/assistant — bootstrapCounselDb integration', () => {
  it('boots, runs migrations, and returns a working store handle', async () => {
    // Lazy-import so the env vars set above are seen by config.ts during eval.
    const { bootstrapCounselDb } = await import('../pg-db.js');
    const handle = await bootstrapCounselDb();

    try {
      // Schema isolation: we should be in counsel.* via search_path.
      const schemaCheck = await handle.kysely
        .selectNoFrom((eb) => eb.fn<string>('current_schema').as('s'))
        .executeTakeFirstOrThrow();
      expect(schemaCheck.s).toBe('counsel');

      // Workflows store: seed two rows, list them.
      await handle.stores.workflows.upsertSystem({
        id: 'smoke-1',
        name: 'Smoke 1',
        prompt: 'p',
      });
      await handle.stores.workflows.upsertSystem({
        id: 'smoke-2',
        name: 'Smoke 2',
        prompt: 'p',
        columnConfig: [{ title: 'Col', prompt: 'q', format: 'text' }],
      });
      const sys = await handle.stores.workflows.listBySource('system');
      expect(sys.map((w) => w.id).sort()).toContain('smoke-1');
      expect(sys.find((w) => w.id === 'smoke-2')?.outputMode).toBe('tabular_review');

      // Workspaces store: create + list scoped soft delete.
      const ws = await handle.stores.workspaces.createWorkspace({ name: 'Smoke matter' });
      expect(ws.id).toMatch(/^[0-9a-f-]{36}$/);
      const list = await handle.stores.workspaces.listWorkspaces();
      expect(list.find((w) => w.id === ws.id)).toBeDefined();

      // Members store: grant + canAccess.
      await handle.stores.members.addMember({
        subjectType: 'matter',
        subjectId: ws.id,
        userId: 'austin@reyeslaw.com',
        role: 'owner',
      });
      const role = await handle.stores.members.canAccess(
        { type: 'matter', id: ws.id },
        'austin@reyeslaw.com',
      );
      expect(role).toBe('owner');

      // Chats store: create + append + list.
      const chat = await handle.stores.chats.createChat({
        workspaceId: ws.id,
        name: 'Smoke chat',
      });
      await handle.stores.chats.appendMessage({
        chatId: chat.id,
        role: 'user',
        content: 'Hello',
      });
      const msgs = await handle.stores.chats.listMessages(chat.id);
      expect(msgs.length).toBe(1);

      // Document versions: chain + head pointer.
      const docId = uuidv7();
      const v1 = await handle.stores.documentVersions.addVersion({
        externalDocId: docId,
        source: 'upload',
        storageId: 'st-1',
      });
      const head = await handle.stores.documentVersions.getHead(docId);
      expect(head?.id).toBe(v1.id);

      // Reviews store: create + add column + cell upsert.
      const review = await handle.stores.reviews.createReview({
        workspaceId: ws.id,
        name: 'Smoke review',
      });
      const col = await handle.stores.reviews.addColumn({
        reviewId: review.id,
        title: 'Diagnosis',
        prompt: 'q',
        format: 'short_text',
      });
      const reviewDoc = await handle.stores.reviews.addDocument({
        reviewId: review.id,
        externalDocId: 'ext-1',
        name: 'doc',
      });
      const cell = await handle.stores.reviews.upsertCell({
        reviewId: review.id,
        columnId: col.id,
        reviewDocumentId: reviewDoc.id,
        status: 'done',
        value: 'L4-L5',
        citations: [{ doc: 'ext-1', page: 3 }],
      });
      expect(cell.value).toBe('L4-L5');
      expect(cell.citations).toEqual([{ doc: 'ext-1', page: 3 }]);

      // Personas store: create + list scoped to owner.
      const persona = await handle.stores.personas.create({
        ownerId: 'austin@reyeslaw.com',
        name: 'PI',
        description: 'd',
        systemPrompt: 'You are a PI attorney.',
      });
      expect(persona.id).toMatch(/^[0-9a-f-]{36}$/);
      const myPersonas = await handle.stores.personas.list('austin@reyeslaw.com');
      expect(myPersonas.find((p) => p.id === persona.id)).toBeDefined();

      // Model settings: per-(user, provider) BYOK key shape.
      await handle.stores.modelSettings.setProviderKey(
        'austin@reyeslaw.com',
        'openai',
        'sk-test',
      );
      const summary = await handle.stores.modelSettings.publicProviderKeys(
        'austin@reyeslaw.com',
        ['openai'],
      );
      expect(summary[0]?.hasKey).toBe(true);
      expect(Object.keys(summary[0] ?? {})).not.toContain('apiKey');
    } finally {
      await handle.close();
    }
  }, 120_000);
});
