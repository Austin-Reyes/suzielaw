import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AppShellContent,
  Button,
  EmptyState,
  EmptyStateDescription,
  EmptyStateTitle,
  EyeOff,
  History,
  LoadingState,
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
  Pagination,
  Pencil,
  Plus,
  PromptCard,
  PromptCardDescription,
  PromptCardTag,
  PromptCardTags,
  PromptCardTitle,
  RowActions,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Trash2,
  Users,
  useConfirm,
} from '@teamsuzie/ui';
import { WorkflowFormDialog } from '../components/workflow-form-dialog.js';
import { ShareDialog } from '../components/share-dialog.js';
import { WorkflowHistoryDialog } from '../components/workflow-history-dialog.js';
import { PRACTICE_AREAS, practiceAreaLabel } from '../data/practice-areas.js';
import { useWorkflows, type Workflow } from '../hooks/use-workflows.js';

const ALL = 'all';
const PAGE_SIZE = 24;

function escapeCsvField(value: string): string {
  if (value === '') return '';
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replaceAll('"', '""') + '"';
  }
  return value;
}

function buildCsv(workflows: Workflow[]): string {
  const header = ['source', 'id', 'name', 'description', 'practice_areas', 'prompt'];
  const lines = [header.join(',')];
  for (const w of workflows) {
    lines.push(
      [
        w.source,
        w.id,
        w.name,
        w.description,
        w.practiceAreas.join('|'),
        w.prompt,
      ]
        .map(escapeCsvField)
        .join(','),
    );
  }
  return lines.join('\n');
}

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function LibraryPage() {
  const [areaFilter, setAreaFilter] = useState<string>(ALL);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [sharing, setSharing] = useState<Workflow | null>(null);
  const [historyFor, setHistoryFor] = useState<Workflow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const navigate = useNavigate();
  const wf = useWorkflows();
  const confirm = useConfirm();

  // Reset to page 1 when the filter changes — staying on page 5 of an empty
  // result set is jarring.
  useEffect(() => {
    setPage(1);
  }, [areaFilter]);

  const matches = (areas: string[]) => areaFilter === ALL || areas.includes(areaFilter);
  const filteredWorkflows = useMemo(() => {
    return wf.workflows
      .filter((w) => matches(w.practiceAreas))
      // Sort: user-owned first (the user's own work goes top of list),
      // then system, both alphabetical within their group.
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === 'user' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [wf.workflows, areaFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredWorkflows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pagedWorkflows = filteredWorkflows.slice(pageStart, pageStart + PAGE_SIZE);

  const userCount = wf.workflows.filter((w) => w.source === 'user').length;
  const systemCount = wf.workflows.filter((w) => w.source === 'system').length;

  function openInAssistant(workflow: Workflow) {
    navigate('/', {
      state: {
        prefill: workflow.prompt,
        label: workflow.name,
        workflowId: workflow.id,
      },
    });
  }

  async function handleDelete(workflow: Workflow) {
    if (
      !(await confirm({
        title: `Delete "${workflow.name}"?`,
        description: 'The workflow will be removed from your library. There is no undo.',
        confirmLabel: 'Delete workflow',
        variant: 'destructive',
      }))
    ) {
      return;
    }
    setActionError(null);
    try {
      await wf.remove(workflow.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function handleHide(workflow: Workflow) {
    setActionError(null);
    try {
      await wf.hide(workflow.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Hide failed');
    }
  }

  function handleExport() {
    const csv = buildCsv(wf.workflows);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`suzielaw-workflows-${stamp}.csv`, csv);
  }

  return (
    <>
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Library</PageHeaderTitle>
          <PageHeaderDescription>
            {systemCount} built-in · {userCount} saved.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={wf.workflows.length === 0}>
            Export workflows
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Create a workflow
          </Button>
        </PageHeaderActions>
      </PageHeader>
      <AppShellContent className="px-6 pt-6 pb-12">
        <Tabs defaultValue="prompts">
          <div className="mb-4 flex items-center justify-between gap-4">
            <TabsList>
              <TabsTrigger value="prompts">Workflows</TabsTrigger>
              <TabsTrigger value="background">Background jobs</TabsTrigger>
            </TabsList>
            <Select value={areaFilter} onValueChange={setAreaFilter}>
              <SelectTrigger className="w-56" aria-label="Filter by practice area">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All practice areas</SelectItem>
                {PRACTICE_AREAS.map((area) => (
                  <SelectItem key={area.id} value={area.id}>
                    {area.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <TabsContent value="prompts">
            {(wf.error || actionError) && (
              <p className="mb-3 text-xs text-destructive">{wf.error || actionError}</p>
            )}
            {wf.loading ? (
              <LoadingState>Loading library…</LoadingState>
            ) : filteredWorkflows.length === 0 ? (
              <EmptyState>
                <EmptyStateTitle>No workflows in this practice area</EmptyStateTitle>
                <EmptyStateDescription>
                  Pick a different filter, or create one from the top-right.
                </EmptyStateDescription>
              </EmptyState>
            ) : (
              <>
                <div className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {pagedWorkflows.map((workflow) => {
                    const isUser = workflow.source === 'user';
                    return (
                      <div key={workflow.id} className="group relative h-full">
                        <PromptCard
                          onClick={() => openInAssistant(workflow)}
                        >
                          <PromptCardTitle>{workflow.name}</PromptCardTitle>
                          <PromptCardDescription>
                            {workflow.description}
                          </PromptCardDescription>
                          <PromptCardTags>
                            {isUser && (
                              <PromptCardTag className="bg-foreground text-background">
                                Saved
                              </PromptCardTag>
                            )}
                            {workflow.practiceAreas.map((id) => (
                              <PromptCardTag key={id}>
                                {practiceAreaLabel(id)}
                              </PromptCardTag>
                            ))}
                          </PromptCardTags>
                        </PromptCard>
                        <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100">
                          <span onClick={(e) => e.stopPropagation()}>
                            <RowActions
                              triggerLabel={`Actions for ${workflow.name}`}
                              actions={
                                isUser
                                  ? [
                                      {
                                        id: 'edit',
                                        label: 'Edit',
                                        icon: Pencil,
                                        onSelect: () => setEditing(workflow),
                                      },
                                      {
                                        id: 'history',
                                        label: 'History',
                                        icon: History,
                                        onSelect: () => setHistoryFor(workflow),
                                      },
                                      {
                                        id: 'share',
                                        label: 'Share',
                                        icon: Users,
                                        onSelect: () => setSharing(workflow),
                                      },
                                      {
                                        id: 'delete',
                                        label: 'Delete',
                                        icon: Trash2,
                                        destructive: true,
                                        separatorBefore: true,
                                        onSelect: () => void handleDelete(workflow),
                                      },
                                    ]
                                  : [
                                      {
                                        id: 'hide',
                                        label: 'Hide from library',
                                        icon: EyeOff,
                                        onSelect: () => void handleHide(workflow),
                                      },
                                    ]
                              }
                            />
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {totalPages > 1 && (
                  <div className="mt-6 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <div>
                      Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredWorkflows.length)} of{' '}
                      {filteredWorkflows.length}
                    </div>
                    <Pagination
                      currentPage={currentPage}
                      totalPages={totalPages}
                      onPageChange={setPage}
                      size="sm"
                    />
                  </div>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="background">
            <EmptyState>
              <EmptyStateTitle>Background jobs — coming soon</EmptyStateTitle>
              <EmptyStateDescription>
                Long-running, multi-document workflows (deal-folder change-of-control extraction across dozens of contracts, litigation timeline build-outs from full case files, etc.) will run from this tab as background jobs. The Workflows tab covers single-document and single-turn agentic flows — those are all live today.
              </EmptyStateDescription>
            </EmptyState>
          </TabsContent>
        </Tabs>
      </AppShellContent>

      <WorkflowFormDialog
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={async (input) => {
          await wf.create(input);
        }}
      />
      <WorkflowFormDialog
        mode="edit"
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        initial={editing}
        onUpdate={async (id, patch) => {
          await wf.update(id, patch);
          setEditing(null);
        }}
      />
      <ShareDialog
        open={sharing !== null}
        onOpenChange={(open) => {
          if (!open) setSharing(null);
        }}
        subject={sharing ? { type: 'workflow', id: sharing.id } : null}
        subjectName={sharing?.name ?? ''}
        subjectNoun="workflow"
      />
      <WorkflowHistoryDialog
        open={historyFor !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryFor(null);
        }}
        workflow={historyFor}
        onRestored={() => {
          // The list cache holds the pre-restore name/prompt — refresh to
          // pick up the post-restore live row.
          void wf.refresh();
        }}
      />
    </>
  );
}
