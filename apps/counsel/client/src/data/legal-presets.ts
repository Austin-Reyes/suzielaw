import type { ColumnPreset } from '@teamsuzie/grid-review/browser';

/**
 * Legal column-preset pack — reference prompts for the most common
 * tabular-review column titles.
 *
 * Currently UNREGISTERED. The primary autofill path is the async
 * `draftFromTitle` callback in the column editor, which asks the simple
 * model for a starter prompt + format on every title blur and so handles
 * arbitrary titles, not just the ones below. Kept as a reference for
 * what good prompts look like per format, and as a fallback if a host
 * wants instant sync fills for the most common titles.
 *
 * Order matters when registered: the registry returns the FIRST match.
 * Multi-word phrases ("Change of control", "Force majeure") and
 * specific single words ("Termination") come before shorter / more
 * ambiguous patterns ("Term", "Parties", "Payment") so that
 * "Termination" or "Counterparty" don't silently match a more
 * general preset.
 */
export const LEGAL_PRESETS: ColumnPreset[] = [
  // --- Multi-word phrases (most specific first) ----------------------
  {
    id: 'change-of-control',
    match: /change\s+of\s+control/i,
    prompt:
      'What happens upon a change of control of either party — does the counterparty get a consent right, a termination right, payment acceleration, or something else? Note any carve-outs (e.g. internal reorganizations) and which party the right belongs to.',
    format: 'text',
  },
  {
    id: 'force-majeure',
    match: /force\s+majeure/i,
    prompt:
      "Does the agreement include a force majeure clause? If so, summarize the events covered, the relief it provides (suspension, termination, no liability), and any notice / mitigation obligations. If absent, answer \"None\".",
    format: 'text',
  },
  {
    id: 'governing-law',
    match: /governing\s+law/i,
    prompt:
      "Which jurisdiction's law governs the agreement? Answer with the named state, country, or jurisdiction only — no surrounding clause language.",
    format: 'short_text',
  },

  // --- Specific single words ----------------------------------------
  {
    id: 'termination',
    match: /^termination\b/i,
    prompt:
      'List the events or conditions under which either party may terminate the agreement, including any required notice and cure periods. One bullet per termination right; identify which party holds it.',
    format: 'bullets',
  },
  {
    id: 'indemnification',
    match: /indemn(?:ity|ification)/i,
    prompt:
      'Who indemnifies whom and for which categories of claims (third-party claims, breach of warranty, IP infringement, etc.)? Note any caps, baskets, deductibles, or carve-outs (e.g. fraud, willful misconduct).',
    format: 'text',
  },
  {
    id: 'confidentiality',
    match: /\bconfidential/i,
    prompt:
      "Summarize the confidentiality obligation: what information is protected, what carve-outs apply (publicly available, independently developed, compelled disclosure), and how long the obligation survives.",
    format: 'text',
  },
  {
    id: 'assignment',
    match: /\bassignment\b/i,
    prompt:
      'Can the agreement be assigned, and under what conditions? Note any consent requirement, deemed-assignment language (e.g. assignment by operation of law, change of control), and any consent-not-to-be-unreasonably-withheld qualifier.',
    format: 'text',
  },
  {
    id: 'warranties',
    match: /\bwarrant(?:y|ies)\b/i,
    prompt:
      'List the express warranties given by each party (e.g. authority to enter, no conflicts, compliance with law, IP non-infringement, product fitness). One bullet per warranty; identify which party gives it.',
    format: 'bullets',
  },
  {
    id: 'amendment',
    match: /\bamendment\b/i,
    prompt:
      'How can the agreement be amended? Note any required form (writing signed by both parties, board approval, etc.) and whether oral or course-of-dealing modifications are barred.',
    format: 'short_text',
  },

  // --- Short / ambiguous (last) -------------------------------------
  {
    id: 'parties',
    match: /^parties\b/i,
    prompt:
      "List the parties to the agreement and each party's defined role (e.g. \"Acme Corp. (Buyer)\", \"Borrower\", \"Lender\"). One bullet per party.",
    format: 'bullets',
  },
  {
    id: 'payment',
    match: /^(?:payment|fee|fees|consideration)\b/i,
    prompt:
      'Describe the payment obligations: amounts, currency, frequency, due dates, invoicing mechanics, and any late-fee or interest terms. Identify which party pays whom.',
    format: 'text',
  },
  {
    // /^term\b/ matches "Term" but NOT "Termination" — \b requires a
    // word/non-word boundary, and "Term" + "i" has none. Listed after
    // 'termination' for safety regardless.
    id: 'term',
    match: /^term\b/i,
    prompt:
      'What is the initial term of the agreement, and is there an automatic renewal? Answer with the duration and any renewal mechanism (e.g. "5 years, auto-renewing for 1-year terms unless either party gives 60 days\' notice").',
    format: 'short_text',
  },
];
