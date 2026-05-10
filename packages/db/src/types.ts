import type { ColumnType, Generated } from 'kysely';

export interface DbMetadataTable {
  key: string;
  value: ColumnType<unknown, unknown, unknown>;
  updated_at: Generated<Date>;
}

export interface AppAuditLogTable {
  id: string;
  at: Generated<Date>;
  actor_id: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  request_id: string | null;
  ip: string | null;
  route: string | null;
  reason: string | null;
}

export interface DB {
  db_metadata: DbMetadataTable;
  app_audit_log: AppAuditLogTable;
}
