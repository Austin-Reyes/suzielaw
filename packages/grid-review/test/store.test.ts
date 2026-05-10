import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ReviewsStore } from '../src/store.js';
import { startGrTestEnv, type GrTestEnv } from './setup.js';

describe('@counsel/grid-review — ReviewsStore', () => {
  let env: GrTestEnv;
  let store: ReviewsStore;

  beforeAll(async () => {
    env = await startGrTestEnv();
    store = new ReviewsStore({ db: env.kysely });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('createReview + columns + documents + cells flow', async () => {
    const review = await store.createReview({
      workspaceId: 'ws-1',
      name: 'Medical Records Review',
    });
    const col1 = await store.addColumn({
      reviewId: review.id,
      title: 'Diagnosis',
      prompt: 'What is the primary diagnosis?',
      format: 'short_text',
    });
    const col2 = await store.addColumn({
      reviewId: review.id,
      title: 'Treatment date',
      prompt: 'Date of first treatment',
      format: 'date',
      position: 1,
    });

    const doc1 = await store.addDocument({
      reviewId: review.id,
      externalDocId: 'ext-1',
      name: 'records-1.pdf',
    });
    const doc2 = await store.addDocument({
      reviewId: review.id,
      externalDocId: 'ext-2',
      name: 'records-2.pdf',
      position: 1,
    });

    const cell = await store.upsertCell({
      reviewId: review.id,
      columnId: col1.id,
      reviewDocumentId: doc1.id,
      status: 'done',
      value: 'L4-L5 disc herniation',
      citations: [{ doc: 'ext-1', page: 3 }],
    });
    expect(cell.status).toBe('done');
    expect(cell.value).toBe('L4-L5 disc herniation');
    expect(cell.citations).toEqual([{ doc: 'ext-1', page: 3 }]);

    const snap = await store.getReviewSnapshot(review.id);
    expect(snap?.columns.map((c) => c.id)).toEqual([col1.id, col2.id]);
    expect(snap?.documents.map((d) => d.id)).toEqual([doc1.id, doc2.id]);
    expect(snap?.cells.length).toBe(1);
  });

  it('upsertCell preserves tri-state on update', async () => {
    const review = await store.createReview({ workspaceId: 'ws-2', name: 'r' });
    const col = await store.addColumn({ reviewId: review.id, title: 't', prompt: 'p' });
    const doc = await store.addDocument({ reviewId: review.id, externalDocId: 'e', name: 'n' });

    await store.upsertCell({
      reviewId: review.id,
      columnId: col.id,
      reviewDocumentId: doc.id,
      status: 'streaming',
      value: 'partial',
      citations: [{ a: 1 }],
    });
    // update only status; value + citations preserved
    const c2 = await store.upsertCell({
      reviewId: review.id,
      columnId: col.id,
      reviewDocumentId: doc.id,
      status: 'done',
    });
    expect(c2.status).toBe('done');
    expect(c2.value).toBe('partial');
    expect(c2.citations).toEqual([{ a: 1 }]);

    // explicit clear: citations=null
    const c3 = await store.upsertCell({
      reviewId: review.id,
      columnId: col.id,
      reviewDocumentId: doc.id,
      citations: null,
    });
    expect(c3.citations).toBeNull();
  });

  it('uniqueness: same (column, document) cell is upserted not duplicated', async () => {
    const review = await store.createReview({ workspaceId: 'ws-3', name: 'r' });
    const col = await store.addColumn({ reviewId: review.id, title: 't', prompt: 'p' });
    const doc = await store.addDocument({ reviewId: review.id, externalDocId: 'e', name: 'n' });

    const a = await store.upsertCell({
      reviewId: review.id,
      columnId: col.id,
      reviewDocumentId: doc.id,
      value: 'v1',
    });
    const b = await store.upsertCell({
      reviewId: review.id,
      columnId: col.id,
      reviewDocumentId: doc.id,
      value: 'v2',
    });
    expect(a.id).toBe(b.id);
    const cells = await store.listCells(review.id);
    expect(cells.length).toBe(1);
    expect(cells[0]?.value).toBe('v2');
  });

  it('uniqueness: review_documents.(review_id, external_doc_id) rejects duplicates', async () => {
    const review = await store.createReview({ workspaceId: 'ws-4', name: 'r' });
    await store.addDocument({ reviewId: review.id, externalDocId: 'dup', name: 'a' });
    await expect(
      store.addDocument({ reviewId: review.id, externalDocId: 'dup', name: 'b' }),
    ).rejects.toThrow();
  });

  it('removeColumn cascades to its cells', async () => {
    const review = await store.createReview({ workspaceId: 'ws-5', name: 'r' });
    const col = await store.addColumn({ reviewId: review.id, title: 't', prompt: 'p' });
    const doc = await store.addDocument({ reviewId: review.id, externalDocId: 'e', name: 'n' });
    await store.upsertCell({
      reviewId: review.id,
      columnId: col.id,
      reviewDocumentId: doc.id,
      value: 'v',
    });
    expect((await store.listCells(review.id)).length).toBe(1);

    expect(await store.removeColumn(col.id)).toBe(true);
    expect((await store.listCells(review.id)).length).toBe(0);
  });

  it('removeDocument cascades to its cells', async () => {
    const review = await store.createReview({ workspaceId: 'ws-6', name: 'r' });
    const col = await store.addColumn({ reviewId: review.id, title: 't', prompt: 'p' });
    const doc = await store.addDocument({ reviewId: review.id, externalDocId: 'e', name: 'n' });
    await store.upsertCell({
      reviewId: review.id,
      columnId: col.id,
      reviewDocumentId: doc.id,
      value: 'v',
    });
    expect(await store.removeDocument(doc.id)).toBe(true);
    expect((await store.listCells(review.id)).length).toBe(0);
  });

  it('removeDocumentsByExternalId scoped to workspace', async () => {
    const reviewA = await store.createReview({ workspaceId: 'wsA', name: 'a' });
    const reviewB = await store.createReview({ workspaceId: 'wsB', name: 'b' });
    await store.addDocument({ reviewId: reviewA.id, externalDocId: 'shared-ext', name: 'a' });
    await store.addDocument({ reviewId: reviewB.id, externalDocId: 'shared-ext', name: 'b' });

    const removed = await store.removeDocumentsByExternalId('wsA', 'shared-ext');
    expect(removed).toBe(1);

    expect((await store.listDocuments(reviewA.id)).length).toBe(0);
    expect((await store.listDocuments(reviewB.id)).length).toBe(1);
  });

  it('recoverStaleStreaming flips streaming → pending', async () => {
    const review = await store.createReview({ workspaceId: 'ws-7', name: 'r' });
    const col = await store.addColumn({ reviewId: review.id, title: 't', prompt: 'p' });
    const doc = await store.addDocument({ reviewId: review.id, externalDocId: 'e', name: 'n' });
    await store.upsertCell({
      reviewId: review.id,
      columnId: col.id,
      reviewDocumentId: doc.id,
      status: 'streaming',
    });

    expect(await store.recoverStaleStreaming()).toBe(1);
    const cells = await store.listCells(review.id);
    expect(cells[0]?.status).toBe('pending');
  });

  it('CHECK constraints reject bad format / status', async () => {
    const review = await store.createReview({ workspaceId: 'ws-8', name: 'r' });
    await expect(
      env.kysely
        .insertInto('review_columns')
        .values({
          id: 'c1',
          review_id: review.id,
          title: 't',
          prompt: 'p',
          // @ts-expect-error testing CHECK at DB level
          format: 'bogus',
        })
        .execute(),
    ).rejects.toThrow(/ck_review_columns_format|check constraint/i);
  });

  it('soft-delete review hides from list/get', async () => {
    const r = await store.createReview({ workspaceId: 'ws-9', name: 'r' });
    expect(await store.deleteReview(r.id)).toBe(true);
    expect(await store.getReview(r.id)).toBeNull();
    expect(await store.listReviews('ws-9')).toEqual([]);
  });
});
