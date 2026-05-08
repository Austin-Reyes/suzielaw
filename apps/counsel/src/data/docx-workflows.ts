import type { UpsertSystemWorkflowInput } from '@teamsuzie/workflows';

/**
 * System workflows that produce a structured Word deliverable via the
 * `generate_docx` chat tool. Each entry declares
 * `outputMode: 'generate_docx'` so the runtime injects the tool and
 * appends a system-prompt nudge on the launch turn.
 *
 * These are distinct from `data/prompts.ts` (free-form prose, default
 * `inline_chat`) and `data/review-templates.ts` (`tabular_review` —
 * launched into a review grid via the `from-workflow` endpoint).
 *
 * Keep this file's prompts narrow and structurally prescriptive: the
 * model gets the section/table shape from the prompt, the user fills
 * in deal-specific context, and the generate_docx tool turns the
 * combination into a Word file. Free-form drafting (memos, letters,
 * agreements) belongs in `data/prompts.ts` with the markdown drafting
 * tools — that path lets the user iterate section-by-section before
 * exporting.
 */
export const DOCX_WORKFLOWS: UpsertSystemWorkflowInput[] = [
];
