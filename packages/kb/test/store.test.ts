import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { KnowledgeBaseStore } from '../src/store.js';
import { startKbTestEnv, type KbTestEnv } from './setup.js';

describe('@counsel/kb — KnowledgeBaseStore', () => {
  let env: KbTestEnv;
  let kb: KnowledgeBaseStore;

  beforeAll(async () => {
    env = await startKbTestEnv();
    kb = new KnowledgeBaseStore({ db: env.kysely, embedder: env.embedder });
  });

  afterAll(async () => {
    await env?.stop();
  });

  it('inserts a document and chunks its markdown', async () => {
    const doc = await kb.insert({
      name: 'demand.md',
      mimeType: 'text/markdown',
      size: 12345,
      markdown: 'Plaintiff alleges negligence.\n\nDamages exceed one million dollars.\n\nPunitive damages are sought.',
      ownerId: 'austin@reyeslaw.com',
    });
    expect(doc.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc.chunkCount).toBeGreaterThan(0);
    expect(doc.ownerId).toBe('austin@reyeslaw.com');

    const fetched = await kb.get(doc.id);
    expect(fetched?.id).toBe(doc.id);

    const chunks = await kb.listChunks(doc.id);
    expect(chunks.length).toBe(doc.chunkCount);
    expect(chunks[0]?.content).toContain('Plaintiff');
  });

  it('lists by owner with newest-first', async () => {
    const a = await kb.insert({ name: 'a.md', mimeType: 'text/markdown', size: 1, markdown: 'first doc about cars', ownerId: 'u1' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await kb.insert({ name: 'b.md', mimeType: 'text/markdown', size: 1, markdown: 'second doc about boats', ownerId: 'u1' });

    const docs = await kb.list('u1');
    const ids = docs.map((d) => d.id);
    expect(ids[0]).toBe(b.id);
    expect(ids).toContain(a.id);
  });

  it('vector search returns most-similar chunks first', async () => {
    const _doc = await kb.insert({
      name: 'topics.md',
      mimeType: 'text/markdown',
      size: 1,
      markdown: 'Settlement negotiation tactics.\n\nMedical record review checklist.\n\nDeposition outline for treating physician.',
      ownerId: 'u2',
    });

    const hits = await kb.search('deposition outline', { topK: 3, ownerId: 'u2' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.distance).toBeTypeOf('number');
    expect(hits[0]?.chunk.content.toLowerCase()).toContain('deposition');
  });

  it('keyword search returns BM25-ish ranked hits with no distance', async () => {
    const hits = await kb.searchKeyword('deposition outline', { topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.distance).toBeUndefined();
    expect(hits[0]?.chunk.content.toLowerCase()).toMatch(/deposition|outline/);
  });

  it('hybrid search returns RRF-fused results in one SQL', async () => {
    const hits = await kb.searchHybrid('settlement negotiation', { topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.rrfScore).toBeTypeOf('number');
    // Top hit should match either via vector OR keyword lane.
    expect(hits[0]?.chunk.content.toLowerCase()).toMatch(/settlement|negotiation|tactics/);
  });

  it('filters by documentIds when provided', async () => {
    const docA = await kb.insert({ name: 'A', mimeType: 't', size: 1, markdown: 'apple banana cherry', ownerId: 'u3' });
    const _docB = await kb.insert({ name: 'B', mimeType: 't', size: 1, markdown: 'apple watermelon kiwi', ownerId: 'u3' });

    const hits = await kb.search('apple', { topK: 5, documentIds: [docA.id] });
    expect(hits.every((h) => h.document.id === docA.id)).toBe(true);
  });

  it('soft-delete hides docs from list and search', async () => {
    const doc = await kb.insert({ name: 'gone.md', mimeType: 't', size: 1, markdown: 'unique-token-zebrafish lives here', ownerId: 'u4' });
    expect(await kb.get(doc.id)).not.toBeNull();

    expect(await kb.delete(doc.id)).toBe(true);
    expect(await kb.get(doc.id)).toBeNull();

    const docs = await kb.list('u4');
    expect(docs.find((d) => d.id === doc.id)).toBeUndefined();

    const hits = await kb.searchKeyword('zebrafish', { ownerId: 'u4' });
    expect(hits.find((h) => h.document.id === doc.id)).toBeUndefined();

    // Deleting again is a no-op.
    expect(await kb.delete(doc.id)).toBe(false);
  });

  it('count reflects soft deletes', async () => {
    const before = await kb.count('count-owner');
    expect(before.documents).toBe(0);

    const d = await kb.insert({ name: 'c.md', mimeType: 't', size: 1, markdown: 'one paragraph here', ownerId: 'count-owner' });
    const mid = await kb.count('count-owner');
    expect(mid.documents).toBe(1);
    expect(mid.chunks).toBeGreaterThan(0);

    await kb.delete(d.id);
    const after = await kb.count('count-owner');
    expect(after.documents).toBe(0);
    expect(after.chunks).toBe(0);
  });

  it('rejects empty markdown', async () => {
    await expect(kb.insert({ name: 'empty', mimeType: 't', size: 0, markdown: '   ' })).rejects.toThrow(/empty/);
  });
});
