import type { DatabaseInstance } from '@teamsuzie/db-sqlite';
import type { WorkflowsStore } from '@teamsuzie/workflows';

import { PROMPTS } from './data/prompts.js';
import { REVIEW_TEMPLATES } from './data/review-templates.js';
import { DOCX_WORKFLOWS } from './data/docx-workflows.js';

interface LegacyUserPromptRow {
  id: string;
  title: string;
  description: string;
  practice_areas: string;
  prompt: string;
  created_by: string | null;
  created_at: number;
}

/**
 * Seed system workflows from the canonical legal-prompt catalog and
 * one-time migrate any rows from the legacy `user_prompts` table into
 * the new `workflows` table as user rows. Both passes are idempotent;
 * safe to call on every boot.
 *
 * The legacy `user_prompts` table predates the workflows store — its
 * rows now live in `workflows` with `source='user'`, preserving the
 * original id and `created_by` (as `owner_id`). The legacy table is
 * left in place for now; a future migration can drop it once we're
 * confident nothing else reads from it.
 */
export function seedAndMigrateWorkflows(
  workflows: WorkflowsStore,
  db: DatabaseInstance,
): void {
  // 1. Seed the system catalog. PromptTemplate's `title` maps onto
  //    Workflow.name; everything else lines up. Stale rows (ids no
  //    longer in the catalog) get dropped — code is the source of
  //    truth for what `source='system'` rows exist.
  const promptSeeds = PROMPTS.map((p) => ({
    id: p.id,
    name: p.title,
    description: p.description,
    prompt: p.prompt,
    practiceAreas: p.practiceAreas,
  }));
  // Review-template workflows ship alongside the free-form prompts;
  // both are 'system' rows. The host distinguishes them at launch time
  // by `columnConfig` / `outputMode`. Generate-docx workflows get the
  // same treatment — `outputMode: 'generate_docx'` carries the routing
  // signal.
  const seeds = [...promptSeeds, ...REVIEW_TEMPLATES, ...DOCX_WORKFLOWS];
  const seedResult = workflows.seedSystem(seeds);
  if (seedResult.upserted > 0 || seedResult.removed > 0) {
    console.log(
      `[workflows] seeded system catalog: ${seedResult.upserted} upserted, ${seedResult.removed} removed`,
    );
  }

  // 2. Idempotent migration of legacy user prompts. The destination
  //    workflows table requires owner_id non-null for user rows; we
  //    fall back to a sentinel string when the legacy row has none, so
  //    those rows are still queryable but won't show up under any real
  //    user's listVisible.
  const legacyTableExists =
    db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'`,
      )
      .get() !== undefined;
  if (!legacyTableExists) return;

  const legacyRows = db
    .prepare<[], LegacyUserPromptRow>(`SELECT * FROM user_prompts`)
    .all();
  if (legacyRows.length === 0) return;

  const insert = db.prepare<[
    string,
    string,
    string,
    string,
    string,
    string,
    number,
    number,
  ]>(
    `INSERT OR IGNORE INTO workflows
       (id, source, owner_id, name, description, prompt, practice_areas, created_at, updated_at)
     VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?)`,
  );
  let migrated = 0;
  const tx = db.transaction(() => {
    for (const row of legacyRows) {
      const ownerId = row.created_by ?? 'legacy:unknown';
      // Tolerate practice_areas stored as JSON or as a JSON-stringified
      // string (the legacy schema is loose); normalize to a JSON array.
      let practiceAreas: string[] = [];
      try {
        const parsed = JSON.parse(row.practice_areas);
        if (Array.isArray(parsed)) {
          practiceAreas = parsed.filter((x): x is string => typeof x === 'string');
        }
      } catch {
        /* leave empty */
      }
      const result = insert.run(
        row.id,
        ownerId,
        row.title,
        row.description ?? '',
        row.prompt,
        JSON.stringify(practiceAreas),
        row.created_at,
        row.created_at,
      );
      if (result.changes > 0) migrated += 1;
    }
  });
  tx();
  if (migrated > 0) {
    console.log(
      `[workflows] migrated ${migrated} legacy user_prompts row(s) into workflows`,
    );
  }
}
