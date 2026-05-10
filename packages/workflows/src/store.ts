import { Kysely, sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type {
  CreateUserWorkflowInput,
  ListWorkflowsOptions,
  UpdateWorkflowInput,
  UpsertSystemWorkflowInput,
  Workflow,
  WorkflowColumnConfig,
  WorkflowOutputMode,
  WorkflowSource,
  WorkflowVersion,
  WorkflowVersionReason,
  WorkflowsDB,
} from './types.js';
import { WORKFLOW_OUTPUT_MODES } from './types.js';

function normalizeOutputMode(
  raw: WorkflowOutputMode | undefined,
  hasColumnConfig: boolean,
): WorkflowOutputMode {
  if (raw && WORKFLOW_OUTPUT_MODES.includes(raw)) return raw;
  return hasColumnConfig ? 'tabular_review' : 'inline_chat';
}

export interface WorkflowsStoreOptions<TDB extends WorkflowsDB> {
  db: Kysely<TDB>;
  idFactory?: () => string;
}

export class WorkflowsStore<TDB extends WorkflowsDB = WorkflowsDB> {
  private readonly db: Kysely<TDB>;
  private readonly newId: () => string;

  constructor(opts: WorkflowsStoreOptions<TDB>) {
    this.db = opts.db;
    this.newId = opts.idFactory ?? uuidv7;
  }

  // --- System (seeded) rows --------------------------------------------

  async upsertSystem(input: UpsertSystemWorkflowInput): Promise<Workflow> {
    const description = input.description ?? '';
    const practiceAreas = JSON.stringify(input.practiceAreas ?? []);
    const columnConfig =
      input.columnConfig === undefined || input.columnConfig === null
        ? null
        : JSON.stringify(input.columnConfig);
    const outputMode = normalizeOutputMode(input.outputMode, columnConfig !== null);

    await this.kbDb()
      .insertInto('workflows')
      .values({
        id: input.id,
        source: 'system',
        owner_id: null,
        name: input.name,
        description,
        prompt: input.prompt,
        practice_areas: practiceAreas,
        column_config: columnConfig,
        output_mode: outputMode,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          name: input.name,
          description,
          prompt: input.prompt,
          practice_areas: practiceAreas,
          column_config: columnConfig,
          output_mode: outputMode,
          updated_at: sql`now()`,
        }),
      )
      .execute();
    return (await this.get(input.id))!;
  }

  /**
   * Bulk seed: upsert each input AND drop any system rows whose id isn't
   * in the incoming set. Use at app startup — code is the source of truth
   * for system workflows.
   */
  async seedSystem(
    inputs: UpsertSystemWorkflowInput[],
  ): Promise<{ upserted: number; removed: number }> {
    const idSet = new Set(inputs.map((i) => i.id));
    return this.kbDb().transaction().execute(async (trx) => {
      const txDb = trx as unknown as Kysely<WorkflowsDB>;
      // Need a transactional version of upsertSystem; inline the SQL to
      // avoid spawning new connections inside the trx.
      for (const input of inputs) {
        const description = input.description ?? '';
        const practiceAreas = JSON.stringify(input.practiceAreas ?? []);
        const columnConfig =
          input.columnConfig === undefined || input.columnConfig === null
            ? null
            : JSON.stringify(input.columnConfig);
        const outputMode = normalizeOutputMode(input.outputMode, columnConfig !== null);
        await txDb
          .insertInto('workflows')
          .values({
            id: input.id,
            source: 'system',
            owner_id: null,
            name: input.name,
            description,
            prompt: input.prompt,
            practice_areas: practiceAreas,
            column_config: columnConfig,
            output_mode: outputMode,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              name: input.name,
              description,
              prompt: input.prompt,
              practice_areas: practiceAreas,
              column_config: columnConfig,
              output_mode: outputMode,
              updated_at: sql`now()`,
            }),
          )
          .execute();
      }

      const stale = await txDb
        .selectFrom('workflows')
        .select('id')
        .where('source', '=', 'system')
        .execute();
      const staleIds = stale.map((r) => r.id).filter((id) => !idSet.has(id));
      let removed = 0;
      if (staleIds.length > 0) {
        const result = await txDb
          .deleteFrom('workflows')
          .where('source', '=', 'system')
          .where('id', 'in', staleIds)
          .executeTakeFirst();
        removed = Number(result.numDeletedRows ?? 0);
      }
      return { upserted: inputs.length, removed };
    });
  }

  // --- User rows --------------------------------------------------------

  async createUserWorkflow(input: CreateUserWorkflowInput): Promise<Workflow> {
    const id = this.newId();
    const columnConfig =
      input.columnConfig === undefined || input.columnConfig === null
        ? null
        : JSON.stringify(input.columnConfig);
    const outputMode = normalizeOutputMode(input.outputMode, columnConfig !== null);
    await this.kbDb()
      .insertInto('workflows')
      .values({
        id,
        source: 'user',
        owner_id: input.ownerId,
        name: input.name,
        description: input.description ?? '',
        prompt: input.prompt,
        practice_areas: JSON.stringify(input.practiceAreas ?? []),
        column_config: columnConfig,
        output_mode: outputMode,
      })
      .execute();
    return (await this.get(id))!;
  }

  async updateUserWorkflow(
    id: string,
    ownerId: string,
    patch: UpdateWorkflowInput,
    capturedBy?: string | null,
  ): Promise<Workflow | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    if (existing.source !== 'user' || existing.ownerId !== ownerId) return null;

    const nextColumnConfigJson =
      patch.columnConfig === undefined
        ? existing.columnConfig === null
          ? null
          : JSON.stringify(existing.columnConfig)
        : patch.columnConfig === null
          ? null
          : JSON.stringify(patch.columnConfig);
    const nextOutputMode: WorkflowOutputMode =
      patch.outputMode && WORKFLOW_OUTPUT_MODES.includes(patch.outputMode)
        ? patch.outputMode
        : existing.outputMode;
    const next = {
      name: patch.name?.trim() || existing.name,
      description: patch.description ?? existing.description,
      prompt: patch.prompt ?? existing.prompt,
      practice_areas: patch.practiceAreas
        ? JSON.stringify(patch.practiceAreas)
        : JSON.stringify(existing.practiceAreas),
      column_config: nextColumnConfigJson,
      output_mode: nextOutputMode,
    };

    await this.kbDb().transaction().execute(async (trx) => {
      const txDb = trx as unknown as Kysely<WorkflowsDB>;
      await this.insertVersionFromExisting(txDb, existing, capturedBy ?? null, 'update');
      await txDb
        .updateTable('workflows')
        .set(next)
        .where('id', '=', id)
        .execute();
    });
    return this.get(id);
  }

  // --- Versioning -------------------------------------------------------

  async listVersions(id: string, ownerId: string): Promise<WorkflowVersion[]> {
    const existing = await this.get(id);
    if (!existing) return [];
    if (existing.source !== 'user' || existing.ownerId !== ownerId) return [];
    const rows = await this.kbDb()
      .selectFrom('workflow_versions')
      .selectAll()
      .where('workflow_id', '=', id)
      .orderBy('captured_at', 'desc')
      // Tiebreaker for snapshots written in the same instant: insertion
      // order via uuidv7 monotonicity.
      .orderBy('id', 'desc')
      .execute();
    return rows.map(rowToVersion);
  }

  async restoreVersion(
    workflowId: string,
    versionId: string,
    ownerId: string,
    capturedBy?: string | null,
  ): Promise<Workflow | null> {
    const existing = await this.get(workflowId);
    if (!existing) return null;
    if (existing.source !== 'user' || existing.ownerId !== ownerId) return null;

    const versionRow = await this.kbDb()
      .selectFrom('workflow_versions')
      .selectAll()
      .where('id', '=', versionId)
      .where('workflow_id', '=', workflowId)
      .executeTakeFirst();
    if (!versionRow) return null;

    await this.kbDb().transaction().execute(async (trx) => {
      const txDb = trx as unknown as Kysely<WorkflowsDB>;
      await this.insertVersionFromExisting(txDb, existing, capturedBy ?? null, 'restore');
      // Note: practice_areas + column_config in versionRow come back as
      // already-parsed JS values from pg. We re-stringify because the
      // workflows column types expect a string on insert/update.
      await txDb
        .updateTable('workflows')
        .set({
          name: versionRow.name,
          description: versionRow.description,
          prompt: versionRow.prompt,
          practice_areas: JSON.stringify(versionRow.practice_areas),
          column_config:
            versionRow.column_config === null ? null : JSON.stringify(versionRow.column_config),
          output_mode: versionRow.output_mode,
        })
        .where('id', '=', workflowId)
        .execute();
    });
    return this.get(workflowId);
  }

  private async insertVersionFromExisting(
    txDb: Kysely<WorkflowsDB>,
    existing: Workflow,
    capturedBy: string | null,
    reason: WorkflowVersionReason,
  ): Promise<void> {
    await txDb
      .insertInto('workflow_versions')
      .values({
        id: this.newId(),
        workflow_id: existing.id,
        name: existing.name,
        description: existing.description,
        prompt: existing.prompt,
        practice_areas: JSON.stringify(existing.practiceAreas),
        column_config:
          existing.columnConfig === null ? null : JSON.stringify(existing.columnConfig),
        output_mode: existing.outputMode,
        captured_by: capturedBy,
        reason,
      })
      .execute();
  }

  async archive(id: string, ownerId: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    if (existing.source !== 'user' || existing.ownerId !== ownerId) return false;
    await this.kbDb()
      .updateTable('workflows')
      .set({ archived_at: new Date() })
      .where('id', '=', id)
      .execute();
    return true;
  }

  async unarchive(id: string, ownerId: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    if (existing.source !== 'user' || existing.ownerId !== ownerId) return false;
    await this.kbDb()
      .updateTable('workflows')
      .set({ archived_at: null })
      .where('id', '=', id)
      .execute();
    return true;
  }

  async deleteUserWorkflow(id: string, ownerId: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    if (existing.source !== 'user' || existing.ownerId !== ownerId) return false;
    const result = await this.kbDb()
      .deleteFrom('workflows')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  // --- Hides ------------------------------------------------------------

  async hide(id: string, ownerId: string): Promise<void> {
    await this.kbDb()
      .insertInto('workflow_hides')
      .values({ workflow_id: id, owner_id: ownerId })
      .onConflict((oc) => oc.columns(['workflow_id', 'owner_id']).doNothing())
      .execute();
  }

  async unhide(id: string, ownerId: string): Promise<boolean> {
    const result = await this.kbDb()
      .deleteFrom('workflow_hides')
      .where('workflow_id', '=', id)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async listHiddenIds(ownerId: string): Promise<string[]> {
    const rows = await this.kbDb()
      .selectFrom('workflow_hides as h')
      .innerJoin('workflows as w', 'w.id', 'h.workflow_id')
      .select('h.workflow_id')
      .where('h.owner_id', '=', ownerId)
      .execute();
    return rows.map((r) => r.workflow_id);
  }

  // --- Reads ------------------------------------------------------------

  async get(id: string): Promise<Workflow | null> {
    const row = await this.kbDb()
      .selectFrom('workflows')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToWorkflow(row) : null;
  }

  /**
   * Workflows visible to ownerId: every system row not hidden by this
   * user, plus every user row owned by this user.
   */
  async listVisible(opts: ListWorkflowsOptions): Promise<Workflow[]> {
    let qb = this.kbDb()
      .selectFrom('workflows as w')
      .selectAll('w')
      .where((eb) =>
        eb.or([
          eb.and([
            eb('w.source', '=', 'system'),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('workflow_hides as h')
                  .select(eb.lit(1).as('one'))
                  .whereRef('h.workflow_id', '=', 'w.id')
                  .where('h.owner_id', '=', opts.ownerId),
              ),
            ),
          ]),
          eb.and([eb('w.source', '=', 'user'), eb('w.owner_id', '=', opts.ownerId)]),
        ]),
      );
    if (!opts.includeArchived) qb = qb.where('w.archived_at', 'is', null);
    qb = qb.orderBy('w.source', 'asc').orderBy('w.name', 'asc');
    const rows = await qb.execute();
    return rows.map(rowToWorkflow);
  }

  async listBySource(source: WorkflowSource): Promise<Workflow[]> {
    const rows = await this.kbDb()
      .selectFrom('workflows')
      .selectAll()
      .where('source', '=', source)
      .orderBy('name', 'asc')
      .execute();
    return rows.map(rowToWorkflow);
  }

  private kbDb(): Kysely<WorkflowsDB> {
    return this.db as unknown as Kysely<WorkflowsDB>;
  }
}

interface WorkflowRow {
  id: string;
  source: WorkflowSource;
  owner_id: string | null;
  name: string;
  description: string;
  prompt: string;
  practice_areas: unknown; // jsonb returned as parsed JS
  column_config: unknown;
  output_mode: WorkflowOutputMode;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

interface VersionRow {
  id: string;
  workflow_id: string;
  name: string;
  description: string;
  prompt: string;
  practice_areas: unknown;
  column_config: unknown;
  output_mode: WorkflowOutputMode;
  captured_at: Date;
  captured_by: string | null;
  reason: WorkflowVersionReason;
}

function coercePracticeAreas(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  return [];
}

function coerceColumnConfig(raw: unknown): WorkflowColumnConfig[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (x): x is WorkflowColumnConfig =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as WorkflowColumnConfig).title === 'string' &&
      typeof (x as WorkflowColumnConfig).prompt === 'string' &&
      typeof (x as WorkflowColumnConfig).format === 'string',
  );
}

function rowToWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    source: row.source,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    practiceAreas: coercePracticeAreas(row.practice_areas),
    columnConfig: coerceColumnConfig(row.column_config),
    outputMode: row.output_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function rowToVersion(row: VersionRow): WorkflowVersion {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    practiceAreas: coercePracticeAreas(row.practice_areas),
    columnConfig: coerceColumnConfig(row.column_config),
    outputMode: row.output_mode,
    capturedAt: row.captured_at,
    capturedBy: row.captured_by,
    reason: row.reason,
  };
}
