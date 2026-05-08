export interface WorkflowAgent {
  id: string;
  title: string;
  description: string;
  practiceAreas: string[];
  /** Steps the agent runs in order. Surface for transparency; the model executes via tools. */
  steps: string[];
}

/**
 * Multi-step legal workflow agents. Each step is a discrete action the agent
 * is expected to perform — typically tool calls (vector_search, http_request,
 * pptx-agent, etc.) interleaved with model reasoning.
 *
 * The current chat loop runs these as a single system-prompted task. A future
 * iteration will move to async job execution with status polling so long
 * workflows survive page reloads.
 */
export const WORKFLOWS: WorkflowAgent[] = [
  {
    id: 'summarize-uploaded-document',
    title: 'Summarize an uploaded document',
    description: 'TL;DR + section-by-section summary of any DOCX, PDF, or HTML you attach.',
    practiceAreas: ['general', 'litigation', 'transactional'],
    steps: [
      'When the user attaches a binary file, call convert_to_markdown(file_id) on it to produce a doc_id.',
      'Call get_outline(doc_id) to see the structure.',
      'Read each top-level section with read_section. For long documents, summarize section by section rather than reading the whole thing at once.',
      'Output: a 3–5 sentence top-line summary, then a per-section bullet list with citations to heading paths (e.g. "§2.1 Definitions: …").',
      'Flag anything ambiguous or that warrants follow-up review.',
    ],
  },
  {
    id: 'qa-on-document',
    title: 'Answer questions on an uploaded document',
    description: 'Use the document as the source of truth; cite section paths in every answer.',
    practiceAreas: ['general', 'litigation', 'transactional'],
    steps: [
      'When the user attaches a binary, call convert_to_markdown(file_id) to get a doc_id.',
      'For each question, prefer search_document(doc_id, query) for keyword-style lookups, or get_outline + read_section when the question is structural.',
      'Quote the relevant passage and cite the heading path (e.g. "§3.2(b)").',
      'If the document does not address the question, say so explicitly — do not guess.',
    ],
  },
  {
    id: 'draft-legal-memo-docx',
    title: 'Draft a legal memorandum (DOCX)',
    description: 'TOC-first agentic drafting in markdown, then export as a styled .docx.',
    practiceAreas: ['general', 'business-of-law'],
    steps: [
      'Ask the user for: subject matter, parties involved, jurisdiction, any documents to reference.',
      'Call create_document(title) to start a new memo.',
      'Propose a TOC (typical: Issue / Brief Answer / Facts / Discussion / Conclusion). Confirm with the user, then set_outline.',
      'Fill each section with write_section. Before writing each section, call read_section on the prior section so the memo stays coherent.',
      'Pause for user feedback after the first complete pass. Use revise_section + write_section for any edits.',
      'When the user is satisfied, call export_to_docx(doc_id, filename). Share the download_url.',
    ],
  },
  {
    id: 'extract-key-data-contracts',
    title: 'Extract key data from contracts',
    description: 'Parties, term, governing law, indemnities, and termination across a folder.',
    practiceAreas: ['transactional', 'mergers-acquisitions'],
    steps: [
      'Ingest each contract from the source you provide',
      'Extract: parties, effective date, term, governing law, indemnities, change-of-control, termination, payment terms',
      'Output a single normalized markdown table across all contracts',
      'Flag any contract where a field is missing or ambiguous',
    ],
  },
  {
    id: 'extract-timeline-key-events',
    title: 'Extract timeline of key events',
    description: 'Build a chronological timeline from a set of filings or correspondence.',
    practiceAreas: ['litigation', 'arbitration'],
    steps: [
      'Read each document in chronological order',
      'Extract dated events with their source citation',
      'Resolve date conflicts and merge duplicate events',
      'Output a markdown timeline plus a short narrative summary',
    ],
  },
  {
    id: 'analyze-court-transcript',
    title: 'Analyze a court transcript for key topics',
    description: 'Topic map, rulings, and preserved objections.',
    practiceAreas: ['litigation'],
    steps: [
      'Segment the transcript by topic and witness',
      'Identify the judge\'s rulings on each evidentiary issue',
      'Extract preserved objections and their basis',
      'Produce a topic map with page:line citations',
    ],
  },
  {
    id: 'analyze-deposition-transcript',
    title: 'Analyze a deposition transcript for key topics',
    description: 'Admissions, contradictions, and impeachment material.',
    practiceAreas: ['litigation'],
    steps: [
      'Index the transcript by topic',
      'Flag witness admissions favorable to each side',
      'Cross-reference prior statements (if provided) for contradictions',
      'Output a cross-examination outline with citations',
    ],
  },
  {
    id: 'analyze-change-of-control',
    title: 'Analyze change-of-control provisions',
    description: 'Triggers, consent thresholds, and consequences across a contract set.',
    practiceAreas: ['mergers-acquisitions', 'transactional'],
    steps: [
      'Locate change-of-control language in each contract',
      'Classify the trigger type (asset / equity / merger / regulatory)',
      'Extract consent requirements, notice windows, and consequences',
      'Produce a comparison table and a short risk note',
    ],
  },
  {
    id: 'check-diligence-request-list',
    title: 'Check a diligence request list',
    description: 'Coverage check against a deal type and target profile.',
    practiceAreas: ['mergers-acquisitions', 'transactional'],
    steps: [
      'Classify the deal (asset / stock / merger; size; industry)',
      'Score each request line for relevance to the deal type',
      'Identify missing standard categories',
      'Produce a marked-up list with additions and rationale',
    ],
  },
  {
    id: 'draft-from-template',
    title: 'Draft from a template',
    description: 'Fill a document template from a fact pattern, flagging gaps.',
    practiceAreas: ['general', 'transactional'],
    steps: [
      'Read the template and identify all required fields',
      'Map fields to the fact pattern provided',
      'Fill the document and flag any unmapped fields',
      'Output the filled draft plus a list of gaps for the lawyer to confirm',
    ],
  },
  {
    id: 'draft-board-deck',
    title: 'Draft a board update deck',
    description: 'Generate a 5–10 slide board deck from a memo or talking points.',
    practiceAreas: ['business-of-law'],
    steps: [
      'Outline 5–10 slides from the source material',
      'Draft the title and bullets for each slide',
      'Generate the .pptx via the pptx-agent tool',
      'Return a download link and an outline summary',
    ],
  },
  {
    id: 'translate-document',
    title: 'Translate document into another language',
    description: 'Faithful translation with preserved citations and a legalese glossary.',
    practiceAreas: ['general'],
    steps: [
      'Detect source language and confirm target',
      'Translate, preserving citations and defined terms verbatim',
      'Produce a glossary of any legalese with cross-language equivalents',
    ],
  },
  {
    id: 'transcribe-audio',
    title: 'Transcribe audio to text',
    description: 'Speaker-attributed transcript with timestamps.',
    practiceAreas: ['general', 'litigation'],
    steps: [
      'Transcribe the audio source you provide',
      'Attribute speakers and add timestamps every minute',
      'Flag inaudible passages',
      'Output markdown plus a short summary of topics covered',
    ],
  },
];
