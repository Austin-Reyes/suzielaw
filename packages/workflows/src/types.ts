import type { ColumnType, Generated } from 'kysely';

export type WorkflowSource = 'system' | 'user';
export type WorkflowOutputMode = 'inline_chat' | 'generate_docx' | 'tabular_review';

export const WORKFLOW_OUTPUT_MODES: readonly WorkflowOutputMode[] = [
  'inline_chat',
  'generate_docx',
  'tabular_review',
];

export interface WorkflowColumnConfig {
  title: string;
  prompt: string;
  format: string;
}

export interface Workflow {
  id: string;
  source: WorkflowSource;
  ownerId: string | null;
  name: string;
  description: string;
  prompt: string;
  practiceAreas: string[];
  columnConfig: WorkflowColumnConfig[] | null;
  outputMode: WorkflowOutputMode;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface CreateUserWorkflowInput {
  ownerId: string;
  name: string;
  description?: string;
  prompt: string;
  practiceAreas?: string[];
  columnConfig?: WorkflowColumnConfig[] | null;
  outputMode?: WorkflowOutputMode;
}

export interface UpsertSystemWorkflowInput {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  practiceAreas?: string[];
  columnConfig?: WorkflowColumnConfig[] | null;
  outputMode?: WorkflowOutputMode;
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  prompt?: string;
  practiceAreas?: string[];
  /** Tri-state: undefined → leave, null → clear, array → replace. */
  columnConfig?: WorkflowColumnConfig[] | null;
  outputMode?: WorkflowOutputMode;
}

export interface ListWorkflowsOptions {
  ownerId: string;
  includeArchived?: boolean;
}

export type WorkflowVersionReason = 'update' | 'restore';

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  name: string;
  description: string;
  prompt: string;
  practiceAreas: string[];
  columnConfig: WorkflowColumnConfig[] | null;
  outputMode: WorkflowOutputMode;
  capturedAt: Date;
  capturedBy: string | null;
  reason: WorkflowVersionReason;
}

// Kysely table types.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface WorkflowsTable {
  id: string;
  source: WorkflowSource;
  owner_id: string | null;
  name: string;
  description: Generated<string>;
  prompt: string;
  // Insert/update accept JSON-stringified array.
  practice_areas: ColumnType<string[], string, string>;
  column_config: ColumnType<WorkflowColumnConfig[] | null, string | null, string | null>;
  output_mode: Generated<WorkflowOutputMode>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  archived_at: Timestamp | null;
}

export interface WorkflowHidesTable {
  workflow_id: string;
  owner_id: string;
  hidden_at: Generated<Date>;
}

export interface WorkflowVersionsTable {
  id: string;
  workflow_id: string;
  name: string;
  description: Generated<string>;
  prompt: string;
  practice_areas: ColumnType<string[], string, string>;
  column_config: ColumnType<WorkflowColumnConfig[] | null, string | null, string | null>;
  output_mode: WorkflowOutputMode;
  captured_at: Generated<Date>;
  captured_by: string | null;
  reason: WorkflowVersionReason;
}

export interface WorkflowsDB {
  workflows: WorkflowsTable;
  workflow_hides: WorkflowHidesTable;
  workflow_versions: WorkflowVersionsTable;
}
