import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  PendingButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  cn,
} from '@teamsuzie/ui';
import { PRACTICE_AREAS } from '../data/practice-areas.js';
import type {
  CreateWorkflowInput,
  UpdateWorkflowInput,
  Workflow,
  WorkflowOutputMode,
} from '../hooks/use-workflows.js';

// User-create mode is restricted to the two modes that don't require a
// column-config editor (which we don't ship in this dialog yet — system
// seeds are the only `tabular_review` path today). Edit mode shows the
// existing value as read-only when it's `tabular_review` so users don't
// silently lose the column config by switching modes.
const USER_OUTPUT_MODES: { value: WorkflowOutputMode; label: string; hint: string }[] = [
  {
    value: 'inline_chat',
    label: 'Inline chat',
    hint: 'Default. The model produces prose in the chat — best for free-form drafts (memos, agreements, opinions).',
  },
  {
    value: 'generate_docx',
    label: 'Word document',
    hint: 'The model calls generate_docx to produce a structured Word file (sections, tables, page breaks). Best for checklists and questionnaires with a fixed shape.',
  },
];

export type WorkflowFormMode = 'create' | 'edit';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: WorkflowFormMode;
  /** Used to seed the form in edit mode. Ignored in create mode. */
  initial?: Workflow | null;
  onCreate?: (input: CreateWorkflowInput) => Promise<unknown>;
  onUpdate?: (id: string, patch: UpdateWorkflowInput) => Promise<unknown>;
}

/**
 * Single dialog for creating + editing user workflows. Replaces the
 * old `<CreatePromptDialog>` with a workflow-shaped API that talks to
 * `/api/workflows`. The form layout stays identical so users don't
 * notice the swap.
 */
export function WorkflowFormDialog({
  open,
  onOpenChange,
  mode,
  initial,
  onCreate,
  onUpdate,
}: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [areas, setAreas] = useState<string[]>([]);
  const [outputMode, setOutputMode] =
    useState<WorkflowOutputMode>('inline_chat');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed / reset form whenever the dialog opens. In edit mode that
  // means pulling fields from `initial`; in create mode it means
  // clearing everything.
  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && initial) {
      setName(initial.name);
      setDescription(initial.description);
      setPrompt(initial.prompt);
      setAreas(initial.practiceAreas);
      setOutputMode(initial.outputMode);
    } else {
      setName('');
      setDescription('');
      setPrompt('');
      setAreas([]);
      setOutputMode('inline_chat');
    }
    setError(null);
  }, [open, mode, initial]);

  function toggleArea(id: string) {
    setAreas((current) =>
      current.includes(id) ? current.filter((a) => a !== id) : [...current, id],
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName || !trimmedPrompt) {
      setError('Name and prompt are required.');
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'edit' && initial && onUpdate) {
        await onUpdate(initial.id, {
          name: trimmedName,
          description: description.trim(),
          prompt: trimmedPrompt,
          practiceAreas: areas,
          // Don't ship `tabular_review` from this dialog — see the
          // USER_OUTPUT_MODES comment. If the row is currently
          // `tabular_review` and the user didn't touch the picker, the
          // patch leaves it alone (we send the current value).
          outputMode,
        });
      } else if (mode === 'create' && onCreate) {
        await onCreate({
          name: trimmedName,
          description: description.trim(),
          prompt: trimmedPrompt,
          practiceAreas: areas,
          outputMode,
        });
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? 'Create a workflow' : 'Edit workflow'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Save a reusable prompt to your library. It runs in the assistant when you click the card.'
              : 'Update this workflow. Changes are saved to your library.'}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="wf-name">Name</Label>
            <Input
              id="wf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Draft a confidentiality agreement"
              required
              maxLength={120}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-desc">Description</Label>
            <Input
              id="wf-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One-line summary shown on the card."
              maxLength={200}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Practice areas</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRACTICE_AREAS.map((area) => {
                const selected = areas.includes(area.id);
                return (
                  <Button
                    key={area.id}
                    type="button"
                    variant={selected ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleArea(area.id)}
                    className={cn(
                      'h-7 rounded-md px-2 text-xs font-medium',
                      !selected && 'bg-muted text-muted-foreground',
                    )}
                  >
                    {area.label}
                  </Button>
                );
              })}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-output-mode">Output</Label>
            {outputMode === 'tabular_review' ? (
              // System-seeded review templates land here in edit mode.
              // We don't expose a column-config editor in this dialog, so
              // we surface the mode read-only rather than letting the
              // user accidentally drop the columns by switching modes.
              <p className="text-xs text-muted-foreground">
                Review template — column config is set at the system level. Edit the prompt and tags here; column changes need a code update.
              </p>
            ) : (
              <>
                <Select
                  value={outputMode}
                  onValueChange={(v) => setOutputMode(v as WorkflowOutputMode)}
                >
                  <SelectTrigger id="wf-output-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {USER_OUTPUT_MODES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {USER_OUTPUT_MODES.find((m) => m.value === outputMode)?.hint}
                </p>
              </>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-prompt">Prompt</Label>
            <Textarea
              id="wf-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                outputMode === 'generate_docx'
                  ? 'Describe the document the model should produce — sections, tables, headings. The model will call generate_docx with that structure.'
                  : 'The text the assistant will receive when this workflow is launched.'
              }
              rows={6}
              required
            />
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
              {mode === 'create' ? 'Save workflow' : 'Save changes'}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
