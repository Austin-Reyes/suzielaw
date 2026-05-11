import type { ColumnType, Generated } from 'kysely';

type JsonObject = Record<string, unknown>;

export const AUDIT_EVENTS = [
  'auth.login',
  'auth.logout',
  'matter.create',
  'matter.open',
  'matter.delete',
  'file.upload',
  'file.download',
  'file.delete',
  'zip.upload',
  'zip.upload.error',
  'chat.create',
  'chat.message',
  'export.docx',
] as const;

export type AuditEventName = (typeof AUDIT_EVENTS)[number];

export interface AuditEvent {
  actorEmail: string;
  actorName?: string | null;
  event: string;
  subjectType?: string | null;
  subjectId?: string | null;
  metadata?: JsonObject | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditRow extends AuditEvent {
  id: string;
  at: Date;
  event: AuditEventName | string;
  actorName: string | null;
  subjectType: string | null;
  subjectId: string | null;
  metadata: JsonObject | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface QueryAuditLogOptions {
  actorEmail?: string;
  event?: string;
  subjectType?: string;
  subjectId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export interface AuditLogTable {
  id: string;
  at: Generated<Date>;
  actor_email: string;
  actor_name: string | null;
  event: string;
  subject_type: string | null;
  subject_id: string | null;
  metadata: ColumnType<JsonObject | null, JsonObject | null | undefined, JsonObject | null>;
  ip_address: string | null;
  user_agent: string | null;
}

export interface AuditDB {
  audit_log: AuditLogTable;
}
