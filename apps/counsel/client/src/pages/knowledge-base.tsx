import { useRef, useState } from 'react';
import {
  AppShellContent,
  Button,
  EmptyState,
  EmptyStateDescription,
  EmptyStateTitle,
  Input,
  LoadingState,
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
  PendingButton,
  Plus,
  Trash2,
  cn,
  humanSize,
  useConfirm,
} from '@teamsuzie/ui';
import {
  useKnowledgeBase,
  type KbDocument,
  type KbSearchHit,
} from '../hooks/use-knowledge-base.js';

export function KnowledgeBasePage() {
  const kb = useKnowledgeBase();
  const confirm = useConfirm();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KbSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadError('');
    try {
      for (const file of Array.from(files)) {
        await kb.upload(file);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleSearch(event?: React.FormEvent) {
    event?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setSearchError('');
    try {
      const results = await kb.search(query.trim(), 8);
      setHits(results);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed');
      setHits(null);
    } finally {
      setSearching(false);
    }
  }

  async function handleDelete(doc: KbDocument) {
    if (
      !(await confirm({
        title: `Delete "${doc.name}"?`,
        description:
          'Removes the document from the knowledge base. The agent will no longer return chunks from it.',
        confirmLabel: 'Delete document',
        variant: 'destructive',
      }))
    ) {
      return;
    }
    setDeleteError('');
    try {
      await kb.remove(doc.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <>
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Knowledge Base</PageHeaderTitle>
          <PageHeaderDescription>
            {kb.stats.documents} document{kb.stats.documents === 1 ? '' : 's'} ·{' '}
            {kb.stats.chunks} chunk{kb.stats.chunks === 1 ? '' : 's'} indexed. The agent
            searches this when answering questions via the <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">kb_search</code> tool.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleUpload(e.target.files);
              e.target.value = '';
            }}
          />
          <PendingButton
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            pending={uploading}
            pendingLabel="Indexing"
          >
            <Plus className="size-4" aria-hidden />
            Add documents
          </PendingButton>
        </PageHeaderActions>
      </PageHeader>

      <AppShellContent className="px-6 pt-6 pb-12">
        {(uploadError || kb.error || deleteError) && (
          <p className="mb-4 text-xs text-destructive">
            {uploadError || kb.error || deleteError}
          </p>
        )}

        <section className="mb-8">
          <h2 className="mb-2 text-sm font-medium text-foreground">Search</h2>
          <form onSubmit={handleSearch} className="flex gap-2">
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask a question — semantic search across your indexed docs"
              className="flex-1"
            />
            <PendingButton
              type="submit"
              size="sm"
              disabled={!query.trim()}
              pending={searching}
              pendingLabel="Searching"
            >
              Search
            </PendingButton>
          </form>
          {searchError && <p className="mt-2 text-xs text-destructive">{searchError}</p>}

          {hits !== null && (
            <div className="mt-4 space-y-2">
              {hits.length === 0 ? (
                <p className="text-xs text-muted-foreground">No matches.</p>
              ) : (
                hits.map((hit, i) => (
                  <div
                    key={`${hit.document.id}-${hit.chunk.id}`}
                    className="rounded-lg border border-border bg-card p-3 text-sm"
                  >
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {i + 1}. {hit.document.name}
                      </span>
                      <span>
                        chunk #{hit.chunk.chunkIndex}
                        {typeof hit.distance === 'number' && (
                          <> · distance {hit.distance.toFixed(3)}</>
                        )}
                      </span>
                    </div>
                    <p className="line-clamp-4 whitespace-pre-wrap text-foreground/90">
                      {hit.chunk.content}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium text-foreground">Indexed documents</h2>
          {kb.loading ? (
            <LoadingState>Loading documents…</LoadingState>
          ) : kb.documents.length === 0 ? (
            <EmptyState>
              <EmptyStateTitle>No documents yet</EmptyStateTitle>
              <EmptyStateDescription>
                Click "Add documents" to upload DOCX, PDF, Markdown, or text files. They're
                converted to markdown, chunked, embedded, and made searchable.
              </EmptyStateDescription>
            </EmptyState>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border bg-card">
              {kb.documents.map((doc) => (
                <div
                  key={doc.id}
                  className={cn('flex items-center justify-between gap-3 px-4 py-3 text-sm')}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">{doc.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {humanSize(doc.size)} · {doc.chunkCount} chunk
                      {doc.chunkCount === 1 ? '' : 's'} · {new Date(doc.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => void handleDelete(doc)}
                    className="size-8 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Delete ${doc.name}`}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      </AppShellContent>
    </>
  );
}
