import type { AnyToolDefinition } from '@teamsuzie/agent-loop';

const DEFAULT_BASE_URL = 'https://www.courtlistener.com/api/rest/v4';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 12_000;

interface BuildOptions {
  /** CourtListener API token. Optional — public endpoints work unauthenticated, but auth gives much higher rate limits. */
  token?: string;
  /** Override for the API base URL. Defaults to https://www.courtlistener.com/api/rest/v4. */
  baseUrl?: string;
}

type SearchType = 'o' | 'r' | 'rd' | 'oa' | 'p';

interface SearchArgs {
  query: string;
  type?: SearchType;
  court?: string;
  citation?: string;
  judge?: string;
  date_filed_after?: string;
  date_filed_before?: string;
  order_by?: string;
  page_size?: number;
}

interface OpinionArgs {
  id: number;
  truncate_text?: boolean;
}

interface ClusterArgs {
  id: number;
}

interface DocketArgs {
  id: number;
}

interface CitationLookupArgs {
  text?: string;
  volume?: string;
  reporter?: string;
  page?: string;
}

interface PersonArgs {
  id: number;
}

interface ListCourtsArgs {
  jurisdiction?: string;
  in_use?: boolean;
  full_name_contains?: string;
  page_size?: number;
}

interface ListDocketEntriesArgs {
  docket_id: number;
  order_by?: string;
  page_size?: number;
}

interface RecapDocumentArgs {
  id: number;
  truncate_text?: boolean;
}

interface ListFinancialDisclosuresArgs {
  person_id: number;
  page_size?: number;
}

interface ListDisclosureAgreementsArgs {
  person_id?: number;
  financial_disclosure_id?: number;
  page_size?: number;
}

interface OpinionsCitedArgs {
  citing_opinion_id?: number;
  cited_opinion_id?: number;
  page_size?: number;
}

interface FindContractPrecedentArgs {
  contract_type: string;
  specs?: string;
  court?: string;
  date_filed_after?: string;
  date_filed_before?: string;
  n_results?: number;
  include_text?: boolean;
}

function truncate(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= MAX_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_TEXT_CHARS)}\n\n[...truncated; original length ${value.length} chars]`;
}

interface ListResponse {
  count?: unknown;
  next?: unknown;
  previous?: unknown;
}

/**
 * v4 cursor-paginated endpoints return `count` as a URL (you have to follow it
 * to get the integer); search returns it inline as a number. Normalize both
 * shapes to `{ total: number | null, has_more: boolean }` so the model gets
 * something useful regardless of endpoint.
 */
function paginationFields(data: ListResponse): { total: number | null; has_more: boolean } {
  const total = typeof data.count === 'number' ? data.count : null;
  return { total, has_more: typeof data.next === 'string' && data.next.length > 0 };
}

/**
 * Build CourtListener REST API tools. Wraps the v4 endpoints that matter most
 * for legal research: search (case law / RECAP / oral args / judges), opinion
 * full text, cluster (case) metadata, docket details, and citation lookup.
 *
 * Token auth uses CourtListener's `Authorization: Token <token>` header (not
 * Bearer). Without a token, calls fall back to the public unauthenticated
 * tier — fine for light use, rate-limited for anything heavier.
 *
 * Docs: https://www.courtlistener.com/help/api/rest/
 */
export function buildCourtListenerTools(opts: BuildOptions = {}): AnyToolDefinition[] {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const token = opts.token?.trim();

  const authHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Token ${token}`;
    return headers;
  };

  async function getJson(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`CourtListener ${response.status}: ${text.slice(0, 300)}`);
    }
    return response.json();
  }

  async function postJson(url: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`CourtListener ${response.status}: ${text.slice(0, 300)}`);
    }
    return response.json();
  }

  // Trim search-result objects to the fields a legal researcher actually needs,
  // so the model doesn't drown in CourtListener's wide payloads.
  function trimSearchResult(item: Record<string, unknown>, type: SearchType): Record<string, unknown> {
    const url = item.absolute_url as string | undefined;
    const fullUrl = url ? `https://www.courtlistener.com${url}` : undefined;
    if (type === 'p') {
      return {
        id: item.id,
        name: item.name_full,
        positions: item.positions,
        date_dob: item.date_dob,
        absolute_url: fullUrl,
      };
    }
    if (type === 'r' || type === 'rd') {
      return {
        id: item.id,
        docket_id: item.docket_id,
        case_name: item.caseName,
        court: item.court,
        court_id: item.court_id,
        docket_number: item.docketNumber,
        date_filed: item.dateFiled,
        description: item.description,
        document_number: item.document_number,
        snippet: truncate(item.snippet),
        absolute_url: fullUrl,
      };
    }
    if (type === 'oa') {
      return {
        id: item.id,
        case_name: item.caseName,
        court: item.court,
        date_argued: item.dateArgued,
        duration: item.duration,
        download_url: item.download_url,
        absolute_url: fullUrl,
      };
    }
    // Opinions (default).
    return {
      cluster_id: item.cluster_id,
      opinion_id: item.id,
      case_name: item.caseName,
      court: item.court,
      court_id: item.court_id,
      citation: item.citation,
      date_filed: item.dateFiled,
      judge: item.judge,
      status: item.status,
      snippet: truncate(item.snippet),
      absolute_url: fullUrl,
    };
  }

  const searchTool: AnyToolDefinition = {
    name: 'courtlistener_search',
    description:
      'Search CourtListener for case law, RECAP federal filings, oral arguments, or judges. Use this for public legal-research requests instead of saying you cannot access legal databases or recent cases. Use type "o" for opinions (case law), "r" for RECAP dockets, "rd" for RECAP documents, "oa" for oral arguments, "p" for people (judges). For prompts like "Find Ninth Circuit cases on qualified immunity from 2023", call this with type "o", court "ca9", date_filed_after "2023-01-01", date_filed_before "2023-12-31", and a focused query such as "qualified immunity". Returns trimmed result fields plus an `absolute_url` for each hit. Pass cluster_id / opinion_id / docket_id from results into the more specific fetch tools to read full content.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text query. Supports CourtListener query syntax (e.g. exact phrases in quotes, AND/OR/NOT).',
        },
        type: {
          type: 'string',
          enum: ['o', 'r', 'rd', 'oa', 'p'],
          description: 'Search type. Defaults to "o" (opinions / case law).',
        },
        court: {
          type: 'string',
          description: 'Court id filter (e.g. "scotus", "ca9", "nysd"). See https://www.courtlistener.com/help/api/jurisdictions/ for the full list.',
        },
        citation: {
          type: 'string',
          description: 'Citation filter, e.g. "576 U.S. 644".',
        },
        judge: {
          type: 'string',
          description: 'Judge name filter (case law / oral args).',
        },
        date_filed_after: {
          type: 'string',
          description: 'YYYY-MM-DD lower bound on filing date.',
        },
        date_filed_before: {
          type: 'string',
          description: 'YYYY-MM-DD upper bound on filing date.',
        },
        order_by: {
          type: 'string',
          description: 'Sort order, e.g. "score desc" (default), "dateFiled desc", "dateFiled asc".',
        },
        page_size: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max results to return (default 10).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args: SearchArgs) {
      const type: SearchType = args.type ?? 'o';
      const params = new URLSearchParams({ q: args.query, type });
      if (args.court) params.set('court', args.court);
      if (args.citation) params.set('citation', args.citation);
      if (args.judge) params.set('judge', args.judge);
      if (args.date_filed_after) params.set('filed_after', args.date_filed_after);
      if (args.date_filed_before) params.set('filed_before', args.date_filed_before);
      if (args.order_by) params.set('order_by', args.order_by);
      params.set('page_size', String(args.page_size ?? 10));

      const data = (await getJson(`${baseUrl}/search/?${params.toString()}`)) as {
        count?: number;
        results?: Record<string, unknown>[];
      };

      return {
        type,
        ...paginationFields(data),
        results: (data.results ?? []).map((r) => trimSearchResult(r, type)),
      };
    },
  };

  const getOpinionTool: AnyToolDefinition = {
    name: 'courtlistener_get_opinion',
    description:
      'Fetch the full text of a single CourtListener opinion by opinion id (the `opinion_id` field on a search result). Returns the available text formats; `plain_text` is preferred for analysis. Long opinions are truncated to ~12k chars unless `truncate_text` is set false.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'CourtListener opinion id.' },
        truncate_text: {
          type: 'boolean',
          description: 'Truncate plain_text/html bodies to ~12k chars (default true). Set false at your own risk for very long opinions.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args: OpinionArgs) {
      const data = (await getJson(`${baseUrl}/opinions/${args.id}/`)) as Record<string, unknown>;
      const shouldTruncate = args.truncate_text !== false;
      return {
        id: data.id,
        cluster: data.cluster,
        author: data.author,
        type: data.type,
        per_curiam: data.per_curiam,
        page_count: data.page_count,
        download_url: data.download_url,
        plain_text: shouldTruncate ? truncate(data.plain_text) : data.plain_text,
        html: shouldTruncate ? truncate(data.html) : data.html,
        html_with_citations: shouldTruncate
          ? truncate(data.html_with_citations)
          : data.html_with_citations,
        absolute_url: data.absolute_url
          ? `https://www.courtlistener.com${data.absolute_url}`
          : undefined,
      };
    },
  };

  const getClusterTool: AnyToolDefinition = {
    name: 'courtlistener_get_cluster',
    description:
      'Fetch a CourtListener opinion cluster (the case-level wrapper around one or more opinions) by cluster id. Returns case name, citations, court, judges, headnotes, and a list of opinion ids you can pass to `courtlistener_get_opinion`.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'CourtListener cluster id (a.k.a. cluster_id on search results).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args: ClusterArgs) {
      const data = (await getJson(`${baseUrl}/clusters/${args.id}/`)) as Record<string, unknown>;
      return {
        id: data.id,
        case_name: data.case_name,
        case_name_full: data.case_name_full,
        case_name_short: data.case_name_short,
        court: data.docket && (data.docket as Record<string, unknown>).court,
        date_filed: data.date_filed,
        citations: data.citations,
        federal_cite_one: data.federal_cite_one,
        state_cite_one: data.state_cite_one,
        judges: data.judges,
        nature_of_suit: data.nature_of_suit,
        precedential_status: data.precedential_status,
        syllabus: truncate(data.syllabus),
        headnotes: truncate(data.headnotes),
        sub_opinions: data.sub_opinions,
        docket: data.docket,
        absolute_url: data.absolute_url
          ? `https://www.courtlistener.com${data.absolute_url}`
          : undefined,
      };
    },
  };

  const getDocketTool: AnyToolDefinition = {
    name: 'courtlistener_get_docket',
    description:
      'Fetch a RECAP/PACER docket by docket id. Returns parties, court, filing date, nature of suit, cause, and links to docket entries. Use this after a `type:"r"` search to drill into a federal case.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'CourtListener docket id.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args: DocketArgs) {
      const data = (await getJson(`${baseUrl}/dockets/${args.id}/`)) as Record<string, unknown>;
      return {
        id: data.id,
        case_name: data.case_name,
        case_name_full: data.case_name_full,
        court: data.court,
        court_id: data.court_id,
        docket_number: data.docket_number,
        date_filed: data.date_filed,
        date_terminated: data.date_terminated,
        nature_of_suit: data.nature_of_suit,
        cause: data.cause,
        jury_demand: data.jury_demand,
        jurisdiction_type: data.jurisdiction_type,
        assigned_to: data.assigned_to,
        referred_to: data.referred_to,
        parties: data.parties,
        docket_entries: data.docket_entries,
        absolute_url: data.absolute_url
          ? `https://www.courtlistener.com${data.absolute_url}`
          : undefined,
      };
    },
  };

  const lookupCitationTool: AnyToolDefinition = {
    name: 'courtlistener_lookup_citation',
    description:
      'Verify and resolve legal citations against CourtListener. Pass either a `text` blob containing one or more citations (the API extracts them) or the structured `volume`/`reporter`/`page` triple. Returns each citation\'s normalized form, status (parsed/found/unknown reporter), and matching cluster ids you can fetch with `courtlistener_get_cluster`.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text containing one or more citations to extract and verify (e.g., a paragraph of a brief). Either `text` or `volume`+`reporter`+`page` is required.',
        },
        volume: { type: 'string', description: 'Reporter volume, e.g. "576".' },
        reporter: { type: 'string', description: 'Reporter abbreviation, e.g. "U.S." or "F.3d".' },
        page: { type: 'string', description: 'Starting page, e.g. "644".' },
      },
      additionalProperties: false,
    },
    async execute(args: CitationLookupArgs) {
      if (!args.text && !(args.volume && args.reporter && args.page)) {
        throw new Error('lookup_citation requires either `text`, or all of `volume`, `reporter`, and `page`.');
      }
      const body: Record<string, unknown> = {};
      if (args.text) body.text = args.text;
      if (args.volume) body.volume = args.volume;
      if (args.reporter) body.reporter = args.reporter;
      if (args.page) body.page = args.page;

      const data = (await postJson(`${baseUrl}/citation-lookup/`, body)) as unknown;
      return { results: data };
    },
  };

  const getPersonTool: AnyToolDefinition = {
    name: 'courtlistener_get_person',
    description:
      'Fetch a full CourtListener person (judge) record by id. Returns biographical fields, education, ABA ratings, and a list of `positions` (court, role, date appointed, date terminated). Use this after `courtlistener_search` with type "p" to drill into a candidate match.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'CourtListener person id.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args: PersonArgs) {
      const data = (await getJson(`${baseUrl}/people/${args.id}/`)) as Record<string, unknown>;
      return {
        id: data.id,
        name_full: data.name_full,
        name_first: data.name_first,
        name_middle: data.name_middle,
        name_last: data.name_last,
        name_suffix: data.name_suffix,
        date_dob: data.date_dob,
        date_dod: data.date_dod,
        gender: data.gender,
        religion: data.religion,
        political_affiliations: data.political_affiliations,
        aba_ratings: data.aba_ratings,
        educations: data.educations,
        positions: data.positions,
        sources: data.sources,
        absolute_url: data.absolute_url
          ? `https://www.courtlistener.com${data.absolute_url}`
          : undefined,
      };
    },
  };

  const listCourtsTool: AnyToolDefinition = {
    name: 'courtlistener_list_courts',
    description:
      'List CourtListener courts. Useful for resolving the right `court` id (e.g. "ca9", "scotus", "nysd") before passing it to `courtlistener_search`. Filter by jurisdiction (F = federal appellate, FB = federal bankruptcy, FD = federal district, FS = federal special, S = state, etc.) or by partial name.',
    parameters: {
      type: 'object',
      properties: {
        jurisdiction: {
          type: 'string',
          description: 'Jurisdiction code: F, FB, FD, FS, S, ST (state trial), C (committee), I (international), etc.',
        },
        in_use: {
          type: 'boolean',
          description: 'If true, only return courts CourtListener is actively ingesting. Recommended.',
        },
        full_name_contains: {
          type: 'string',
          description: 'Substring filter on the court\'s full name.',
        },
        page_size: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Default 50.',
        },
      },
      additionalProperties: false,
    },
    async execute(args: ListCourtsArgs) {
      const params = new URLSearchParams();
      if (args.jurisdiction) params.set('jurisdiction', args.jurisdiction);
      if (args.in_use !== undefined) params.set('in_use', String(args.in_use));
      if (args.full_name_contains) params.set('full_name__icontains', args.full_name_contains);
      params.set('page_size', String(args.page_size ?? 50));

      const data = (await getJson(`${baseUrl}/courts/?${params.toString()}`)) as {
        count?: number;
        results?: Record<string, unknown>[];
      };
      return {
        ...paginationFields(data),
        results: (data.results ?? []).map((c) => ({
          id: c.id,
          full_name: c.full_name,
          short_name: c.short_name,
          jurisdiction: c.jurisdiction,
          citation_string: c.citation_string,
          start_date: c.start_date,
          end_date: c.end_date,
          in_use: c.in_use,
          url: c.url,
        })),
      };
    },
  };

  const listDocketEntriesTool: AnyToolDefinition = {
    name: 'courtlistener_list_docket_entries',
    description:
      'List entries on a single docket (the timeline of filings) with optional ordering. The embedded list on `courtlistener_get_docket` is a partial preview; use this for the full timeline. Each entry has a `recap_documents` array — pass a doc id into `courtlistener_get_recap_document` to read its text. Note: this endpoint requires a CourtListener API token; without one the call returns 401. Fall back to `courtlistener_search` with type "rd" and `docket_id` filter when unauthenticated.',
    parameters: {
      type: 'object',
      properties: {
        docket_id: { type: 'integer', description: 'CourtListener docket id.' },
        order_by: {
          type: 'string',
          description: 'Sort, e.g. "date_filed desc" (default), "entry_number asc".',
        },
        page_size: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 25.' },
      },
      required: ['docket_id'],
      additionalProperties: false,
    },
    async execute(args: ListDocketEntriesArgs) {
      const params = new URLSearchParams({ docket: String(args.docket_id) });
      if (args.order_by) params.set('order_by', args.order_by);
      params.set('page_size', String(args.page_size ?? 25));

      const data = (await getJson(`${baseUrl}/docket-entries/?${params.toString()}`)) as {
        count?: number;
        results?: Record<string, unknown>[];
      };
      return {
        ...paginationFields(data),
        results: (data.results ?? []).map((e) => ({
          id: e.id,
          docket: e.docket,
          entry_number: e.entry_number,
          date_filed: e.date_filed,
          description: truncate(e.description),
          recap_documents: e.recap_documents,
        })),
      };
    },
  };

  const getRecapDocumentTool: AnyToolDefinition = {
    name: 'courtlistener_get_recap_document',
    description:
      'Fetch a single RECAP document (a specific PDF / OCR\'d filing) by id. Returns the OCR\'d `plain_text` (truncated to ~12k chars by default) plus metadata. Get the id from a search hit (type "rd") or from a docket entry\'s `recap_documents` field. Note: this endpoint requires a CourtListener API token; without one the call returns 401.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'CourtListener recap-document id.' },
        truncate_text: {
          type: 'boolean',
          description: 'Truncate `plain_text` to ~12k chars (default true).',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args: RecapDocumentArgs) {
      const data = (await getJson(`${baseUrl}/recap-documents/${args.id}/`)) as Record<string, unknown>;
      const shouldTruncate = args.truncate_text !== false;
      return {
        id: data.id,
        docket_entry: data.docket_entry,
        document_number: data.document_number,
        attachment_number: data.attachment_number,
        description: data.description,
        document_type: data.document_type,
        page_count: data.page_count,
        file_size: data.file_size,
        is_available: data.is_available,
        sha1: data.sha1,
        ocr_status: data.ocr_status,
        filepath_local: data.filepath_local,
        filepath_ia: data.filepath_ia,
        plain_text: shouldTruncate ? truncate(data.plain_text) : data.plain_text,
        absolute_url: data.absolute_url
          ? `https://www.courtlistener.com${data.absolute_url}`
          : undefined,
      };
    },
  };

  const listFinancialDisclosuresTool: AnyToolDefinition = {
    name: 'courtlistener_list_financial_disclosures',
    description:
      'List a federal judge\'s annual financial disclosures by person id. Each disclosure has its own id; pass that to `courtlistener_list_disclosure_agreements` (or any of the other sub-resources) to drill into specific items.',
    parameters: {
      type: 'object',
      properties: {
        person_id: { type: 'integer', description: 'CourtListener person id (the judge).' },
        page_size: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 25.' },
      },
      required: ['person_id'],
      additionalProperties: false,
    },
    async execute(args: ListFinancialDisclosuresArgs) {
      const params = new URLSearchParams({ person: String(args.person_id) });
      params.set('page_size', String(args.page_size ?? 25));

      const data = (await getJson(`${baseUrl}/financial-disclosures/?${params.toString()}`)) as {
        count?: number;
        results?: Record<string, unknown>[];
      };
      return {
        ...paginationFields(data),
        results: (data.results ?? []).map((d) => ({
          id: d.id,
          person: d.person,
          year: d.year,
          download_filepath: d.download_filepath,
          filepath: d.filepath,
          thumbnail: d.thumbnail,
          page_count: d.page_count,
          report_type: d.report_type,
          is_amended: d.is_amended,
          addendum_content_raw: truncate(d.addendum_content_raw),
        })),
      };
    },
  };

  const listDisclosureAgreementsTool: AnyToolDefinition = {
    name: 'courtlistener_list_disclosure_agreements',
    description:
      'List "agreements" entries from federal financial disclosures — continuing-income arrangements, post-employment terms, deferred compensation, etc. Useful for ethics / recusal research. Filter by either a specific disclosure id or by person id (returns agreements across all of that judge\'s disclosures).',
    parameters: {
      type: 'object',
      properties: {
        person_id: {
          type: 'integer',
          description: 'CourtListener person id; returns agreements across all of that judge\'s disclosures.',
        },
        financial_disclosure_id: {
          type: 'integer',
          description: 'CourtListener financial-disclosure id; returns agreements only from that filing.',
        },
        page_size: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 50.' },
      },
      additionalProperties: false,
    },
    async execute(args: ListDisclosureAgreementsArgs) {
      if (!args.person_id && !args.financial_disclosure_id) {
        throw new Error('list_disclosure_agreements requires either `person_id` or `financial_disclosure_id`.');
      }
      const params = new URLSearchParams();
      if (args.financial_disclosure_id) {
        params.set('financial_disclosure', String(args.financial_disclosure_id));
      }
      if (args.person_id) {
        params.set('financial_disclosure__person', String(args.person_id));
      }
      params.set('page_size', String(args.page_size ?? 50));

      const data = (await getJson(`${baseUrl}/agreements/?${params.toString()}`)) as {
        count?: number;
        results?: Record<string, unknown>[];
      };
      return {
        ...paginationFields(data),
        results: (data.results ?? []).map((a) => ({
          id: a.id,
          financial_disclosure: a.financial_disclosure,
          date_raw: a.date_raw,
          parties_and_terms: a.parties_and_terms,
          redacted: a.redacted,
        })),
      };
    },
  };

  const opinionsCitedTool: AnyToolDefinition = {
    name: 'courtlistener_opinions_cited',
    description:
      'Walk the citation graph between opinions. Pass `citing_opinion_id` to list opinions cited *by* that opinion (its references). Pass `cited_opinion_id` to list opinions that cite *into* that opinion (i.e. its descendants — useful for impact / Shepardizing). Exactly one of the two is required.',
    parameters: {
      type: 'object',
      properties: {
        citing_opinion_id: {
          type: 'integer',
          description: 'Opinion id whose outgoing citations you want to list.',
        },
        cited_opinion_id: {
          type: 'integer',
          description: 'Opinion id whose incoming citations you want to list (later cases that cite this one).',
        },
        page_size: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 50.' },
      },
      additionalProperties: false,
    },
    async execute(args: OpinionsCitedArgs) {
      if (!args.citing_opinion_id && !args.cited_opinion_id) {
        throw new Error('opinions_cited requires either `citing_opinion_id` or `cited_opinion_id`.');
      }
      if (args.citing_opinion_id && args.cited_opinion_id) {
        throw new Error('Pass only one of `citing_opinion_id` or `cited_opinion_id`, not both.');
      }
      const params = new URLSearchParams();
      if (args.citing_opinion_id) params.set('citing_opinion', String(args.citing_opinion_id));
      if (args.cited_opinion_id) params.set('cited_opinion', String(args.cited_opinion_id));
      params.set('page_size', String(args.page_size ?? 50));

      const data = (await getJson(`${baseUrl}/opinions-cited/?${params.toString()}`)) as {
        count?: number;
        results?: Record<string, unknown>[];
      };
      return {
        ...paginationFields(data),
        results: data.results ?? [],
      };
    },
  };

  const findContractPrecedentTool: AnyToolDefinition = {
    name: 'courtlistener_find_contract_precedent',
    description:
      'Find real-world contract precedents (e.g. software license agreements, NDAs, asset-purchase agreements, employment agreements) filed as exhibits in federal RECAP dockets. Use this ONLY when drafting an agreement / contract — never for memoranda, briefs, opinion letters, board minutes, demand letters, engagement letters, client alerts, or other non-contract documents. RECAP exhibits are filed contracts; there is no "precedent" of this kind for analytical or litigation documents, and the tool will return irrelevant results if used for them. For case-law citations inside any document type, use `courtlistener_search` / `courtlistener_lookup_citation` / `courtlistener_get_opinion` instead. The tool searches RECAP documents, post-filters to attachments whose exhibit label actually names the contract type, and tries to fetch OCR\'d text for each. Each precedent comes back with `text_status` — "fetched" (text present), "unavailable_in_recap" (RECAP has the metadata but no PDF text), or "auth_required" (a CourtListener API token is required to read the body). Without a token you still get docket / document URLs you can open manually.',
    parameters: {
      type: 'object',
      properties: {
        contract_type: {
          type: 'string',
          description:
            'The kind of agreement to find, in the form a court exhibit would label it — "software license agreement", "non-disclosure agreement", "asset purchase agreement", "employment agreement", "lease agreement", etc. Used both as the search query (phrase-matched) and as a post-filter on the exhibit label.',
        },
        specs: {
          type: 'string',
          description:
            'Optional free-text refinement appended to the query — industry, technology, party type, deal size, anything that narrows the precedent. Examples: "SaaS perpetual term-of-art", "biotech licensor", "venture-backed startup". Leave empty for a broad search.',
        },
        court: {
          type: 'string',
          description: 'Optional CourtListener court id to restrict to (e.g. "nysd", "deb" for D. Del. bankruptcy).',
        },
        date_filed_after: {
          type: 'string',
          description: 'YYYY-MM-DD lower bound on the parent filing date. Useful for finding recent drafting conventions.',
        },
        date_filed_before: {
          type: 'string',
          description: 'YYYY-MM-DD upper bound on the parent filing date.',
        },
        n_results: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: 'Number of precedents to return. Default 3.',
        },
        include_text: {
          type: 'boolean',
          description:
            'If true (default), attempt to fetch each precedent\'s OCR\'d plain text. Without a CourtListener API token this fails with `text_status: "auth_required"` — but search results and URLs still come back.',
        },
      },
      required: ['contract_type'],
      additionalProperties: false,
    },
    async execute(args: FindContractPrecedentArgs) {
      const nResults = Math.min(Math.max(args.n_results ?? 3, 1), 10);
      const includeText = args.include_text !== false;
      const contractType = args.contract_type.trim();
      const specs = args.specs?.trim() ?? '';
      const queryUsed = specs ? `"${contractType}" ${specs}` : `"${contractType}"`;

      const params = new URLSearchParams({
        q: queryUsed,
        type: 'rd',
        available_only: 'true',
        page_size: String(Math.min(nResults * 6, 50)),
        order_by: 'score desc',
      });
      if (args.court) params.set('court', args.court);
      if (args.date_filed_after) params.set('filed_after', args.date_filed_after);
      if (args.date_filed_before) params.set('filed_before', args.date_filed_before);

      const search = (await getJson(`${baseUrl}/search/?${params.toString()}`)) as {
        count?: number;
        results?: Record<string, unknown>[];
      };

      const needle = contractType.toLowerCase();
      const candidates = (search.results ?? []).filter((r) => {
        const label = String(r.short_description ?? '').toLowerCase();
        if (!label) return false;
        // Require the exhibit label itself to name the contract — this is what
        // separates "the SLA exhibit" from "a brief that mentions an SLA".
        return label.includes(needle) || needle.split(/\s+/).every((w) => w.length < 3 || label.includes(w));
      });

      // Bias: available_only is already set, but be defensive — sort is_available true first.
      candidates.sort((a, b) => {
        const aa = a.is_available ? 1 : 0;
        const bb = b.is_available ? 1 : 0;
        return bb - aa;
      });

      const top = candidates.slice(0, nResults);

      type Status = 'fetched' | 'unavailable_in_recap' | 'auth_required' | 'fetch_failed' | 'skipped';
      let authBlocked = false;

      const precedents = await Promise.all(
        top.map(async (hit) => {
          const slug = String(hit.absolute_url ?? '');
          const docketUrl = slug
            ? `https://www.courtlistener.com${slug.replace(/\/\d+\/\d+\/?$/, '/')}`
            : null;
          const documentUrl = slug ? `https://www.courtlistener.com${slug}` : null;
          const isAvailable = Boolean(hit.is_available);

          let text: string | null = null;
          let textStatus: Status = 'skipped';

          if (!includeText) {
            textStatus = 'skipped';
          } else if (!isAvailable) {
            textStatus = 'unavailable_in_recap';
          } else if (authBlocked) {
            textStatus = 'auth_required';
          } else {
            try {
              const doc = (await getJson(`${baseUrl}/recap-documents/${hit.id}/`)) as Record<string, unknown>;
              const plain = doc.plain_text;
              if (typeof plain === 'string' && plain.length > 0) {
                text = String(truncate(plain));
                textStatus = 'fetched';
              } else {
                textStatus = 'unavailable_in_recap';
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes('401') || msg.toLowerCase().includes('authentication')) {
                authBlocked = true;
                textStatus = 'auth_required';
              } else {
                textStatus = 'fetch_failed';
              }
            }
          }

          return {
            recap_document_id: hit.id,
            docket_id: hit.docket_id,
            docket_entry_id: hit.docket_entry_id,
            exhibit_label: hit.short_description,
            attachment_number: hit.attachment_number,
            entry_date_filed: hit.entry_date_filed,
            page_count: hit.page_count,
            is_available: isAvailable,
            docket_url: docketUrl,
            document_url: documentUrl,
            text,
            text_status: textStatus,
          };
        }),
      );

      return {
        query_used: queryUsed,
        total_matches: typeof search.count === 'number' ? search.count : null,
        candidates_considered: candidates.length,
        precedents,
      };
    },
  };

  return [
    searchTool,
    getOpinionTool,
    getClusterTool,
    getDocketTool,
    lookupCitationTool,
    getPersonTool,
    listCourtsTool,
    listDocketEntriesTool,
    getRecapDocumentTool,
    listFinancialDisclosuresTool,
    listDisclosureAgreementsTool,
    opinionsCitedTool,
    findContractPrecedentTool,
  ];
}
