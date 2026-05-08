import { useState } from 'react';
import {
  Button,
  Check,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  LoadingState,
  PendingButton,
  SettingsCard,
  Trash2,
  useConfirm,
} from '@teamsuzie/ui';
import { useProviderKeys } from '../hooks/use-provider-keys.js';

/**
 * Display metadata for a cloud BYOK provider. Mirrors the server-side
 * `CloudProvider` shape but only the bits the UI needs.
 */
export interface ProviderDisplay {
  id: string;
  label: string;
  hint?: string;
  keyUrl?: string;
}

interface Props {
  providers: ProviderDisplay[];
}

interface KeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderDisplay | null;
  onSave: (apiKey: string) => Promise<void>;
}

function KeyDialog({ open, onOpenChange, provider, onSave }: KeyDialogProps) {
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('Paste your API key.');
      return;
    }
    setSubmitting(true);
    try {
      await onSave(trimmed);
      setApiKey('');
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setApiKey('');
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {provider ? `Add your ${provider.label} key` : 'Add provider key'}
          </DialogTitle>
          <DialogDescription>
            {provider?.hint ??
              'Your API key is stored locally and only used when you pick a model from this provider.'}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="provider-api-key">API key</Label>
            <Input
              id="provider-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            {provider?.keyUrl && (
              <p className="text-xs text-muted-foreground">
                Find your key at{' '}
                <a
                  href={provider.keyUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {provider.keyUrl}
                </a>
                .
              </p>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <PendingButton type="submit" pending={submitting} pendingLabel="Saving">
              Save key
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings card listing each known cloud provider with a "Set key" /
 * "Update / Remove" affordance. Drives BYOK: keys saved here unlock
 * the corresponding cloud models in the picker.
 */
export function ProviderKeysCard({ providers }: Props) {
  const { providers: rows, loading, error, setKey, clearKey } = useProviderKeys();
  const [editingId, setEditingId] = useState<string | null>(null);
  const confirm = useConfirm();

  const editing = providers.find((p) => p.id === editingId) ?? null;

  return (
    <SettingsCard label="Provider keys" title="Use your own API keys">
      <p>
        Pick which providers Counsel can route to with your own credentials. With a key set, the matching cloud models become available in the model picker — and Counsel bills the call against your account, not the demo budget.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {loading ? (
        <LoadingState>Loading provider keys…</LoadingState>
      ) : (
        <ul className="divide-y rounded-md border">
          {providers.map((p) => {
            const row = rows.find((r) => r.providerId === p.id);
            const hasKey = !!row?.hasKey;
            return (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {p.label}
                    {hasKey && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        <Check className="size-3" aria-hidden />
                        Key set
                      </span>
                    )}
                  </p>
                  {p.hint && (
                    <p className="text-xs text-muted-foreground">{p.hint}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditingId(p.id)}
                  >
                    {hasKey ? 'Update' : 'Add key'}
                  </Button>
                  {hasKey && (
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`Remove ${p.label} key`}
                      className="size-8 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Remove your ${p.label} key?`,
                            description: `Counsel will stop routing this provider's models to your account. The demo-budget default still works.`,
                            confirmLabel: 'Remove key',
                            variant: 'destructive',
                          })
                        ) {
                          await clearKey(p.id);
                        }
                      }}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <KeyDialog
        open={editingId !== null}
        onOpenChange={(open) => {
          if (!open) setEditingId(null);
        }}
        provider={editing}
        onSave={async (key) => {
          if (editing) await setKey(editing.id, key);
        }}
      />
    </SettingsCard>
  );
}
