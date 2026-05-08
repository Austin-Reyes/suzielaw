import 'dotenv/config';
import { buildLocalAgentRegistry, LOCAL_MODELS } from '@teamsuzie/agent-loop';
import { buildOAuthProvidersFromEnv, parseTokenLimit } from '@teamsuzie/hosted-demo';

const SKILL_VAR_PREFIX = 'SUZIELAW_SKILL_VAR_';
const DEFAULT_QWEN_MODEL = 'qwen3.6-plus';
const DEFAULT_QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode';

function collectSkillRenderContext(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(SKILL_VAR_PREFIX) || value === undefined) continue;
    out[key.slice(SKILL_VAR_PREFIX.length)] = value;
  }
  return out;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function defaultExtraBody(model: string): Record<string, unknown> | undefined {
  return model.toLowerCase().includes('qwen') ? { enable_thinking: false } : undefined;
}

const DEFAULT_SYSTEM_PROMPT = `You are Counsel, the AI legal assistant in RBL Counsel Assist.

You help lawyers and legal professionals with research, drafting, document review, summarization, and analysis. Be precise, professional, and concise. When citing facts from a document, reference the heading path (e.g. §2.1) so the user can verify.

When asked who you are, what model you are, or who made you: identify as Counsel — the AI legal assistant in RBL Counsel Assist. Do not claim to be ChatGPT, Gemini, Claude, or any other product. The underlying model may vary; the user-facing identity is Counsel.

Use the available tools when relevant — vector_search for the knowledge base, convert_to_markdown to read uploaded binaries, document navigation tools (get_outline, read_section, search_document) for Q&A on a document, drafting tools (create_document, set_outline, write_section, export_to_docx) when the user asks you to write something. For legal research about cases, opinions, citations, judges, dockets, public filings, or recent legal developments, use the CourtListener tools before saying you lack access to legal databases or current information. If a question requires information you don't have after trying the relevant tools, say so rather than guessing.

CourtListener research:
1. For requests to find cases, opinions, holdings, or legal authorities, call courtlistener_search with type "o" unless the user is clearly asking for a docket, filing, oral argument, or judge profile. For statutory or regulatory legal questions, use CourtListener to find cases interpreting or applying the statute, regulation, agency action, or doctrine. Use court filters and date ranges when the user gives them (for example, "Ninth Circuit" => court "ca9"; "from 2023" => date_filed_after "2023-01-01" and date_filed_before "2023-12-31").
2. For requests to look up citations, call courtlistener_lookup_citation, then fetch the cluster or opinion if the user needs analysis.
3. Return case names, court/date, short relevance notes, and CourtListener URLs. Do not direct the user to Westlaw, Lexis, PACER, or generic web search unless CourtListener cannot answer the request.

When a user asks you to draft a document of any kind (memo, agreement, letter, press release, opinion, alert, etc.), always produce it via the drafting tools and finish by calling export_to_docx — DOCX is the default deliverable for legal work. Within a single drafting request, use one document per draft: call create_document once, then build it up with set_outline / write_section / append_section. Do not create a second document mid-flow unless the user explicitly asks for one.

Drafting flow:
1. Pick a layout via the templates catalog (list_templates → get_template with the matching id: agreement, memorandum, legal-opinion, brief, board-minutes, engagement-letter, demand-letter, client-alert, resolution). Build the outline from the template's top-level (##) headings only and call set_outline once — don't reset it mid-draft. Pre-numbered preamble (date, addressee block, salutation, opening paragraph) and any ### sub-headings live inside their parent section as inline markdown, written via write_section; they aren't separate outline entries. If the template has front matter that precedes the first ## heading, put it in the first section.
2. Only when drafting an agreement / contract: also call courtlistener_find_contract_precedent to surface real-world language from filed exhibits in RECAP. Do NOT use this tool for memoranda, briefs, opinion letters, board minutes, demand letters, engagement letters, alerts, or resolutions — RECAP precedents are filed *contracts*, and the tool will return irrelevant results for non-contract drafting.
3. For case-law citations *inside* any document (memorandum authorities, brief argument, opinion-letter assumptions, demand-letter legal basis): courtlistener_search / courtlistener_lookup_citation / courtlistener_get_opinion / courtlistener_get_cluster are appropriate regardless of document type.
4. Fill each section with write_section, then export_to_docx.

After export_to_docx returns, share the download link with the user in your reply as a markdown link: \`[Download <filename>](<download_url>)\`. Don't bury it — make the link visible in the chat so the user can click through immediately, even though the same document is also visible in the artifact panel.`;

export const config = {
  port: parseInt(process.env.SUZIELAW_PORT || '17501', 10),
  publicUrl: (process.env.SUZIELAW_PUBLIC_URL || 'http://localhost:17501').replace(/\/$/, ''),
  allowedOrigin: process.env.SUZIELAW_ALLOWED_ORIGIN || 'http://localhost:17502',
  title: process.env.SUZIELAW_TITLE || 'RBL Counsel Assist',
  agent: {
    name: process.env.SUZIELAW_AGENT_NAME || 'Counsel',
    description: process.env.SUZIELAW_AGENT_DESCRIPTION || 'Open-source legal assistant',
    baseUrl: (process.env.SUZIELAW_AGENT_BASE_URL || DEFAULT_QWEN_BASE_URL).replace(/\/$/, ''),
    apiKey: process.env.SUZIELAW_AGENT_API_KEY || undefined,
    model: process.env.SUZIELAW_MODEL || DEFAULT_QWEN_MODEL,
    /**
     * Cheaper / faster model for narrow tasks (review cell runs, future
     * auto-titling, etc.). Falls back to the primary `model` when unset
     * so existing setups keep working without configuration.
     */
    simpleModel:
      process.env.SUZIELAW_MODEL_SIMPLE ||
      process.env.SUZIELAW_MODEL ||
      DEFAULT_QWEN_MODEL,
    /** JSON object merged into every chat request body (e.g. {"enable_thinking":false} for Qwen). */
    extraBody: parseJsonObject(process.env.SUZIELAW_AGENT_EXTRA_BODY) || defaultExtraBody(process.env.SUZIELAW_MODEL || DEFAULT_QWEN_MODEL),
    /** Counsel identity / behavior. Override SUZIELAW_SYSTEM_PROMPT in env for short overrides; edit config.ts for longer. */
    systemPrompt: process.env.SUZIELAW_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
  },
  vectorDb: {
    baseUrl: (process.env.SUZIELAW_VECTOR_DB_BASE_URL || 'http://localhost:3006').replace(/\/$/, ''),
    apiKey: process.env.SUZIELAW_VECTOR_DB_API_KEY || undefined,
  },
  tools: {
    maxIterations: parseInt(process.env.SUZIELAW_TOOL_MAX_ITERATIONS || '100', 10),
    /** Hosts the http_request tool may call. Auto-extended with any URL hosts found in skill render-context. */
    allowedHttpHosts: parseList(process.env.SUZIELAW_HTTP_ALLOWED_HOSTS),
  },
  skills: {
    skillsDir: process.env.SUZIELAW_SKILLS_DIR || './skills',
    catalogUrl: process.env.SUZIELAW_SKILL_CATALOG_URL || undefined,
    catalogToken: process.env.SUZIELAW_SKILL_CATALOG_TOKEN || undefined,
    /** Subset of skill names to install. Empty = install all discovered. */
    allow: parseList(process.env.SUZIELAW_SKILLS_ALLOW),
    /** {{TOKEN}} substitutions for skill markdown. Set via SUZIELAW_SKILL_VAR_<NAME>=<value>. */
    renderContext: collectSkillRenderContext(),
  },
  mcp: {
    /** Path to a JSON config file using the Claude Desktop `mcpServers` shape. */
    configPath: process.env.SUZIELAW_MCP_CONFIG || undefined,
  },
  /**
   * Per-model agent overrides — used by `resolveAgentTarget` to route the
   * chat call to a different base URL when the user picks a Local model.
   * Built from `${SUZIELAW_LOCAL_<NAME>_BASE_URL,_API_KEY}` env vars per
   * the upstream `LOCAL_MODELS` list.
   */
  modelAgents: buildLocalAgentRegistry(LOCAL_MODELS, process.env, 'SUZIELAW'),
  personas: {
    /** Directory of `<id>/PERSONA.md` files for builtin personas. Empty/unset
     *  means no builtins are loaded — user-created personas still work. */
    dir: process.env.SUZIELAW_PERSONAS_DIR || undefined,
  },
  /**
   * Knowledge Base (RAG) — embeddings + sqlite-vec storage. Disabled when
   * SUZIELAW_KB_ENABLED is unset/false. The embedding endpoint must be
   * OpenAI-compatible at `${baseUrl}/v1/embeddings`. Defaults reuse the chat
   * agent's base URL + API key — most providers expose embeddings on the
   * same host (OpenAI, Dashscope, Together).
   */
  kb: {
    enabled: ['1', 'true', 'yes'].includes((process.env.SUZIELAW_KB_ENABLED || '').toLowerCase()),
    embeddingBaseUrl: (process.env.SUZIELAW_KB_EMBEDDING_BASE_URL || process.env.SUZIELAW_AGENT_BASE_URL || 'http://localhost:4000').replace(/\/$/, ''),
    embeddingApiKey: process.env.SUZIELAW_KB_EMBEDDING_API_KEY || process.env.SUZIELAW_AGENT_API_KEY || undefined,
    embeddingModel: process.env.SUZIELAW_KB_EMBEDDING_MODEL || 'text-embedding-3-small',
    embeddingDim: parseInt(process.env.SUZIELAW_KB_EMBEDDING_DIM || '1536', 10),
  },
  session: {
    cookieName: process.env.SUZIELAW_COOKIE_NAME || 'suzielaw.sid',
    /** Sign cookies. Use a long, random value in production. */
    cookieSecret: process.env.SUZIELAW_SESSION_SECRET || 'dev-only-suzielaw-secret',
  },
  oauth: {
    providers: buildOAuthProvidersFromEnv({
      env: process.env,
      publicUrl: (process.env.SUZIELAW_PUBLIC_URL || 'http://localhost:17501').replace(/\/$/, ''),
      prefix: 'SUZIELAW_',
    }),
  },
  tokenBudget: {
    /** Per-account hosted-model token allowance. 0 disables the cap. */
    defaultLimit: parseTokenLimit(process.env.SUZIELAW_DEMO_TOKEN_LIMIT, 50_000),
    /**
     * Fallback charge when an OpenAI-compatible provider omits usage data.
     * Qwen/Dashscope should return usage when stream_options.include_usage=true.
     */
    fallbackTokensPerCall: parseTokenLimit(process.env.SUZIELAW_TOKEN_FALLBACK_PER_CALL, 0),
  },
  /**
   * Demo credentials. The stub auth backend accepts these and only these. Real
   * multi-user / multi-tenant auth means swapping in `@teamsuzie/shared-auth`
   * (Postgres + Redis); this is only here so the login UI is functional out of
   * the box.
   */
  demo: {
    email: process.env.SUZIELAW_DEMO_EMAIL || 'demo@example.com',
    password: process.env.SUZIELAW_DEMO_PASSWORD || 'demo',
    name: process.env.SUZIELAW_DEMO_NAME || 'Demo Lawyer',
    role: process.env.SUZIELAW_DEMO_ROLE || 'attorney',
  },
  db: {
    /** SQLite db path, relative to the cwd the server starts from. */
    path: process.env.SUZIELAW_DB_PATH || './data/suzielaw.db',
  },
  files: {
    /** Per-file size cap on uploads. Default 25MB. */
    maxUploadBytes: parseInt(process.env.SUZIELAW_MAX_UPLOAD_BYTES || `${25 * 1024 * 1024}`, 10),
  },
  markitdown: {
    /** markitdown-agent base URL. When set, the agent gets convert_to_markdown + export_to_docx. */
    baseUrl: (process.env.SUZIELAW_MARKITDOWN_AGENT_BASE_URL || '').replace(/\/$/, ''),
  },
  courtlistener: {
    /** Personal API token from https://www.courtlistener.com/profile/api/. Optional — without it, calls hit the lower unauth rate limit. */
    token: process.env.SUZIELAW_COURTLISTENER_TOKEN || undefined,
    /** Override the v4 REST base URL. Almost never needed. */
    baseUrl: (process.env.SUZIELAW_COURTLISTENER_BASE_URL || '').replace(/\/$/, '') || undefined,
  },
  templates: {
    /** Directory of `<id>.md` legal document templates with frontmatter. Empty/unset disables the list_templates / get_template tools. */
    dir: process.env.SUZIELAW_TEMPLATES_DIR || './templates',
  },
};
