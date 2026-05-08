/**
 * Background chat-title generation. Called after the first user+assistant
 * turn finishes and the chat is still on its placeholder name. The
 * trim-of-first-message fallback already runs synchronously inside
 * /api/chat — this function fires-and-forgets a tiny LLM call to
 * upgrade that to a 4–6 word, sentence-case label.
 *
 * Keep the call small (cheap model + low max_tokens), short timeout,
 * and never throw to the caller — title polish is best-effort.
 */

interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DraftChatTitleOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Provider knobs (Qwen's `enable_thinking: false` lives here). */
  extraBody?: Record<string, unknown>;
  /** Default 12s — title drafting should be faster than a real reply. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT = [
  'You name chat threads. Read the first user message and the assistant reply,',
  "then output a 3–6 word title that captures the thread's subject.",
  '',
  'Rules:',
  '  - Sentence case (only proper nouns capitalised). No trailing punctuation.',
  '  - No quotes, no markdown, no emojis.',
  '  - Title only — no preamble, no explanation.',
  '  - Be specific: "NDA confidentiality scope" beats "Document review".',
  '  - 6 words MAX.',
].join('\n');

export async function draftChatTitle(
  firstUserMessage: string,
  firstAssistantReply: string,
  opts: DraftChatTitleOptions,
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const userBlock = [
    `USER: ${truncate(firstUserMessage, 800)}`,
    `ASSISTANT: ${truncate(firstAssistantReply, 800)}`,
  ].join('\n\n');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userBlock },
  ];

  const response = await fetchImpl(
    `${opts.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: 32,
        temperature: 0.3,
        ...(opts.extraBody ?? {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    },
  );
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: string } }> }
    | null;
  const raw = data?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') return null;
  return cleanTitle(raw);
}

function cleanTitle(s: string): string | null {
  let t = s.trim();
  // Strip surrounding quotes / fences the model sometimes adds.
  t = t.replace(/^["'`]+|["'`]+$/g, '');
  t = t.replace(/^```[a-z]*\s*|\s*```$/gi, '');
  // Drop trailing period (titles don't take one).
  t = t.replace(/[.!?]+$/g, '');
  // Collapse whitespace.
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // Cap at 60 chars to mirror the synchronous fallback's bound.
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '') + '…';
  return t;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
