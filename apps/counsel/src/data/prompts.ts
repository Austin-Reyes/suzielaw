export interface PromptTemplate {
  id: string;
  title: string;
  description: string;
  practiceAreas: string[];
  prompt: string;
}

/**
 * Seed catalog of legal prompt templates. Each prompt is written as an
 * agentic recipe — it tells the model which tools to call (convert_to_markdown,
 * get_outline, read_section, search_document, drafting tools, export_to_docx)
 * and how to shape the output. A user pastes/uploads, the model executes.
 *
 * Users save their own via the workflows store (`/api/workflows`).
 */
export const PROMPTS: PromptTemplate[] = [
  {
    id: 'draft-legal-memo-docx',
    title: 'Draft a legal memorandum (DOCX)',
    description:
      'TOC-first agentic drafting in markdown, exported as a styled .docx at the end.',
    practiceAreas: ['general', 'business-of-law'],
    prompt: `I'd like to draft a legal memorandum.

Run this drafting flow end to end:

1. Ask me for the subject matter, parties involved, jurisdiction, and any documents I want you to reference.
2. Call create_document with a concise title.
3. Propose a TOC (typical: Issue / Brief Answer / Facts / Discussion / Conclusion). Confirm with me, then call set_outline.
4. Fill each section with write_section. Before writing each section, call read_section on the prior section so the memo stays coherent.
5. Pause for my feedback after the first complete pass. Use revise_section + write_section for edits.
6. When I'm satisfied, call export_to_docx and share the download link as a markdown link in the chat.`,
  },
  {
    id: 'draft-email-from-notes',
    title: 'Draft email from notes',
    description: 'Turn loose notes into a polished email to opposing counsel or a client.',
    practiceAreas: ['general'],
    prompt:
      "I'll paste notes (or attach a document with notes — convert_to_markdown first if so). Draft a professional email from them: concise, neutral, request specific next steps where appropriate. Return the email body inline as markdown — no DOCX export needed unless I ask.",
  },
  {
    id: 'draft-memo-from-notes',
    title: 'Draft memo from notes',
    description: 'Turn case notes or research into a structured internal memo, exported as DOCX.',
    practiceAreas: ['general'],
    prompt: `I'll paste notes (or attach a document — convert_to_markdown first if so).

Run this drafting flow:

1. Read the notes; ask me for any missing context (parties, jurisdiction, audience).
2. Call create_document and set_outline using the standard structure (Issue / Brief Answer / Facts / Discussion / Conclusion).
3. Fill each section via write_section, drawing on the notes; flag where the notes are silent and you're inferring.
4. Call export_to_docx and share the download link as a markdown link.`,
  },
  {
    id: 'rewrite-polish',
    title: 'Rewrite or polish text',
    description: 'Tighten language, fix tone, preserve meaning.',
    practiceAreas: ['general'],
    prompt:
      "Rewrite the text I paste. Tighten language, fix any awkward phrasing, and keep the meaning intact. Default to a professional tone unless I say otherwise. Return the rewritten text inline.",
  },
  {
    id: 'summarize-document',
    title: 'Summarize an uploaded document',
    description: 'Structural read of an attached DOCX or PDF — outline, priority sections, formal summary.',
    practiceAreas: ['general'],
    prompt:
      "I'll attach a document. Summarize it using the document-summarization workflow: convert_to_markdown, get_outline, pick the priority sections to read in full via read_section, and produce a formal summary that fits the document type. Cite heading paths (§, Article, Item) inline.",
  },
  {
    id: 'court-transcript-key-topics',
    title: 'Analyze court transcript for key topics',
    description: 'Topic map with citations, judge\'s rulings, and preserved objections.',
    practiceAreas: ['litigation'],
    prompt:
      "I'll attach the transcript. convert_to_markdown, get_outline, read_section on each segment. Produce a topic map: each topic gets a heading, then a 1-line summary, page/line citations (e.g. 17:4–18:9), the judge's rulings on that topic, and any preserved objections. Sort by importance, not chronology. Close with a one-paragraph synthesis of how the hearing went strategically.",
  },
  {
    id: 'deposition-transcript-key-topics',
    title: 'Analyze deposition transcript for key topics',
    description: 'Witness admissions, contradictions, and impeachment material.',
    practiceAreas: ['litigation'],
    prompt:
      "I'll attach the deposition transcript. convert_to_markdown, get_outline, read_section through. Output four sections: Key Admissions (with page/line citations) | Contradictions With Prior Statements (cite both sources) | Impeachment Material (gaps, evasions, inconsistencies — cite page/line) | Topics Witness Avoided. Close with a one-paragraph cross-examination strategy note.",
  },
  {
    id: 'complaint-procedural-substantive',
    title: 'Analyze complaint — procedural and substantive',
    description: 'Claims, jurisdiction, prayers for relief, and likely defenses.',
    practiceAreas: ['litigation'],
    prompt:
      "I'll attach the complaint. convert_to_markdown, get_outline, read_section. Output: Caption + parties (with citations of capacity) | Jurisdiction & venue basis (with paragraph cites) | Each cause of action — name | elements | factual support paragraphs | requested relief | Procedural posture (any pending motions, prior proceedings) | Three plausible defenses (each with one-line reasoning + which element it attacks). Cite paragraph numbers throughout.",
  },
  {
    id: 'spelling-grammar-proofread',
    title: 'Proofread for spelling and grammar',
    description: 'Catch typos, agreement errors, and inconsistent capitalization.',
    practiceAreas: ['general'],
    prompt:
      "Proofread the text I paste for spelling, grammar, agreement, and inconsistent capitalization. Return a clean version, then a short bullet list of significant changes (skip trivial typos). If I attach a document instead, convert_to_markdown first.",
  },
  {
    id: 'courtlistener-case-research',
    title: 'Research case law on a legal issue (CourtListener)',
    description: 'Search CourtListener opinions, summarize the leading cases, and cite each holding.',
    practiceAreas: ['litigation', 'general'],
    prompt: `Research case law on the issue I describe below using CourtListener.

1. Run \`courtlistener_search\` with type "o" (opinions) and a tightly-scoped query. Apply court / date filters when I give them.
2. Pick the 3–6 most on-point hits. For each, call \`courtlistener_get_cluster\` (and \`courtlistener_get_opinion\` if you need reasoning text) to read the holding.
3. Return a markdown table — Case | Court | Year | Holding (1–2 sentences) | CourtListener URL — followed by a short synthesis of how the cases line up (majority rule vs. splits).

Issue:`,
  },
  {
    id: 'courtlistener-citation-check',
    title: 'Verify citations in a brief (CourtListener)',
    description: 'Extract every citation from pasted text and check each against CourtListener.',
    practiceAreas: ['litigation', 'general'],
    prompt: `I will paste a passage from a brief or memo. Verify every citation in it.

1. Call \`courtlistener_lookup_citation\` with the full passage as \`text\` so the API extracts citations for you.
2. For each result, report: the citation as written, normalized form, status (found / not found / unknown reporter), and the matching case name + URL when available.
3. Flag any citation that did not resolve, and any that resolved to a different case than the surrounding text suggests.`,
  },
  {
    id: 'courtlistener-judge-profile',
    title: 'Profile a judge (CourtListener)',
    description: 'Pull positions, recent opinions, and notable rulings for a named judge.',
    practiceAreas: ['litigation', 'general'],
    prompt: `Build a one-page profile of the judge I name.

1. Call \`courtlistener_search\` with type "p" to find the judge record. Capture positions and tenure.
2. Call \`courtlistener_search\` with type "o" and \`judge\` set to their name, ordered by \`dateFiled desc\`, page_size 15.
3. Pick 3–5 representative opinions and read each cluster via \`courtlistener_get_cluster\`.
4. Output: judge name, current/past positions, summary of judicial leanings as suggested by the recent opinions, and a citation list with CourtListener URLs.`,
  },
  {
    id: 'courtlistener-recap-docket',
    title: 'Pull a federal docket from RECAP (CourtListener)',
    description: 'Find a case in RECAP and summarize the docket and recent entries.',
    practiceAreas: ['litigation'],
    prompt: `Find the federal case I describe in RECAP (CourtListener) and summarize the docket.

1. Call \`courtlistener_search\` with type "r" using the case name and any docket number / court I give you.
2. Pick the most likely match and call \`courtlistener_get_docket\` on its \`docket_id\`.
3. Output: case caption, court, docket number, judge assigned, nature of suit, key dates, parties, and a chronological list of the 10 most recent docket entries with one-line summaries. Include the CourtListener docket URL.`,
  },
  {
    id: 'courtlistener-opinion-summary',
    title: 'Summarize an opinion by citation (CourtListener)',
    description: 'Resolve a citation and produce a structured case brief.',
    practiceAreas: ['litigation', 'general'],
    prompt: `I will give you a case citation (e.g., "576 U.S. 644") or a case name. Produce a structured case brief.

1. Use \`courtlistener_lookup_citation\` (or \`courtlistener_search\` if I gave a case name) to resolve to a cluster_id.
2. Call \`courtlistener_get_cluster\` for case-level metadata, then \`courtlistener_get_opinion\` on the lead opinion for reasoning.
3. Output: Caption · Court · Year · Citation · Procedural posture · Facts · Issue · Holding · Reasoning · Disposition · Notable concurrences/dissents · CourtListener URL. Cite paragraphs by their position in the opinion text where useful.`,
  },
  {
    id: 'courtlistener-recap-filing-read',
    title: 'Read a specific filing in RECAP (CourtListener)',
    description: 'Drill from a docket into a specific filing\'s OCR\'d text and summarize.',
    practiceAreas: ['litigation'],
    prompt: `Read the specific filing I describe in a federal docket and summarize it.

1. Find the docket via \`courtlistener_search\` type "r" and call \`courtlistener_get_docket\` to confirm.
2. List the timeline with \`courtlistener_list_docket_entries\`. Identify the filing the user wants (by entry number, date, or description).
3. Pull its text via \`courtlistener_get_recap_document\` using the recap-document id from the entry.
4. Output: filing caption | docket entry # | date filed | filer | one-paragraph summary | the 3–5 most important paragraphs quoted | CourtListener URL.`,
  },
  {
    id: 'courtlistener-shepardize',
    title: 'Map who cites a landmark opinion (CourtListener)',
    description: 'Use the citation graph to find later opinions that cite a target opinion.',
    practiceAreas: ['litigation', 'general'],
    prompt: `Map the descendants of the opinion I will identify (by citation or case name) — i.e. opinions that cite *into* it.

1. Resolve the opinion to an opinion_id (\`courtlistener_lookup_citation\` → cluster → opinion, or \`courtlistener_search\` type "o").
2. Call \`courtlistener_opinions_cited\` with \`cited_opinion_id\` set to that id, page_size 50.
3. For the most cited / most recent 5–8 descendants, fetch their cluster via \`courtlistener_get_cluster\` to get caption, court, year.
4. Output: target opinion (citation, holding in one sentence), then a table of descendants — Case | Court | Year | How it treats the target (followed / distinguished / criticized / overruled) | URL. If you can\'t determine treatment from the snippet, mark "uncertain — read the opinion".`,
  },
  {
    id: 'compare-two-documents',
    title: 'Compare two documents',
    description: 'Side-by-side diff of clauses, terms, and structure.',
    practiceAreas: ['general', 'transactional', 'mergers-acquisitions'],
    prompt:
      "I'll attach two documents. convert_to_markdown both, then get_outline on each. For each major section that exists in either doc, output a row: Section | Doc A excerpt | Doc B excerpt | Notes on differences. Cite heading paths. Close with three sentences summarizing the most material differences.",
  },
  {
    id: 'legalese-to-plain-english',
    title: 'Translate legalese to plain English',
    description: 'Rewrite a contract or clause for a non-lawyer.',
    practiceAreas: ['general'],
    prompt:
      "I'll paste or attach legalese. If attached, convert_to_markdown first. Rewrite it in plain English suitable for a sophisticated non-lawyer (CFO/CEO level — keep the substance, drop the latinisms and triple-nested defined terms). Preserve all material rights and obligations. Flag anywhere the original is ambiguous so the plain-English version doesn't paper over it.",
  },
  {
    id: 'build-chronology',
    title: 'Build chronology from documents',
    description: 'Extract dated events from one or more uploads into a timeline.',
    practiceAreas: ['general', 'litigation', 'arbitration', 'business-of-law'],
    prompt:
      "I'll attach one or more documents. For each: convert_to_markdown, walk via get_outline + read_section. Pull every dated event (correspondence, transactions, filings, meetings). Output a markdown table: Date | Event | Source (filename + heading path) | Notes. Sort chronologically. Flag date conflicts across docs.",
  },
  {
    id: 'qa-from-document',
    title: 'Generate Q&A pairs from a document',
    description: 'Useful for training material, FAQs, knowledge-base seeding.',
    practiceAreas: ['general'],
    prompt:
      "I'll attach a document. convert_to_markdown, get_outline. For each major section, generate 2–3 Q&A pairs that someone unfamiliar with the doc might ask, with answers grounded in specific section text. Output as: ### Question | Answer (cite heading path). Aim for 15–25 pairs across the document.",
  },
  {
    id: 'draft-witness-statement',
    title: 'Draft witness statement',
    description: 'IBA-style witness statement from notes, exported as DOCX.',
    practiceAreas: ['arbitration', 'litigation'],
    prompt: `I'll provide notes from the witness interview (paste or attach).

Drafting flow:
1. Ask for the witness's role, the topics to cover, and the relevant time period.
2. create_document titled "Witness Statement of [Name]".
3. set_outline: Introduction (witness background) | [Topic 1] | [Topic 2] | … | Statement of Truth.
4. Fill via write_section. First-person, numbered paragraphs, IBA-style. Cite exhibits where the witness references documents.
5. export_to_docx and share the download link.`,
  },
  {
    id: 'motion-to-dismiss-outline',
    title: 'Draft motion to dismiss outline',
    description: '12(b)(6) / 12(b)(1) / 12(b)(2) outline, exported as DOCX.',
    practiceAreas: ['litigation'],
    prompt: `I'll attach the complaint and identify the bases for dismissal.

Drafting flow:
1. convert_to_markdown the complaint; map each count to dismissal theory.
2. create_document titled "Motion to Dismiss — Outline".
3. set_outline: Introduction + Relief Sought | Background (procedural + factual taken as alleged) | Legal Standard | Argument I (per ground) | Argument II … | Conclusion.
4. Fill via write_section. For Twombly/Iqbal arguments, walk through what's conclusory vs factual paragraph-by-paragraph.
5. export_to_docx and share the download link.`,
  },
  {
    id: 'summary-judgment-outline',
    title: 'Draft summary judgment outline',
    description: 'MSJ skeleton with statement of undisputed facts.',
    practiceAreas: ['litigation'],
    prompt: `I'll describe the case posture and target claims.

Drafting flow:
1. Ask for the discovery record citations supporting each undisputed fact.
2. create_document titled "Motion for Summary Judgment — Outline".
3. set_outline: Introduction | Statement of Undisputed Material Facts (numbered, each with record citation) | Legal Standard | Argument (per claim/element) | Conclusion.
4. Fill via write_section.
5. export_to_docx and share the download link.`,
  },
  {
    id: 'discovery-plan',
    title: 'Build a discovery plan',
    description: 'Phase-task discovery plan with proportionality analysis.',
    practiceAreas: ['litigation'],
    prompt:
      "I'll describe the case (claims, defenses, key disputed facts). Output a discovery plan: Issue-by-Issue Proof Map | Custodians + Sources | Document-Production Strategy + Volume Estimate | RFP / RFA / Interrogatory Plan | Deposition Sequence + Topics | Expert Strategy | ESI Protocol Issues | Proportionality Notes (per Rule 26(b)(1) factors) | Schedule + Milestones.",
  },
  {
    id: 'deposition-outline',
    title: 'Draft deposition outline',
    description: 'Topic-and-exhibit-based deposition outline.',
    practiceAreas: ['litigation'],
    prompt:
      "I'll describe the witness (role, connection to facts) and the case theory. Output a deposition outline: Background / Scope / Foundation | Topic 1: Goal | Key Documents (Bates) | Question Threads | Lock-Down Points (admissions you need) | Topic 2 … | Wrap-up + Catch-All. Mark each question with the case theory it serves.",
  },
  {
    id: 'mediation-statement',
    title: 'Draft mediation statement',
    description: 'Confidential mediation submission, exported as DOCX.',
    practiceAreas: ['litigation'],
    prompt: `I'll describe the dispute and what the mediator should know.

Drafting flow:
1. Ask whether the statement will be exchanged or kept ex parte.
2. create_document titled "Mediation Statement".
3. set_outline: Confidentiality Statement | Parties + Procedural Posture | Statement of Facts | Liability Analysis | Damages | Settlement Posture + Bargaining Range | Issues for the Mediator.
4. Fill via write_section.
5. export_to_docx and share the download link.`,
  },
  {
    id: 'trial-outline',
    title: 'Build a trial outline',
    description: 'Witness order + exhibits + proof matrix.',
    practiceAreas: ['litigation'],
    prompt:
      "I'll describe the case (claims, defenses, witnesses, key exhibits). Output a trial outline: Theme of the Case | Order of Proof (witness sequencing) | Witness-by-Witness (purpose, key Q&A, exhibits introduced) | Exhibit List + Foundation Plan | Stipulations + Pretrial Motions | Closing Themes + Jury Instruction Targets.",
  },
  {
    id: 'pi-medical-record-chronology',
    title: 'Build medical-record chronology (TX PI)',
    description:
      'Multi-provider medical chronology with provider, date, diagnosis, treatment, and citation back to the underlying record.',
    practiceAreas: ['personal-injury', 'pre-litigation'],
    prompt: `I want a unified medical-record chronology across all uploaded medical records.

Run this flow:

1. Call list_documents to see what's attached. If nothing is attached, ask me to upload the records (PDF/DOCX) and stop.
2. For each document, call convert_to_markdown if it's a binary, then get_outline + read_section as needed to walk the record.
3. Call create_document with title "Medical-Record Chronology — <client name if I provide one>".
4. Call set_outline with these sections: Summary | Providers | Chronology | Open Questions.
5. Fill Providers with one short paragraph per provider (name, specialty, treatment dates, role in care).
6. Fill Chronology as a markdown table with columns: Date | Provider | Type of visit | Diagnosis / Findings | Treatment | Cite. Use ascending date order. Group same-day visits together. Cite each row to the source document + page (e.g. "records-ortho.pdf p.14").
7. Fill Summary with a 3–5 sentence overview: mechanism of injury (if visible), course of treatment, current status, and red flags.
8. Fill Open Questions with anything missing or contradictory across providers — gaps in treatment, unexplained diagnoses, prior-injury references, missing imaging, etc.
9. Pause for my edits.
10. When I confirm, call export_to_docx and share the download link as a markdown link.

Hard rule: do not invent a date, provider, diagnosis, or finding. If something isn't in the records, write "not in records provided" — never guess.`,
  },
  {
    id: 'pi-18001-affidavit',
    title: '§ 18.001 affidavit prep (TX)',
    description:
      'Draft a Tex. Civ. Prac. & Rem. Code § 18.001 billing affidavit covering reasonable and necessary medical expenses for a single provider.',
    practiceAreas: ['personal-injury', 'litigation', 'pre-litigation'],
    prompt: `I want to prepare a § 18.001 billing affidavit for one medical provider.

Run this flow:

1. Ask me which provider this affidavit covers and the affiant's name/title (typically the records custodian or billing administrator).
2. Call list_documents and identify the billing records / itemized statements for that provider. If none are attached, ask me to upload them and stop.
3. Call convert_to_markdown / read_section as needed to extract the billed charges. Total them. Note the date range of services.
4. Call create_document with a title like "§ 18.001 Affidavit — <provider name>".
5. Call set_outline with: Caption | Affidavit Body | Exhibit Reference | Notary Block.
6. Draft the body using the standard § 18.001(b) language: the affiant's identity, custodian-of-records position, that the attached records are kept in the regular course of business, that the charges are reasonable for the services provided, and that the services were necessary. Use the statutory language closely — § 18.001 is form-driven and defects are fatal.
7. In the Exhibit Reference section, list the attached billing records by Bates range or filename and the total billed amount.
8. Insert a placeholder notary block.
9. Flag for me: (a) any charges that look like they may not be reasonable & necessary on their face; (b) the 30-day controverting deadline opposing counsel will have once served.
10. When I confirm the draft, call export_to_docx and share the link.

Cite every billed amount back to its source page. Do not invent CPT codes, billed amounts, or service dates.`,
  },
  {
    id: 'pi-damages-summary',
    title: 'Damages summary (paid-or-incurred, TX)',
    description:
      'Texas-correct damages summary: paid medicals, incurred-but-unpaid medicals, future medicals, lost wages, and non-economic estimate. Always shows work.',
    practiceAreas: ['personal-injury', 'pre-litigation', 'litigation'],
    prompt: `I want a damages summary that follows Texas paid-or-incurred (Haygood) rules.

Run this flow:

1. Call list_documents. Identify medical bills, payment / EOB records, lost-wage docs, and any future-care or life-care planning materials.
2. If anything I'd need is missing, ask me what I want to do — proceed without it, or wait. Don't fabricate around a gap.
3. Call create_document, title "Damages Summary — <client name if I provide one>".
4. Call set_outline with sections: Past Medicals (Paid + Incurred) | Future Medicals | Past Lost Wages | Future Lost Wages | Non-Economic Estimate | Total Range | Inputs and Cites.
5. Past Medicals: per-provider table — Provider | Date Range | Billed | Paid | Incurred-but-Unpaid | Recoverable (Haygood). Recoverable = Paid + still-payable; do NOT include amounts written off. Show the math.
6. Future Medicals: only include amounts supported by a treating physician's recommendation, life-care plan, or expert report — cite. If no expert support exists, write "no future-medicals support in record".
7. Past Lost Wages: actual wages lost to date, supported by employer letter / pay stubs / tax returns. Cite each source.
8. Future Lost Wages / Earning Capacity: only if supported by an economist or vocational expert. Cite.
9. Non-Economic Estimate: a clearly-labeled RANGE (low / mid / high), with the factors driving it (severity, treatment burden, permanency, age, venue). Mark it as a working estimate, not a number to put in a demand without attorney review.
10. Total Range: sum components into a low/high total.
11. Inputs and Cites: list every document used with file name and page references.
12. Pause for edits, then export_to_docx.

Hard rules: never report "billed" as recoverable — Haygood. Never produce a single point estimate for non-economic damages — always a range with inputs visible.`,
  },
  {
    id: 'pi-ch41-cap-analysis',
    title: 'Ch. 41 damages cap analysis (TX)',
    description:
      'Analyze whether Tex. Civ. Prac. & Rem. Code Ch. 41 damages caps apply, which subsections govern, and the resulting cap amount.',
    practiceAreas: ['personal-injury', 'litigation'],
    prompt: `I want a Chapter 41 damages cap analysis for a Texas PI matter.

Run this flow:

1. Ask me for: cause(s) of action pled, defendant type (individual, employer, governmental unit, common carrier), conduct alleged (negligence, gross negligence, intentional, statutory), and current economic damages estimate. If I've uploaded the petition, call list_documents and read it first.
2. Call create_document, title "Ch. 41 Cap Analysis — <matter name if provided>".
3. Call set_outline with: Question Presented | Short Answer | Statutory Framework | Application | Caveats and Open Issues | Recoverable Range.
4. Statutory Framework: walk through Ch. 41 — definitions (§ 41.001), exemplary damages availability and threshold (§ 41.003), the cap formula in § 41.008(b) (greater of $200K, or 2x economic + non-economic up to $750K), and the carve-outs in § 41.008(c) for certain felony-grade conduct. Track statutory language closely.
5. Application: apply each element to the facts. Identify whether exemplary damages are even on the table; if so, calculate the formula amount; if a § 41.008(c) carve-out applies, say so and explain why.
6. Caveats: flag where the answer turns on facts not yet developed (gross negligence by clear and convincing evidence, defendant's mental state, felony-grade carve-out applicability). Use CourtListener tools to find recent Texas case law on disputed points.
7. Recoverable Range: low / high outcome bracketing depending on how open issues resolve.
8. Pause for review, then export_to_docx.

Do not give a confident single number when caps depend on disputed facts. Always show the formula and inputs.`,
  },
  {
    id: 'pi-tpc-stowers-demand',
    title: 'Draft TPC Stowers demand (TX)',
    description:
      'Third-party policy-limits Stowers demand to the tortfeasor\'s carrier. Supports solo or multi-client global; supports aggravators (DWI, etc.).',
    practiceAreas: ['personal-injury', 'pre-litigation'],
    prompt: `I want to draft a third-party Stowers demand letter to the tortfeasor's liability carrier.

Run this flow:

1. Ask me up front:
   a. Solo client or multi-client "global" demand?
   b. Carrier name + adjuster name + adjuster address.
   c. Insured / defendant driver name.
   d. Claim number.
   e. Date of incident.
   f. Are there aggravators that should be highlighted in the facts paragraph (DWI, fleeing the scene, distracted-driving citation, prior bad acts)? If yes, what are they?
   g. Settlement-offer expiration — default 21 days from today, ask if I want different.
2. Call list_documents and identify the records this demand relies on (police/incident report, property damage photos, bodily-injury images, medical records, medical bills). If anything is missing, ask whether to proceed without it.
3. From the bills, total the medical-billing amount; cite the source. Do NOT invent a number.
4. Call create_document with title "Stowers Demand — <client(s)> v. <insured>".
5. Call set_outline with: Letterhead Block | RE Block | Salutation | Demand Statement and Enclosures | Facts (only if aggravators present) | Settlement Offer | Closing.
6. Letterhead Block: insurance name, adjuster name, address, then today's date.
7. RE Block: Our Client(s) | Your Driver / Insured | Claim Number | Date of Incident.
8. Salutation: "Dear Ms./Mr. <adjuster last name>:".
9. Demand Statement and Enclosures: "Please accept the following demand on behalf of our client[s]." Then enumerate the available enclosures from list_documents (police/incident report, property damage photos, bodily injury damages images, medical records, medical bills totaling $<sum> with cite). For multi-client global demands, include a per-client subsection listing each client's records and total.
10. Facts: ONLY if aggravators were given. Short paragraph hitting the aggravators with cites to record sources. Do not editorialize beyond the facts.
11. Settlement Offer paragraph: use this structure verbatim, substituting the bracketed fields —

   "<Client name> has asked me to reach out again to tell <Defendant Name> that <he/she/they> will agree to settle and resolve this case for <Defendant Name>'s policy limits. Specifically, in exchange for payment of the per-person policy limits of the liability insurance <Defendant Name> had in effect at the time of the collision, <Client name> will provide <Defendant Name> (and <Defendant Name>'s agents, representatives and insurance companies) a full, complete, and final release of any and all claims <Client name> may have arising out of the collision, including any and all hospital liens, subrogation interests, or other liens that may exist pursuant to Trinity Universal Insurance Co. v. Bleeker, 966 S.W.2d 489, 491 (Tex. 1998). This settlement offer will be held open until <expiration date> at 5:00 p.m., at which time such offer is automatically withdrawn if not previously accepted."

12. Stowers trigger paragraph (always include):

   "If this offer is not accepted, <Client name> intends to try this case before a jury and receive a verdict in the full amount of <her/his/their> damages. A reasonable insurer would accept this offer."

13. Closing: "Very truly yours, /s/ <attorney>".
14. Pause for my edits.
15. When I confirm, call export_to_docx and share the download link.

Hard rules: never invent client names, billing totals, or facts. The Trinity v. Bleeker citation must be reproduced exactly — it's the firm's chosen authority for lien release. The "reasonable insurer would accept this offer" sentence is the Stowers trigger and must appear verbatim.`,
  },
  {
    id: 'pi-tpc-naked-demand',
    title: 'Draft TPC Naked demand (early/opening, TX)',
    description:
      'Early-stage, more aggressive third-party demand letter sent BEFORE a formal Stowers demand. Implicit policy-limits ask, no Stowers framework yet.',
    practiceAreas: ['personal-injury', 'pre-litigation'],
    prompt: `I want to draft an early-stage "naked" demand letter to a tortfeasor's carrier — before any formal Stowers letter goes out.

This letter is the opening salvo: aggressive tone, implicit policy-limits ask, framing that prepares the file for a formal Stowers demand later if the carrier doesn't move.

Run this flow:

1. Ask me up front:
   a. Carrier name + adjuster name + address.
   b. Insured name.
   c. Claim number.
   d. Date of incident.
   e. Settlement-offer expiration — default 21 days from today.
2. Call list_documents to confirm which exhibits are attached. Expected: police/incident report, injury photos, property damage photos, available records and bills.
3. Call create_document, title "Early Demand — <client> v. <insured>".
4. Call set_outline with: Letterhead Block | RE Block | Salutation | Demand Statement and Enclosures | Severity Statement | Settlement Offer | Closing Pressure | Sign-off.
5. Letterhead + RE + Salutation: same conventions as the Stowers demand, but the recipient line can be "Dear Sir or Madam:" if the adjuster's last name isn't known.
6. Demand Statement: "This correspondence serves as a formal demand for full and immediate resolution of our client's claims against your insured." Then enumerate the enclosures.
7. Severity Statement: one paragraph asserting that the client sustained severe, life-altering injuries directly caused by the insured, that liability is clear, and that damages exceed available policy limits. Tie each factual claim to a record cite — do not embellish beyond what the records support.
8. Settlement Offer: implicit policy-limits demand — payment of all available and applicable policy limits in exchange for full release of the insured (including liens, subrogation). Include the open-until expiration.
9. Closing Pressure: short paragraph emphasizing that delay or trivialization will not be tolerated, the client will pursue a jury verdict for the full scope of damages, and continued non-resolution exposes both the insured and the carrier to financial and reputational consequences.
10. Sign-off: "Very truly yours, /s/ <attorney>".
11. Pause for my edits, then export_to_docx.

Tone: firm, factual, unhurried. Aggressive but never bluster. No Stowers framework yet (no "reasonable insurer" language, no Bleeker cite) — that's reserved for the formal Stowers demand later. This letter creates the file's tone and timeline; the formal Stowers letter does the bad-faith setup.`,
  },
  {
    id: 'pi-tpc-regular-demand',
    title: 'Draft TPC Regular demand — no Stowers (TX)',
    description:
      'Standard third-party demand to the tortfeasor\'s carrier, without Stowers framework. For matters where Stowers leverage is not appropriate or not yet ready.',
    practiceAreas: ['personal-injury', 'pre-litigation'],
    prompt: `I want to draft a standard third-party demand letter without the Stowers framework — a straightforward willingness-to-settle letter for cases where Stowers leverage is not appropriate or not yet ripe.

Run this flow:

1. Ask me: carrier + adjuster name/address; insured name; claim number; date of incident; offer expiration date (default 21 days out).
2. Call list_documents and identify the exhibits.
3. Total the medical billing from the bills with cite. Do not invent a number.
4. Call create_document, title "Demand — <client> v. <insured>".
5. Call set_outline with: Letterhead Block | RE Block | Salutation | Demand Statement and Enclosures | Settlement Offer | Closing.
6. Letterhead, RE, salutation: standard format.
7. Demand Statement and Enclosures: "Please accept the following demand on behalf of our client." Enumerate enclosures: police/incident report, property damage photos, bodily injury damages, related medical records, related medical bills totaling $<sum>.
8. Settlement Offer paragraph (use this structure verbatim, substituting bracketed fields):

   "<Client name> is willing to settle <her/his/their> claim against your insured for the applicable policy limits. In exchange for payment of this amount, your insured will be provided with a full and final release of <Client name>'s claim, including any medical liens or subrogation interests. This demand shall remain open until <expiration date> at 5:00 p.m."

9. Closing: "Thank you for your prompt attention to this matter. Sincerely, /s/ <attorney>".
10. Pause for edits, then export_to_docx.

Do NOT include the Trinity v. Bleeker cite or the "reasonable insurer would accept" Stowers trigger language. Those are reserved for Stowers demands. This is a clean, transactional ask without the bad-faith setup.`,
  },
  {
    id: 'pi-um-uim-notice-of-claim',
    title: 'Draft UM/UIM Notice of Claim (TX)',
    description:
      'Notice of claim under Tex. Ins. Code § 542.051(4) to the client\'s OWN carrier on an Uninsured/Underinsured Motorist claim. Exhibit-driven, not a settlement demand.',
    practiceAreas: ['personal-injury', 'pre-litigation'],
    prompt: `I want to draft a UM/UIM notice of claim to the client's own carrier. This is fundamentally different from a third-party demand — we are submitting a claim under our own insured's policy and triggering the Texas Insurance Code prompt-payment statute.

Run this flow:

1. Ask me: carrier + UM/UIM BI adjuster name/address; client (who is also the insured); claim number; date of accident.
2. Call list_documents to identify exhibits — police report, medical records, medical bills, lost wage statement.
3. Call create_document, title "UM/UIM Notice of Claim — <client>".
4. Call set_outline with: Letterhead Block | RE Block | Salutation | Notice and Exhibits | Request for Evaluation | Sign-off.
5. Letterhead Block: UM/UIM BI adjuster name, insurance name, insurance address, then today's date.
6. RE Block: Our Client (also their insured), Claim Number, Date of Accident.
7. Salutation: "Dear Ms./Mr. <adjuster last name>:".
8. Notice and Exhibits paragraph (use this structure verbatim):

   "This firm is hereby submitting an Uninsured/Underinsured motorist claim on behalf of our client/your insured. Please consider this letter as our client's 'notice of claim' within the meaning of Texas Insurance Code Section 542.051(4). Enclosed please find the following:"

   Then list as exhibits:
     - Exhibit A — the police report related to the subject collision;
     - Exhibit B — our client's / your insured's medical records related to treatment for injuries suffered in the subject collision;
     - Exhibit C — our client's / your insured's medical bills related to treatment referenced above; and
     - Exhibit D — a lost wage statement (only if a lost-wage doc is attached; otherwise omit).

9. Request for Evaluation: "Please review the enclosed materials and advise us of your evaluation as soon as possible. Thank you for your attention to this matter."
10. Sign-off: "Sincerely, <attorney>".
11. Pause for edits, then export_to_docx.

Hard rules: this is NOT a Stowers demand. Do not include the "reasonable insurer" language or the Bleeker cite. The § 542.051(4) reference must appear verbatim — it is what triggers the prompt-payment statute's deadlines. Only include exhibits that are actually attached; do not list a lost-wage statement as Exhibit D if the document isn't there.`,
  },

];

export function promptsByPracticeArea(promptsList: PromptTemplate[], areaId: string | null): PromptTemplate[] {
  if (!areaId) return promptsList;
  return promptsList.filter((p) => p.practiceAreas.includes(areaId));
}
