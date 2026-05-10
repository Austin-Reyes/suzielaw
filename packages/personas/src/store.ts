import { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type {
  Persona,
  PersonaCreateInput,
  PersonaUpdateInput,
  PersonasDB,
} from './types.js';

export interface PersonaStoreOptions<TDB extends PersonasDB> {
  db: Kysely<TDB>;
  idFactory?: () => string;
}

export class PersonaStore<TDB extends PersonasDB = PersonasDB> {
  private readonly db: Kysely<TDB>;
  private readonly newId: () => string;

  constructor(opts: PersonaStoreOptions<TDB>) {
    this.db = opts.db;
    this.newId = opts.idFactory ?? uuidv7;
  }

  async list(
    ownerId: string,
    opts?: { limit?: number; offset?: number; q?: string },
  ): Promise<Persona[]> {
    const limit = opts?.limit;
    const offset = opts?.offset ?? 0;
    const q = opts?.q?.trim();

    let qb = this.kbDb()
      .selectFrom('personas')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null);

    if (q) {
      const like = `%${q}%`;
      qb = qb.where((eb) =>
        eb.or([eb('name', 'ilike', like), eb('description', 'ilike', like)]),
      );
    }
    qb = qb.orderBy('name', 'asc');
    if (limit !== undefined) qb = qb.limit(limit).offset(offset);

    const rows = await qb.execute();
    return rows.map(rowToPersona);
  }

  async count(ownerId: string, opts?: { q?: string }): Promise<number> {
    let qb = this.kbDb()
      .selectFrom('personas')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null);
    const q = opts?.q?.trim();
    if (q) {
      const like = `%${q}%`;
      qb = qb.where((eb) =>
        eb.or([eb('name', 'ilike', like), eb('description', 'ilike', like)]),
      );
    }
    const row = await qb.executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async get(id: string, ownerId: string): Promise<Persona | null> {
    const row = await this.kbDb()
      .selectFrom('personas')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? rowToPersona(row) : null;
  }

  async create(input: PersonaCreateInput): Promise<Persona> {
    const id = this.newId();
    await this.kbDb()
      .insertInto('personas')
      .values({
        id,
        owner_id: input.ownerId,
        name: input.name,
        description: input.description,
        avatar: input.avatar ?? null,
        model: input.model ?? null,
        allowed_tools: input.allowedTools ? JSON.stringify(input.allowedTools) : null,
        blocked_tools: input.blockedTools ? JSON.stringify(input.blockedTools) : null,
        system_prompt: input.systemPrompt,
      })
      .execute();
    return (await this.get(id, input.ownerId))!;
  }

  async update(
    id: string,
    ownerId: string,
    patch: PersonaUpdateInput,
  ): Promise<Persona | null> {
    // Tri-state semantics for nullable fields: undefined = leave alone,
    // null = clear, value = set.
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.avatar !== undefined) set.avatar = patch.avatar;
    if (patch.model !== undefined) set.model = patch.model;
    if ('allowedTools' in patch) {
      set.allowed_tools = patch.allowedTools ? JSON.stringify(patch.allowedTools) : null;
    }
    if ('blockedTools' in patch) {
      set.blocked_tools = patch.blockedTools ? JSON.stringify(patch.blockedTools) : null;
    }
    if (patch.systemPrompt !== undefined) set.system_prompt = patch.systemPrompt;

    if (Object.keys(set).length === 0) return this.get(id, ownerId);

    const result = await this.kbDb()
      .updateTable('personas')
      .set(set)
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return null;
    return this.get(id, ownerId);
  }

  /** Soft-delete. Returns true if a row was hidden. */
  async delete(id: string, ownerId: string): Promise<boolean> {
    const result = await this.kbDb()
      .updateTable('personas')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  // --- Seed tracker ------------------------------------------------------

  async hasBeenSeeded(ownerId: string): Promise<boolean> {
    const row = await this.kbDb()
      .selectFrom('personas_seeded')
      .select('owner_id')
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row != null;
  }

  async markSeeded(ownerId: string): Promise<void> {
    await this.kbDb()
      .insertInto('personas_seeded')
      .values({ owner_id: ownerId })
      .onConflict((oc) => oc.column('owner_id').doNothing())
      .execute();
  }

  private kbDb(): Kysely<PersonasDB> {
    return this.db as unknown as Kysely<PersonasDB>;
  }
}

interface DbRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  avatar: string | null;
  model: string | null;
  allowed_tools: string[] | null;
  blocked_tools: string[] | null;
  system_prompt: string;
  created_at: Date;
  updated_at: Date;
}

function rowToPersona(row: DbRow): Persona {
  const persona: Persona = {
    id: row.id,
    source: 'user',
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.avatar) persona.avatar = row.avatar;
  if (row.model) persona.model = row.model;
  if (row.allowed_tools) persona.allowedTools = row.allowed_tools;
  if (row.blocked_tools) persona.blockedTools = row.blocked_tools;
  return persona;
}
