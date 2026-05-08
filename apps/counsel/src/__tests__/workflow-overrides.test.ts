import { describe, expect, it } from 'vitest';
import {
  applyWorkflowOverrides,
  GENERATE_DOCX_BLOCKED_TOOLS,
  GENERATE_DOCX_SYSTEM_PROMPT_NUDGE,
} from '../workflow-overrides.js';

interface FakeTool {
  name: string;
  /** Stand-in payload — every fake tool carries a marker so we can assert
   *  identity-preservation across the override (no clones, no name swaps). */
  marker: number;
}

const baseTools: FakeTool[] = [
  // Drafting / template tools — these are the ones that should be
  // filtered out for `generate_docx` workflows.
  { name: 'create_document', marker: 1 },
  { name: 'set_outline', marker: 2 },
  { name: 'write_section', marker: 3 },
  { name: 'append_section', marker: 4 },
  { name: 'revise_section', marker: 5 },
  { name: 'delete_section', marker: 6 },
  { name: 'export_to_docx', marker: 7 },
  { name: 'list_templates', marker: 8 },
  { name: 'get_template', marker: 9 },
  // Tools that are NOT competing — should survive the filter.
  { name: 'convert_to_markdown', marker: 100 },
  { name: 'read_section', marker: 101 },
  { name: 'search_document', marker: 102 },
  { name: 'compare_documents', marker: 103 },
  { name: 'propose_document_edits', marker: 104 },
  { name: 'vector_search', marker: 105 },
];

const generateDocxTools: FakeTool[] = [
  { name: 'generate_docx', marker: 999 },
];

const baseSystemPrompt = 'You are Counsel. Always do X.';

describe('applyWorkflowOverrides — pass-through cases', () => {
  it('passes through with null workflow', () => {
    const out = applyWorkflowOverrides({
      baseTools,
      baseSystemPrompt,
      workflow: null,
      generateDocxTools,
    });
    expect(out.tools).toBe(baseTools);
    expect(out.systemPrompt).toBe(baseSystemPrompt);
  });

  it('passes through with inline_chat workflow', () => {
    const out = applyWorkflowOverrides({
      baseTools,
      baseSystemPrompt,
      workflow: { outputMode: 'inline_chat' },
      generateDocxTools,
    });
    expect(out.tools).toBe(baseTools);
    expect(out.systemPrompt).toBe(baseSystemPrompt);
  });

  it('passes through with tabular_review workflow (would be a stale id; tabular runs via from-workflow, not chat)', () => {
    const out = applyWorkflowOverrides({
      baseTools,
      baseSystemPrompt,
      workflow: { outputMode: 'tabular_review' },
      generateDocxTools,
    });
    expect(out.tools).toBe(baseTools);
    expect(out.systemPrompt).toBe(baseSystemPrompt);
  });
});

describe('applyWorkflowOverrides — generate_docx', () => {
  it('appends generate_docx, filters out competing tools, keeps neutral tools', () => {
    const out = applyWorkflowOverrides({
      baseTools,
      baseSystemPrompt,
      workflow: { outputMode: 'generate_docx' },
      generateDocxTools,
    });

    const names = out.tools.map((t) => t.name);

    // generate_docx is in the result.
    expect(names).toContain('generate_docx');

    // Every blocked tool is absent.
    for (const blocked of GENERATE_DOCX_BLOCKED_TOOLS) {
      expect(names).not.toContain(blocked);
    }

    // Neutral tools survive.
    expect(names).toContain('convert_to_markdown');
    expect(names).toContain('read_section');
    expect(names).toContain('search_document');
    expect(names).toContain('compare_documents');
    expect(names).toContain('propose_document_edits');
    expect(names).toContain('vector_search');

    // No regression: count = (baseTools − blocked) + generateDocxTools.
    const expectedCount =
      baseTools.filter(
        (t) => !GENERATE_DOCX_BLOCKED_TOOLS.includes(t.name as never),
      ).length + generateDocxTools.length;
    expect(out.tools).toHaveLength(expectedCount);
  });

  it('preserves tool identity (no clones)', () => {
    const out = applyWorkflowOverrides({
      baseTools,
      baseSystemPrompt,
      workflow: { outputMode: 'generate_docx' },
      generateDocxTools,
    });
    // The convert_to_markdown tool from baseTools should be the SAME
    // object reference in the output, not a copy. The override is
    // mechanical filtering, not transformation.
    const survivor = baseTools.find((t) => t.name === 'convert_to_markdown')!;
    expect(out.tools).toContain(survivor);
    // generate_docx came from generateDocxTools; same identity rule.
    const docxTool = generateDocxTools[0];
    expect(out.tools).toContain(docxTool);
  });

  it('appends the nudge when there is an existing system prompt', () => {
    const out = applyWorkflowOverrides({
      baseTools,
      baseSystemPrompt,
      workflow: { outputMode: 'generate_docx' },
      generateDocxTools,
    });
    expect(out.systemPrompt).toBe(
      baseSystemPrompt + GENERATE_DOCX_SYSTEM_PROMPT_NUDGE,
    );
  });

  it('appends the nudge to an empty system prompt', () => {
    const out = applyWorkflowOverrides({
      baseTools,
      baseSystemPrompt: undefined,
      workflow: { outputMode: 'generate_docx' },
      generateDocxTools,
    });
    expect(out.systemPrompt).toBe(GENERATE_DOCX_SYSTEM_PROMPT_NUDGE);
  });

  it('preserves order: filtered baseTools first, generate_docx last', () => {
    const out = applyWorkflowOverrides({
      baseTools,
      baseSystemPrompt,
      workflow: { outputMode: 'generate_docx' },
      generateDocxTools,
    });
    expect(out.tools[out.tools.length - 1].name).toBe('generate_docx');
  });
});

describe('applyWorkflowOverrides — empty inputs', () => {
  it('handles an empty baseTools array', () => {
    const out = applyWorkflowOverrides({
      baseTools: [],
      baseSystemPrompt: '',
      workflow: { outputMode: 'generate_docx' },
      generateDocxTools,
    });
    expect(out.tools).toEqual(generateDocxTools);
  });

  it('handles missing generateDocxTools (e.g. host forgot to wire them) — degrades to a tools list with the competing tools removed and nothing added', () => {
    // This shouldn't happen in practice (the host always builds the
    // tool when output_mode is generate_docx), but the function should
    // still behave deterministically. Result: blocked tools filtered,
    // no replacement appended.
    const out = applyWorkflowOverrides({
      baseTools,
      baseSystemPrompt,
      workflow: { outputMode: 'generate_docx' },
      generateDocxTools: [],
    });
    const names = out.tools.map((t) => t.name);
    expect(names).not.toContain('create_document');
    expect(names).not.toContain('generate_docx');
    expect(names).toContain('convert_to_markdown');
  });
});
