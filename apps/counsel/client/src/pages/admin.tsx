import { useState } from 'react';
import {
  AppShellContent,
  Button,
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
  RefreshCw,
  SettingsCard,
  Trash2,
  useConfirm,
} from '@teamsuzie/ui';

interface ResetSummary {
  kbDocsDeleted: number;
  filesDeleted: number;
}

export function AdminPage() {
  const confirm = useConfirm();
  const [resetSummary, setResetSummary] = useState<ResetSummary | null>(null);

  async function openResetConfirm() {
    setResetSummary(null);
    await confirm({
      title: 'Reset all content?',
      description:
        'Deletes every matter, folder, document, chat, review, and KB entry — plus the on-disk file bytes. Personas, prompts, and model overrides are kept. There is no undo.',
      confirmLabel: 'Delete everything',
      variant: 'destructive',
      onConfirm: async () => {
        const res = await fetch('/api/admin/reset', {
          method: 'POST',
          credentials: 'include',
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          kbDocsDeleted?: number;
          filesDeleted?: number;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `Reset failed (${res.status})`);
        }
        setResetSummary({
          kbDocsDeleted: data.kbDocsDeleted ?? 0,
          filesDeleted: data.filesDeleted ?? 0,
        });
      },
    });
  }

  return (
    <>
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Admin</PageHeaderTitle>
          <PageHeaderDescription>
            Destructive actions and content management.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>
      <AppShellContent className="px-6 pt-6 pb-12">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          <SettingsCard label="Danger zone" title="Reset all content">
            <p>
              Deletes every matter, folder, document, chat, review, and
              knowledge-base entry — plus the on-disk file bytes. Personas,
              prompts, and model overrides are kept. There is no undo.
            </p>
            <Button
              variant="destructive"
              className="w-fit"
              onClick={() => void openResetConfirm()}
            >
              <Trash2 className="size-4" aria-hidden />
              Reset all content
            </Button>
            {resetSummary && (
              <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
                <p className="mb-1 font-medium text-foreground">Reset complete.</p>
                <p className="text-muted-foreground">
                  Removed {resetSummary.kbDocsDeleted} KB document
                  {resetSummary.kbDocsDeleted === 1 ? '' : 's'} and{' '}
                  {resetSummary.filesDeleted} file
                  {resetSummary.filesDeleted === 1 ? '' : 's'}. Reload to
                  refresh the matters list.
                </p>
                <Button
                  variant="outline"
                  className="mt-2"
                  onClick={() => window.location.reload()}
                >
                  <RefreshCw className="size-4" aria-hidden />
                  Reload now
                </Button>
              </div>
            )}
          </SettingsCard>
        </div>
      </AppShellContent>
    </>
  );
}
