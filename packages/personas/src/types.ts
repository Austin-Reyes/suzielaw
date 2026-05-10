import type { ColumnType, Generated } from 'kysely';

export type PersonaSource = 'builtin' | 'user';

export interface Persona {
  id: string;
  source: PersonaSource;
  name: string;
  description: string;
  avatar?: string;
  model?: string;
  allowedTools?: string[];
  blockedTools?: string[];
  systemPrompt: string;
  ownerId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PersonaCreateInput {
  ownerId: string;
  name: string;
  description: string;
  avatar?: string;
  model?: string;
  allowedTools?: string[];
  blockedTools?: string[];
  systemPrompt: string;
}

export interface PersonaUpdateInput {
  name?: string;
  description?: string;
  avatar?: string | null;
  model?: string | null;
  allowedTools?: string[] | null;
  blockedTools?: string[] | null;
  systemPrompt?: string;
}

// Kysely table types.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface PersonasTable {
  id: string;
  owner_id: string;
  name: string;
  description: Generated<string>;
  avatar: string | null;
  model: string | null;
  // Insert/update accept JSON-stringified array. Read shape is parsed array.
  allowed_tools: ColumnType<string[] | null, string | null, string | null>;
  blocked_tools: ColumnType<string[] | null, string | null, string | null>;
  system_prompt: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  deleted_at: Timestamp | null;
}

export interface PersonasSeededTable {
  owner_id: string;
  seeded_at: Generated<Date>;
}

export interface PersonasDB {
  personas: PersonasTable;
  personas_seeded: PersonasSeededTable;
}
