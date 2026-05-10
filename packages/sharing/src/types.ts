import type { Generated } from 'kysely';

export type Role = 'owner' | 'editor' | 'viewer';

export const ROLES: readonly Role[] = ['owner', 'editor', 'viewer'] as const;

/** Strength ordering — higher beats lower in `canAccess`. */
export const ROLE_RANK: Record<Role, number> = {
  owner: 3,
  editor: 2,
  viewer: 1,
};

export interface SubjectRef {
  type: string;
  id: string;
}

export interface Member {
  id: string;
  subjectType: string;
  subjectId: string;
  userId: string;
  role: Role;
  grantedAt: Date;
  grantedBy: string | null;
}

export interface AddMemberInput {
  subjectType: string;
  subjectId: string;
  userId: string;
  role: Role;
  grantedBy?: string | null;
}

export type OwnerLookup = (
  subject: SubjectRef,
) => string | null | Promise<string | null>;

// Kysely table types.

export interface MembersTable {
  id: string;
  subject_type: string;
  subject_id: string;
  user_id: string;
  role: Role;
  granted_at: Generated<Date>;
  granted_by: string | null;
}

export interface SharingDB {
  members: MembersTable;
}
