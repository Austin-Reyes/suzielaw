import { Kysely, sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type {
  AddMemberInput,
  Member,
  OwnerLookup,
  Role,
  SharingDB,
  SubjectRef,
} from './types.js';
import { ROLE_RANK, ROLES } from './types.js';

export interface MembersStoreOptions<TDB extends SharingDB> {
  db: Kysely<TDB>;
  idFactory?: () => string;
}

/**
 * Membership grants over opaque (subject_type, subject_id) pairs. Hosts
 * call removeMembersFor when a subject is deleted (no FK across packages).
 */
export class MembersStore<TDB extends SharingDB = SharingDB> {
  private readonly db: Kysely<TDB>;
  private readonly newId: () => string;

  constructor(opts: MembersStoreOptions<TDB>) {
    this.db = opts.db;
    this.newId = opts.idFactory ?? uuidv7;
  }

  /** Upsert: re-granting refreshes role + granted_at + granted_by, keeps id. */
  async addMember(input: AddMemberInput): Promise<Member> {
    if (!ROLES.includes(input.role)) {
      throw new Error(`invalid role: ${input.role} (expected one of: ${ROLES.join(', ')})`);
    }

    // Use ON CONFLICT against the (subject_type, subject_id, user_id) unique
    // index — same atomic upsert as the upstream "find then update or insert".
    const id = this.newId();
    await this.kbDb()
      .insertInto('members')
      .values({
        id,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        user_id: input.userId,
        role: input.role,
        granted_by: input.grantedBy ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['subject_type', 'subject_id', 'user_id']).doUpdateSet({
          role: input.role,
          granted_at: sql`now()`,
          granted_by: input.grantedBy ?? null,
        }),
      )
      .execute();

    // Re-read to get the canonical id (which may differ from `id` if a row
    // already existed with a different id but same key).
    const row = await this.kbDb()
      .selectFrom('members')
      .selectAll()
      .where('subject_type', '=', input.subjectType)
      .where('subject_id', '=', input.subjectId)
      .where('user_id', '=', input.userId)
      .executeTakeFirst();
    return rowToMember(row!);
  }

  async getMember(id: string): Promise<Member | null> {
    const row = await this.kbDb()
      .selectFrom('members')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToMember(row) : null;
  }

  async removeMember(
    subjectType: string,
    subjectId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await this.kbDb()
      .deleteFrom('members')
      .where('subject_type', '=', subjectType)
      .where('subject_id', '=', subjectId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async removeMembersFor(subject: SubjectRef): Promise<number> {
    const result = await this.kbDb()
      .deleteFrom('members')
      .where('subject_type', '=', subject.type)
      .where('subject_id', '=', subject.id)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  async listMembersFor(subject: SubjectRef): Promise<Member[]> {
    const rows = await this.kbDb()
      .selectFrom('members')
      .selectAll()
      .where('subject_type', '=', subject.type)
      .where('subject_id', '=', subject.id)
      .orderBy('granted_at', 'asc')
      .execute();
    return rows.map(rowToMember);
  }

  async listSubjectsFor(userId: string, subjectType: string): Promise<Member[]> {
    const rows = await this.kbDb()
      .selectFrom('members')
      .selectAll()
      .where('user_id', '=', userId)
      .where('subject_type', '=', subjectType)
      .orderBy('granted_at', 'desc')
      .execute();
    return rows.map(rowToMember);
  }

  async getRole(subject: SubjectRef, userId: string): Promise<Role | null> {
    const row = await this.kbDb()
      .selectFrom('members')
      .select('role')
      .where('subject_type', '=', subject.type)
      .where('subject_id', '=', subject.id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? row.role : null;
  }

  /**
   * Strongest role across explicit grant + implicit owner-from-creation.
   * Returns null when the user has no access.
   */
  async canAccess(
    subject: SubjectRef,
    userId: string,
    ownerLookup?: OwnerLookup | null,
  ): Promise<Role | null> {
    const explicit = await this.getRole(subject, userId);
    if (explicit === 'owner') return 'owner';

    let implicit: Role | null = null;
    if (ownerLookup) {
      const ownerId = await ownerLookup(subject);
      if (ownerId && ownerId === userId) implicit = 'owner';
    }

    if (!explicit && !implicit) return null;
    if (!explicit) return implicit;
    if (!implicit) return explicit;
    return ROLE_RANK[explicit] >= ROLE_RANK[implicit] ? explicit : implicit;
  }

  private kbDb(): Kysely<SharingDB> {
    return this.db as unknown as Kysely<SharingDB>;
  }
}

interface MemberRow {
  id: string;
  subject_type: string;
  subject_id: string;
  user_id: string;
  role: Role;
  granted_at: Date;
  granted_by: string | null;
}

function rowToMember(row: MemberRow): Member {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    userId: row.user_id,
    role: row.role,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by,
  };
}
