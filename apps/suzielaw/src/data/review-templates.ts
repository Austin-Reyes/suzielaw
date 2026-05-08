import type { UpsertSystemWorkflowInput } from '@teamsuzie/workflows';

/**
 * System workflows that double as review templates. Each entry has a
 * `columnConfig` so the host can launch it as a tabular review across
 * a matter's documents — one column per question, one row per
 * document, citations and format coercion handled by the existing
 * review runner.
 *
 * Distinct from the free-form `data/prompts.ts` catalog (those are
 * single-document agentic recipes); review templates live here so it
 * stays obvious which workflows are launchable into a review.
 */
export const REVIEW_TEMPLATES: UpsertSystemWorkflowInput[] = [
];
