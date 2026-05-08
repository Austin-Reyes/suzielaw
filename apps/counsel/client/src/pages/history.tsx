import { useNavigate } from 'react-router-dom';
import {
  AppShellContent,
  Button,
  EmptyState,
  EmptyStateDescription,
  EmptyStateTitle,
  LoadingState,
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
  Trash2,
  useConfirm,
} from '@teamsuzie/ui';
import { useAssistantChats } from '../hooks/use-assistant-chats.js';

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function HistoryPage() {
  const { chats, loading, error, remove } = useAssistantChats();
  const navigate = useNavigate();
  const confirm = useConfirm();

  async function handleDelete(chatId: string, name: string) {
    const ok = await confirm({
      title: `Delete "${name}"?`,
      description: 'This removes the chat and all of its messages. There is no undo.',
      confirmLabel: 'Delete chat',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await remove(chatId);
    } catch {
      // useConfirm doesn't surface this, but the hook's local state is already
      // unchanged on failure — the user can retry.
    }
  }

  return (
    <>
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>History</PageHeaderTitle>
          <PageHeaderDescription>
            Recent assistant conversations.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>
      <AppShellContent className="px-6 pt-6 pb-12">
        {loading ? (
          <LoadingState>Loading chats…</LoadingState>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : chats.length === 0 ? (
          <EmptyState>
            <EmptyStateTitle>No conversations yet</EmptyStateTitle>
            <EmptyStateDescription>
              Start a new chat from the Assistant page — it'll show up here.
            </EmptyStateDescription>
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {chats.map((chat) => (
              <li
                key={chat.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <button
                  type="button"
                  onClick={() =>
                    navigate(`/c/${encodeURIComponent(chat.id)}`)
                  }
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                >
                  <span className="truncate text-sm font-medium text-foreground">
                    {chat.name || 'New chat'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(chat.updatedAt)}
                  </span>
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleDelete(chat.id, chat.name)}
                  aria-label={`Delete ${chat.name}`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </AppShellContent>
    </>
  );
}
