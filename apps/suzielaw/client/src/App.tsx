import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AppShell,
  AppShellMain,
  SidePanelSurface,
  Button,
  PersonaAvatar,
  PersonaPicker,
  Sidebar,
  SidebarFooter,
  SidebarHeader,
  SidebarNav,
  SidebarNavItem,
  StatusDot,
  cn,
  usePersonas,
  useSelectedPersona,
} from '@teamsuzie/ui';
import { Protected } from './components/protected.js';
import { useAssistantChats } from './hooks/use-assistant-chats.js';
import { useSession } from './hooks/use-session.js';
import { AssistantPage } from './pages/assistant.js';
import { HistoryPage } from './pages/history.js';
import { KnowledgeBasePage } from './pages/knowledge-base.js';
import { LibraryPage } from './pages/library.js';
import { LoginPage } from './pages/login.js';
import { MattersPage } from './pages/matters.js';
import { MatterDetailPage } from './pages/matter-detail.js';
import { ReviewDetailPage } from './pages/review-detail.js';
import { MatterChatPage } from './pages/matter-chat.js';
import { ReviewChatPage } from './pages/review-chat.js';
import { PersonasPage } from './pages/personas.js';
import { AdminPage } from './pages/admin.js';
import { SettingsPage } from './pages/settings.js';

interface HealthResponse {
  title: string;
  agent: {
    name: string;
    description?: string;
    model?: string;
    reachable: boolean;
    error?: string;
  };
  kb?: { enabled: boolean; documents?: number; chunks?: number };
  modelAgents?: Record<string, { baseUrl: string }>;
  cloudProviders?: { id: string; label: string; modelIds: string[]; hint?: string; keyUrl?: string }[];
  demo?: { email: string; password: string };
}

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}
const BASE_NAV_TAIL: NavItem[] = [
  { to: '/matters', label: 'Matters' },
  { to: '/library', label: 'Library' },
  { to: '/personas', label: 'Personas' },
];
const KB_NAV_ITEM: NavItem = { to: '/knowledge-base', label: 'Knowledge Base' };
const TAIL_NAV: NavItem[] = [
  { to: '/history', label: 'History' },
  { to: '/admin', label: 'Admin' },
];

function AssistantChatRoute(props: {
  agentName: string;
  persona: ReturnType<typeof usePersonas>['personas'][number] | null;
  onOpenPicker: () => void;
  onSelectPersonaId: (id: string | null) => void;
}) {
  const { chatId } = useParams<{ chatId: string }>();
  return <AssistantPage {...props} chatId={chatId} />;
}

/**
 * Assistant sidebar link. NavLink's built-in active matcher only handles a
 * single path pattern; we want the row highlighted when the user is on `/`
 * (greeting) OR any `/c/:chatId` chat. So we drive `aria-current` ourselves
 * — SidebarNavItem reads it for active styling.
 *
 * SidebarNavItem with `asChild` uses Radix `Slot`, which clones className /
 * data-slot props onto the child *element*. So this component must spread
 * `props` onto the inner Link — otherwise the sidebar's row styling never
 * reaches the anchor and the row looks unstyled.
 */
function AssistantNavLink({
  to,
  label,
  ...props
}: { to: string; label: string } & React.ComponentPropsWithoutRef<'a'>) {
  const location = useLocation();
  const isActive =
    location.pathname === '/' || location.pathname.startsWith('/c/');
  return (
    <Link to={to} aria-current={isActive ? 'page' : undefined} {...props}>
      {label}
    </Link>
  );
}

function Wordmark({ title }: { title: string }) {
  return (
    <div className="flex items-center">
      <span className="text-base font-semibold tracking-tight">{title}</span>
    </div>
  );
}

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthLoaded, setHealthLoaded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const session = useSession();
  const navigate = useNavigate();
  const { personas, loading: personasLoading } = usePersonas();
  const personaList = Array.isArray(personas) ? personas : [];
  const [selectedPersonaId, setSelectedPersonaId] = useSelectedPersona('suzielaw:selected-persona');
  const selectedPersona = useMemo(
    () => personaList.find((p) => p.id === selectedPersonaId) ?? null,
    [personaList, selectedPersonaId],
  );
  // The "Assistant" sidebar link resumes the most recent chat when one
  // exists — clicking it shouldn't blow away the chat the user was in.
  // The "New chat" button on the Assistant page navigates to bare `/` to
  // get a fresh greeting, which then creates a chat on first send.
  const assistantChats = useAssistantChats();
  const mostRecentChatId = assistantChats.chats[0]?.id;
  const assistantTo = mostRecentChatId
    ? `/c/${encodeURIComponent(mostRecentChatId)}`
    : '/';
  const nav = useMemo(() => {
    const head: NavItem[] = [
      // `end: false` here so the link stays highlighted on `/c/*` too —
      // matches the user expectation that "Assistant" is the active tab
      // whenever you're inside a top-level chat.
      { to: assistantTo, label: 'Assistant', end: false },
      ...BASE_NAV_TAIL,
    ];
    return health?.kb?.enabled ? [...head, KB_NAV_ITEM, ...TAIL_NAV] : [...head, ...TAIL_NAV];
  }, [health?.kb?.enabled, assistantTo]);

  useEffect(() => {
    let cancelled = false;

    async function refreshHealth() {
      try {
        const response = await fetch('/api/health');
        const next = (await response.json()) as HealthResponse;
        if (!cancelled) setHealth(next);
      } catch {
        if (!cancelled) {
          setHealth((current) =>
            current
              ? { ...current, agent: { ...current.agent, reachable: false } }
              : current,
          );
        }
      } finally {
        if (!cancelled) setHealthLoaded(true);
      }
    }

    void refreshHealth();
    const interval = window.setInterval(() => {
      void refreshHealth();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const title = health?.title || 'RBL Counsel Assist';
  const agentName = health?.agent?.name || 'Counsel';
  const agentReachable = health?.agent?.reachable ?? false;
  const statusState: 'online' | 'offline' | 'pending' = !healthLoaded
    ? 'pending'
    : agentReachable
      ? 'online'
      : 'offline';

  return (
    <Routes>
      <Route
        path="/login"
        element={
          <LoginPage />
        }
      />
      <Route
        path="/*"
        element={
          <Protected user={session.user} loading={session.loading}>
            <AppShell>
              <Sidebar>
                <SidebarHeader>
                  <Wordmark title={title} />
                </SidebarHeader>
                <SidebarNav>
                  {nav.map((item) => (
                    <SidebarNavItem key={item.label} asChild>
                      {item.label === 'Assistant' ? (
                        <AssistantNavLink to={item.to} label={item.label} />
                      ) : (
                        <NavLink to={item.to} end={item.end}>
                          {item.label}
                        </NavLink>
                      )}
                    </SidebarNavItem>
                  ))}
                </SidebarNav>
                <SidebarFooter>
                  <Button
                    variant="outline"
                    onClick={() => setPickerOpen(true)}
                    className="mb-2 h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
                    title="Switch persona"
                  >
                    <PersonaAvatar persona={selectedPersona} size="xs" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-foreground">
                        {selectedPersona ? selectedPersona.name : 'Default Counsel'}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        Click to switch
                      </div>
                    </div>
                  </Button>
                  <SidebarNavItem asChild>
                    <NavLink to="/settings">Settings</NavLink>
                  </SidebarNavItem>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <StatusDot name={agentName} state={statusState} />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        void session.logout().then(() => navigate('/login', { replace: true }));
                      }}
                    >
                      Sign out
                    </Button>
                  </div>
                </SidebarFooter>
              </Sidebar>
              <AppShellMain>
                <Routes>
                  <Route
                    path="/"
                    element={
                      <AssistantPage
                        agentName={agentName}
                        persona={selectedPersona}
                        onOpenPicker={() => setPickerOpen(true)}
                        onSelectPersonaId={setSelectedPersonaId}
                      />
                    }
                  />
                  <Route
                    path="/c/:chatId"
                    element={
                      <AssistantChatRoute
                        agentName={agentName}
                        persona={selectedPersona}
                        onOpenPicker={() => setPickerOpen(true)}
                        onSelectPersonaId={setSelectedPersonaId}
                      />
                    }
                  />
                  <Route path="/matters" element={<MattersPage />} />
                  <Route path="/matters/:matterId" element={<MatterDetailPage />} />
                  <Route
                    path="/matters/:matterId/reviews/:reviewId"
                    element={<ReviewDetailPage />}
                  />
                  <Route
                    path="/matters/:matterId/reviews/:reviewId/chats/:chatId"
                    element={<ReviewChatPage />}
                  />
                  <Route
                    path="/matters/:matterId/chats/:chatId"
                    element={<MatterChatPage />}
                  />
                  <Route path="/library" element={<LibraryPage />} />
                  <Route path="/personas" element={<PersonasPage />} />
                  {health?.kb?.enabled && (
                    <Route path="/knowledge-base" element={<KnowledgeBasePage />} />
                  )}
                  <Route path="/history" element={<HistoryPage />} />
                  <Route path="/admin" element={<AdminPage />} />
                  <Route
                    path="/settings"
                    element={
                      <SettingsPage
                        defaultModel={health?.agent?.model}
                        cloudProviders={health?.cloudProviders ?? []}
                      />
                    }
                  />
                </Routes>
              </AppShellMain>
              <SidePanelSurface />
            </AppShell>
            <PersonaPicker
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              personas={personaList}
              loading={personasLoading}
              selectedId={selectedPersonaId}
              onSelect={(p) => setSelectedPersonaId(p.id)}
              onClearSelection={() => setSelectedPersonaId(null)}
            />
          </Protected>
        }
      />
    </Routes>
  );
}
