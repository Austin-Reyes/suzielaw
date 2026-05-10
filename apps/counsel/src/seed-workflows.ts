import type { WorkflowsStore } from '@counsel/workflows';

import { PROMPTS } from './data/prompts.js';
import { REVIEW_TEMPLATES } from './data/review-templates.js';
import { DOCX_WORKFLOWS } from './data/docx-workflows.js';

/**
 * Seed system workflows from the canonical legal-prompt catalog into the
 * `workflows` table. Idempotent — safe to call on every boot.
 *
 * The legacy `user_prompts` migration that lived here previously was
 * dropped with the move to `@counsel/workflows`: prod has no rows in
 * the upstream sqlite path (Easy Auth is the first time real user
 * data lands), and any local dev rows are acceptable to lose.
 */
export async function seedAndMigrateWorkflows(
  workflows: WorkflowsStore,
): Promise<void> {
  const promptSeeds = PROMPTS.map((p) => ({
    id: p.id,
    name: p.title,
    description: p.description,
    prompt: p.prompt,
    practiceAreas: p.practiceAreas,
  }));
  const seeds = [...promptSeeds, ...REVIEW_TEMPLATES, ...DOCX_WORKFLOWS];
  const seedResult = await workflows.seedSystem(seeds);
  if (seedResult.upserted > 0 || seedResult.removed > 0) {
    console.log(
      `[workflows] seeded system catalog: ${seedResult.upserted} upserted, ${seedResult.removed} removed`,
    );
  }
}
