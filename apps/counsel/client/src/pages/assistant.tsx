import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArtifactPanel,
  Button,
  CitedMarkdownMessage,
  MarkdownMessage,
  PersonaAvatar,
  PromptCard,
  PromptCardDescription,
  PromptCardTitle,
  ToolUseStatus,
  cn,
  humanSize,
  useAutoResizeTextarea,
  useSelectedModel,
  type ArtifactSnapshot,
  type Persona,
  type ToolEvent,
} from '@teamsuzie/ui';
import { parseResponse, SENTINEL_OPEN, type Citation } from '@teamsuzie/citations';
import type { ChatMessage as PersistedChatMessage } from '@teamsuzie/chats';
import { useDocSidePanel } from '../components/document-side-panel.js';
import { useAssistantChats } from '../hooks/use-assistant-chats.js';
import {
  TrackedChangesPanel,
  type ProposeEditsResult,
} from '../components/tracked-changes-panel.js';

const SELECTED_MODEL_KEY = 'suzielaw:selected-model';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolEvents?: ToolEvent[];
  /** Set on stream `done`: text-with-sentinel-stripped + extracted citations. */
  parsed?: { text: string; citations: Citation[] };
}

/**
 * Hydrate persisted chats messages from the server into the same shape the
 * UI expects. Mirrors the matter-chat hydrator: assistant messages come back
 * with the citation-sentinel block already stripped, so we set `parsed`
 * directly without re-parsing.
 */
function hydratePersisted(messages: PersistedChatMessage[]): Message[] {
  return messages.map((m) => {
    const base: Message = {
      id: m.id,
      role: m.role,
      content: m.content,
    };
    if (m.toolEvents) {
      try {
        base.toolEvents = JSON.parse(m.toolEvents) as ToolEvent[];
      } catch {
        // ignore corrupt toolEvents
      }
    }
    if (m.role === 'assistant') {
      let citations: Citation[] = [];
      if (m.citations) {
        try {
          const parsed = JSON.parse(m.citations) as Citation[];
          if (Array.isArray(parsed)) citations = parsed;
        } catch {
          // ignore
        }
      }
      base.parsed = { text: m.content, citations };
    }
    return base;
  });
}

function pageHintFromLocator(locator: string | undefined): number | undefined {
  if (!locator) return undefined;
  const m = locator.match(/\bp\.?\s*(\d+)\b/i) ?? locator.match(/\bpage\s+(\d+)\b/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

interface AssistantRouteState {
  prefill?: string;
  label?: string;
  workflowId?: string;
  pendingMessage?: string;
  pendingAttachments?: Attachment[];
}


import { Paperclip, Sparkles, Square } from '@teamsuzie/ui';
import { WorkflowPickerDialog } from '../components/workflow-picker-dialog.js';
import {
  ASSISTANT_STARTERS as PROMPTS,
  type StarterPrompt as PromptIdea,
} from '../data/assistant-starters.js';

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}


function TypingDots() {
  return (
    <span
      className="inline-flex items-center gap-1 text-muted-foreground"
      role="status"
      aria-label="Assistant is typing"
    >
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </span>
  );
}


function proposeEditsResults(message: Message): ProposeEditsResult[] {
  if (!message.toolEvents) return [];
  const out: ProposeEditsResult[] = [];
  for (const e of message.toolEvents) {
    if (e.name !== 'propose_document_edits') continue;
    if (e.status !== 'done') continue;
    const result = e.result as ProposeEditsResult | undefined;
    if (result && typeof result === 'object' && 'download_file_id' in result) {
      out.push(result);
    }
  }
  return out;
}

function MessageItem({
  message,
  agentName,
  isActive,
  onJump,
  docLabels,
  chatKey,
}: {
  message: Message;
  agentName: string;
  /** True only for the message currently being streamed. */
  isActive: boolean;
  onJump: (citation: Citation) => void;
  docLabels: Record<string, string>;
  /** Namespace prefix for redline-focus event keys (== assistant sessionId). */
  chatKey: string;
}) {
  const isUser = message.role === 'user';
  const hasToolEvents = !!message.toolEvents && message.toolEvents.length > 0;
  const showTyping =
    !isUser && isActive && message.content.length === 0 && !hasToolEvents;
  const proposeResults = isUser ? [] : proposeEditsResults(message);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-foreground px-4 py-2.5 text-[15px] leading-relaxed text-background">
          <div className="whitespace-pre-wrap">{message.content}</div>
        </div>
      </div>
    );
  }

  // While streaming, hide the citation block as it forms (looks like leaking
  // JSON otherwise). On `done` we set `parsed` and swap to chips.
  const liveText = message.parsed
    ? null
    : message.content.split(SENTINEL_OPEN)[0] ?? '';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium text-muted-foreground">
        {agentName}
      </div>
      {showTyping ? (
        <div className="text-[15px] leading-relaxed">
          <TypingDots />
        </div>
      ) : message.parsed ? (
        <CitedMarkdownMessage
          content={message.parsed.text}
          citations={message.parsed.citations}
          docLabels={docLabels}
          onJump={onJump}
        />
      ) : (
        liveText && liveText.length > 0 && <MarkdownMessage content={liveText} />
      )}
      {/* Live tool-use indicator: appears below the message content while the
          turn is still streaming, disappears once the agent yields 'done'. */}
      {isActive && hasToolEvents && <ToolUseStatus events={message.toolEvents!} />}
      {proposeResults.map((result) => (
        <TrackedChangesPanel
          key={`${message.id}:${result.download_file_id}`}
          result={result}
          chatId={chatKey}
        />
      ))}
    </div>
  );
}

function Greeting({
  name,
  prompts,
  onSelect,
}: {
  name: string;
  prompts: PromptIdea[];
  onSelect: (prompt: string) => void;
}) {
  const salutation = useMemo(() => greetingFor(new Date()), []);
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">
        {salutation}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        How can {name} help today?
      </p>
      <div className="mt-10 grid gap-3 sm:grid-cols-2">
        {prompts.map((card) => (
          <PromptCard key={card.title} onClick={() => onSelect(card.prompt)}>
            <PromptCardTitle>{card.title}</PromptCardTitle>
            <PromptCardDescription>{card.subtitle}</PromptCardDescription>
          </PromptCard>
        ))}
      </div>
    </div>
  );
}

export interface AssistantPageProps {
  agentName: string;
  persona: Persona | null;
  onOpenPicker: () => void;
  /** Lifts persona switching back into App-level state so this page can
   *  restore the chat's saved persona on load, and propagate user-driven
   *  switches both back to the sidebar AND down to the chat row. */
  onSelectPersonaId: (id: string | null) => void;
  /** When set, the page is bound to a persisted top-level Assistant chat. */
  chatId?: string;
}

export function AssistantPage({
  agentName,
  persona,
  onOpenPicker,
  onSelectPersonaId,
  chatId,
}: AssistantPageProps) {
  const displayName = persona?.name ?? agentName;
  // Stable per-render-tab session id used for paperclip uploads. When chatId
  // is present we reuse it as the upload bucket key so paperclips persist
  // alongside the chat, mirroring the matter-chat pattern.
  const [tabSessionId] = useState(() => crypto.randomUUID());
  const sessionId = chatId ?? tabSessionId;
  const assistantChats = useAssistantChats();
  const [historyLoaded, setHistoryLoaded] = useState(!chatId);
  const [chatName, setChatName] = useState<string | null>(null);
  // Tracks the personaId stored on the loaded chat row, so we can detect
  // when the user switches persona mid-chat and propagate that to the row.
  const [chatPersonaId, setChatPersonaId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending'>('idle');
  const [error, setError] = useState('');
  const [prefillLabel, setPrefillLabel] = useState<string | null>(null);
  // Workflow id to send on the next chat turn so the runtime can route
  // by output_mode (e.g. inject the generate_docx tool). One-shot:
  // cleared after the next send.
  const [pendingWorkflowId, setPendingWorkflowId] = useState<string | null>(
    null,
  );
  const [workflowPickerOpen, setWorkflowPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactSnapshot | null>(null);
  /** All attachments uploaded in this session, keyed by file_id. Survives `setAttachments([])` after send so chip-click can still resolve a citation's `doc` handle. */
  const [attachmentsById, setAttachmentsById] = useState<Record<string, Attachment>>({});
  const { openDoc } = useDocSidePanel();
  // Reads the model selection persisted by the Settings page (if any).
  // Server falls back to its configured default when undefined.
  const [selectedModel] = useSelectedModel(SELECTED_MODEL_KEY);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Grow with content from min-h-16 (64px) up to ~12 lines (320px), then scroll inside the box.
  useAutoResizeTextarea(textareaRef, input, { minHeight: 64, maxHeight: 320 });
  const prevStatus = useRef<'idle' | 'sending'>('idle');
  // Set while a /api/chat fetch is in flight so the user can stop it. The
  // server's res.on('close') handler aborts the upstream LLM call when the
  // socket goes away, so a fetch abort here propagates all the way through
  // (and the partial assistant turn is persisted server-side in the finally).
  const abortRef = useRef<AbortController | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  // After the agent finishes streaming (status: sending → idle), put focus
  // back on the textarea so the user can keep typing without reaching for
  // the mouse.
  useEffect(() => {
    if (prevStatus.current === 'sending' && status === 'idle') {
      textareaRef.current?.focus();
    }
    prevStatus.current = status;
  }, [status]);

  async function uploadFiles(files: FileList) {
    setUploading(true);
    setError('');
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('sessionId', sessionId);
        form.append('file', file);
        const response = await fetch('/api/files', {
          method: 'POST',
          credentials: 'include',
          body: form,
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Upload failed (${response.status})`);
        }
        const data = (await response.json()) as { item: Attachment };
        setAttachments((current) => [...current, data.item]);
        setAttachmentsById((current) => ({ ...current, [data.item.id]: data.item }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((a) => a.id !== id));
    void fetch(`/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
    }).catch(() => undefined);
  }

  useEffect(() => {
    const state = location.state as AssistantRouteState | null;
    if (state?.prefill) {
      setInput(state.prefill);
      setPrefillLabel(state.label ?? null);
      if (state.workflowId) setPendingWorkflowId(state.workflowId);
      // Clear so a later navigation back to / doesn't re-prefill
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);

  // Load persisted history when the page is bound to a chatId.
  useEffect(() => {
    if (!chatId) {
      setHistoryLoaded(true);
      setMessages([]);
      setChatName(null);
      setChatPersonaId(null);
      setAttachments([]);
      setAttachmentsById({});
      setActiveArtifact(null);
      setError('');
      return;
    }
    let cancelled = false;
    setHistoryLoaded(false);
    setMessages([]);
    setError('');
    void (async () => {
      try {
        const [chatRes, msgRes] = await Promise.all([
          fetch(`/api/assistant/chats/${encodeURIComponent(chatId)}`, {
            credentials: 'include',
          }),
          fetch(`/api/assistant/chats/${encodeURIComponent(chatId)}/messages`, {
            credentials: 'include',
          }),
        ]);
        if (cancelled) return;
        if (!chatRes.ok) throw new Error(`Failed to load chat (${chatRes.status})`);
        const chatData = (await chatRes.json()) as {
          item: { id: string; name: string; personaId: string | null };
        };
        setChatName(chatData.item.name);
        setChatPersonaId(chatData.item.personaId);
        // Restore the chat's saved persona, overriding whatever was active
        // before. If the chat was created before this column existed (null),
        // leave the user's current selection alone.
        if (chatData.item.personaId !== undefined) {
          onSelectPersonaId(chatData.item.personaId);
        }
        if (msgRes.ok) {
          const msgData = (await msgRes.json()) as { items: PersistedChatMessage[] };
          setMessages(hydratePersisted(msgData.items));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load chat');
      } finally {
        if (!cancelled) setHistoryLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // Mid-chat persona switch: when the user picks a different persona while
  // sitting inside a chat, persist that to the chat row so reopening uses
  // the new selection. Skipped while history is loading (the load effect
  // sets `chatPersonaId` from the row, which would otherwise look like a
  // user-driven switch on first render).
  useEffect(() => {
    if (!chatId || !historyLoaded) return;
    const desired = persona?.id ?? null;
    if (desired === chatPersonaId) return;
    setChatPersonaId(desired);
    void assistantChats
      .update(chatId, { personaId: desired })
      .catch(() => undefined);
    // assistantChats.update is stable enough; the trigger is persona/chatId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona?.id, chatId, historyLoaded]);

  // After a fresh navigate from `/` to `/c/:newChatId`, pick up the message
  // we deferred from the bare-route send and dispatch it now.
  useEffect(() => {
    const state = location.state as AssistantRouteState | null;
    if (!chatId || !historyLoaded || !state?.pendingMessage) return;
    if (messages.length > 0) return;
    const pending = state.pendingMessage;
    const pendingAttachments = state.pendingAttachments ?? [];
    if (pendingAttachments.length > 0) {
      setAttachmentsById((current) => {
        const next = { ...current };
        for (const att of pendingAttachments) next[att.id] = att;
        return next;
      });
    }
    navigate(location.pathname, { replace: true, state: null });
    void sendMessage(pending, pendingAttachments);
    // sendMessage is stable enough — it reads input via closures; this is a one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, historyLoaded]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage(
    overrideText?: string,
    overrideAttachments?: Attachment[],
  ) {
    const text = (overrideText ?? input).trim();
    if (!text || status === 'sending') {
      return;
    }

    // Bare-route first send: persist the chat by creating a row, then navigate
    // to /c/:newId. The new mount picks up `pendingMessage` from route state
    // and re-enters this function with chatId set.
    if (!chatId) {
      try {
        setStatus('sending');
        // Pin the active persona to the chat at create-time so reopening it
        // restores the right system prompt without the user having to remember.
        const newChat = await assistantChats.create({
          personaId: persona?.id ?? null,
        });
        let promotedAttachments = attachments;
        if (attachments.length > 0) {
          const promoteRes = await fetch('/api/files/promote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              fromSessionId: sessionId,
              toSessionId: newChat.id,
              fileIds: attachments.map((a) => a.id),
            }),
          });
          if (!promoteRes.ok) {
            const data = (await promoteRes.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(data.error || `Upload handoff failed (${promoteRes.status})`);
          }
          const data = (await promoteRes.json()) as { items: Attachment[] };
          promotedAttachments = data.items;
        }
        setStatus('idle');
        navigate(`/c/${encodeURIComponent(newChat.id)}`, {
          state: {
            pendingMessage: text,
            pendingAttachments: promotedAttachments,
          } satisfies AssistantRouteState,
        });
        return;
      } catch (err) {
        setStatus('idle');
        setError(err instanceof Error ? err.message : 'Failed to start chat');
        return;
      }
    }

    const nextUserMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    };

    const nextHistory = [...messages, nextUserMessage].map(({ role, content }) => ({
      role,
      content,
    }));
    const assistantId = crypto.randomUUID();

    setMessages((current) => [
      ...current,
      nextUserMessage,
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    const turnAttachments = overrideAttachments ?? attachments;
    const sentAttachmentIds = turnAttachments.map((a) => a.id);

    setInput('');
    setPrefillLabel(null);
    setPendingWorkflowId(null);
    if (!overrideAttachments) setAttachments([]);
    setStatus('sending');
    setError('');

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sessionId,
          chatId,
          message: text,
          history: nextHistory.slice(0, -1),
          attachmentIds: sentAttachmentIds,
          model: selectedModel,
          personaId: persona?.id,
          workflowId: pendingWorkflowId ?? undefined,
        }),
        signal: ac.signal,
      });

      if (!response.body) {
        throw new Error('No response body from starter chat backend');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamFinished = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          const line = event
            .split('\n')
            .find((candidate) => candidate.startsWith('data: '));

          if (!line) {
            continue;
          }

          const payload = JSON.parse(line.slice(6)) as
            | { type: 'chunk'; text: string }
            | { type: 'tool_call'; id: string; name: string; args: unknown }
            | { type: 'tool_result'; id: string; name: string; result: unknown }
            | { type: 'tool_error'; id: string; name: string; error: string }
            | { type: 'done' }
            | { type: 'error'; message: string };

          if (payload.type === 'chunk') {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? { ...message, content: message.content + payload.text }
                  : message,
              ),
            );
          } else if (payload.type === 'tool_call') {
            setMessages((current) =>
              current.map((message) => {
                if (message.id !== assistantId) return message;
                const events = message.toolEvents ?? [];
                return {
                  ...message,
                  toolEvents: [
                    ...events,
                    {
                      id: payload.id,
                      name: payload.name,
                      args: payload.args,
                      status: 'running' as const,
                    },
                  ],
                };
              }),
            );
          } else if (payload.type === 'tool_result') {
            // Tools that work on a doc embed `_doc_state` so the client can
            // surface a live read-only artifact panel without polling.
            if (payload.result && typeof payload.result === 'object') {
              const result = payload.result as {
                _doc_state?: unknown;
                download_url?: unknown;
                filename?: unknown;
              };
              const ds = result._doc_state;
              if (ds && typeof ds === 'object') {
                const obj = ds as { doc_id?: string; title?: string; markdown?: string };
                if (typeof obj.doc_id === 'string' && typeof obj.markdown === 'string') {
                  const docxUrl = typeof result.download_url === 'string' ? result.download_url : undefined;
                  const docxName = typeof result.filename === 'string' ? result.filename : undefined;
                  setActiveArtifact((prev) => {
                    const carry = prev && prev.docId === obj.doc_id ? prev : null;
                    return {
                      docId: obj.doc_id!,
                      title: typeof obj.title === 'string' ? obj.title : 'Document',
                      markdown: obj.markdown!,
                      docxDownloadUrl: docxUrl ?? carry?.docxDownloadUrl,
                      docxFilename: docxName ?? carry?.docxFilename,
                    };
                  });
                }
              }
            }
            setMessages((current) =>
              current.map((message) => {
                if (message.id !== assistantId) return message;
                const events = (message.toolEvents ?? []).map((event) =>
                  event.id === payload.id
                    ? { ...event, result: payload.result, status: 'done' as const }
                    : event,
                );
                return { ...message, toolEvents: events };
              }),
            );
          } else if (payload.type === 'tool_error') {
            setMessages((current) =>
              current.map((message) => {
                if (message.id !== assistantId) return message;
                const events = (message.toolEvents ?? []).map((event) =>
                  event.id === payload.id
                    ? { ...event, error: payload.error, status: 'error' as const }
                    : event,
                );
                return { ...message, toolEvents: events };
              }),
            );
          } else if (payload.type === 'error') {
            setError(payload.message);
          } else if (payload.type === 'done') {
            // The server sends 'done' as the last SSE event before res.end().
            // Some proxies (Vite dev, etc.) buffer the connection-close, so
            // relying on reader.read() returning done:true is unreliable.
            // Re-enable the composer eagerly here, then break out of the read
            // loop. Don't await reader.cancel() — that can also hang on a
            // buffered proxy. (Auto-focus is handled by a useEffect that
            // watches the sending → idle transition.)
            setMessages((current) =>
              current.map((message) => {
                if (message.id !== assistantId) return message;
                if (message.content.length === 0) return message;
                const { text, citations } = parseResponse(message.content);
                return { ...message, parsed: { text, citations } };
              }),
            );
            setStatus('idle');
            streamFinished = true;
          }
        }
        if (streamFinished) {
          reader.cancel().catch(() => undefined);
          break;
        }
      }
    } catch (err) {
      // User-initiated stop: signal aborted via stopStreaming(). The partial
      // assistant text is already in `messages` from the chunks that arrived
      // before the abort, so just bail without surfacing an error.
      if (err instanceof DOMException && err.name === 'AbortError') {
        // intentional no-op
      } else {
        setError(err instanceof Error ? err.message : 'Chat failed');
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setStatus('idle');
    }

    // Pick up any auto-titled name set on the server.
    if (chatId) {
      try {
        const r = await fetch(`/api/assistant/chats/${encodeURIComponent(chatId)}`, {
          credentials: 'include',
        });
        if (r.ok) {
          const d = (await r.json()) as { item: { name: string } };
          setChatName(d.item.name);
        }
      } catch {
        // best-effort; ignore
      }
    }
  }

  function stopStreaming() {
    abortRef.current?.abort();
  }

  async function newChat() {
    await fetch('/api/session/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => undefined);

    setMessages([]);
    setInput('');
    setPrefillLabel(null);
    setAttachments([]);
    setAttachmentsById({});
    setActiveArtifact(null);
    setError('');
    if (chatId) navigate('/');
  }

  function handleCitationJump(citation: Citation) {
    const att = attachmentsById[citation.doc];
    if (!att) {
      // Unknown handle (e.g. doc was uploaded in a different session, or
      // the model hallucinated a file_id). Nothing to preview.
      setError(`No attachment found for citation handle "${citation.doc}"`);
      return;
    }
    openDoc({
      // Assistant uploads live in a per-session bucket, not a matter
      // bucket — matterId here is the session id, used the same way as
      // the bucket key in the file URL.
      matterId: sessionId,
      fileId: att.id,
      fileName: att.name,
      mimeType: att.mimeType,
      url: `/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(att.id)}/content`,
      quote: citation.quote,
      page: pageHintFromLocator(citation.locator),
    });
  }

  const docLabels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const id in attachmentsById) {
      out[id] = attachmentsById[id]!.name;
    }
    return out;
  }, [attachmentsById]);

  const isStreaming = status === 'sending';
  const isEmpty = messages.length === 0;
  const showGreeting = isEmpty && historyLoaded && !chatId;
  const showLoading = !!chatId && !historyLoaded;

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border px-5">
        <button
          type="button"
          onClick={onOpenPicker}
          className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-accent"
          title="Switch persona"
        >
          <PersonaAvatar persona={persona} size="xs" />
          <div className="text-left">
            <div className="text-sm font-medium text-foreground">{displayName}</div>
            {persona && (
              <div className="text-[10px] text-muted-foreground">{persona.description}</div>
            )}
          </div>
        </button>
        {(messages.length > 0 || chatId) && (
          <Button size="sm" variant="outline" onClick={() => void newChat()}>
            New chat
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {showLoading ? (
          <div className="mx-auto flex h-full max-w-3xl items-center justify-center px-6 py-16 text-sm text-muted-foreground">
            Loading chat…
          </div>
        ) : showGreeting ? (
          <Greeting
            name={displayName}
            prompts={PROMPTS}
            onSelect={(prompt) => void sendMessage(prompt)}
          />
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-8">
            {chatName && (
              <div className="border-b border-border pb-3 text-xs text-muted-foreground">
                {chatName}
              </div>
            )}
            {messages.map((message, idx) => (
              <MessageItem
                key={message.id}
                message={message}
                agentName={agentName}
                // Only the last message is "active" (currently streaming).
                isActive={isStreaming && idx === messages.length - 1}
                onJump={handleCitationJump}
                docLabels={docLabels}
                chatKey={chatId ?? sessionId}
              />
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="border-t border-border bg-background px-5 py-4">
        <div className="mx-auto w-full max-w-3xl">
          {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = event.target.files;
              if (files && files.length > 0) void uploadFiles(files);
              event.target.value = '';
            }}
          />
          {prefillLabel && (
            <div className="mb-2 inline-flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
              <span>From Library:</span>
              <span className="font-medium text-foreground">{prefillLabel}</span>
              <button
                type="button"
                onClick={() => {
                  setInput('');
                  setPrefillLabel(null);
                }}
                className="ml-1 text-muted-foreground hover:text-foreground"
                aria-label="Clear prefilled prompt"
              >
                ×
              </button>
            </div>
          )}
          <div className="rounded-2xl border border-border bg-card shadow-sm transition-all focus-within:ring-2 focus-within:ring-ring/30 focus-within:border-foreground/30 focus-within:shadow-md">
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-b border-border px-3 pb-2 pt-2.5">
                {attachments.map((att) => (
                  <span
                    key={att.id}
                    className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[11px] text-foreground"
                    title={`${att.mimeType} · ${humanSize(att.size)}`}
                  >
                    <span className="max-w-[180px] truncate font-medium">{att.name}</span>
                    <span className="text-muted-foreground">{humanSize(att.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(att.id)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${att.name}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {/* Raw <textarea> on purpose — using @teamsuzie/ui's <Textarea>
                here drags in a default border + bg-background that conflict
                with the outer card and don't reliably get stripped by twMerge. */}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder={`Message ${agentName}`}
              disabled={isStreaming}
              className="block w-full min-h-16 resize-none border-0 bg-transparent px-4 pt-3 text-[15px] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
            <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || isStreaming}
                  className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                  aria-label="Attach files"
                >
                  <Paperclip className="size-4" aria-hidden />
                  <span className="text-xs">{uploading ? 'Uploading…' : 'Files'}</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setWorkflowPickerOpen(true)}
                  disabled={isStreaming}
                  className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                  aria-label="Run a workflow"
                >
                  <Sparkles className="size-4" aria-hidden />
                  <span className="text-xs">Workflow</span>
                </Button>
                <p className="hidden text-xs text-muted-foreground sm:inline">
                  Enter sends · Shift+Enter newline
                </p>
              </div>
              {isStreaming ? (
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={stopStreaming}
                  className="h-8 rounded-full px-4"
                  aria-label="Stop streaming"
                >
                  <Square className="size-3 fill-current" aria-hidden />
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => void sendMessage()}
                  disabled={!input.trim() && attachments.length === 0}
                  className="h-8 rounded-full px-4"
                >
                  Send
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>
      {activeArtifact && (
        <ArtifactPanel
          artifact={activeArtifact}
          onClose={() => setActiveArtifact(null)}
        />
      )}
      <WorkflowPickerDialog
        open={workflowPickerOpen}
        onOpenChange={setWorkflowPickerOpen}
        onSelect={(workflow) => {
          setInput(workflow.prompt);
          setPrefillLabel(workflow.name);
          setPendingWorkflowId(workflow.id);
          // Defer focus to next tick so the dialog's close animation
          // doesn't fight the textarea focus.
          window.setTimeout(() => textareaRef.current?.focus(), 0);
        }}
      />
    </div>
  );
}
