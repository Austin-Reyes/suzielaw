import { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';

import type {
  AuditDB,
  AuditEvent,
  AuditRow,
  QueryAuditLogOptions,
} from './types.js';
import { AUDIT_EVENTS } from './types.js';

export interface AuditStoreOptions<TDB extends AuditDB> {
  db: Kysely<TDB>;
  idFactory?: () => string;
}

const VALID_EVENTS = new Set<string>(AUDIT_EVENTS);

export class AuditStore<TDB extends AuditDB = AuditDB> {
  private readonly db: Kysely<TDB>;
  private readonly newId: () => string;

  constructor(opts: AuditStoreOptions<TDB>) {
    this.db = opts.db;
    this.newId = opts.idFactory ?? uuidv7;
  }

  /**
   * Append-only write. Failures are warning-only so the user-facing request
   * never depends on the audit pipeline being healthy.
   */
  async log(event: AuditEvent): Promise<boolean> {
    try {
      if (!VALID_EVENTS.has(event.event)) {
        throw new Error(`invalid audit event: ${event.event}`);
      }
      const metadata = normalizeMetadata(event.metadata);
      await this.auditDb()
        .insertInto('audit_log')
        .values({
          id: this.newId(),
          actor_email: event.actorEmail,
          actor_name: event.actorName ?? null,
          event: event.event,
          subject_type: event.subjectType ?? null,
          subject_id: event.subjectId ?? null,
          metadata,
          ip_address: event.ipAddress ?? null,
          user_agent: truncate(event.userAgent, 200),
        })
        .execute();
      return true;
    } catch (err) {
      console.warn(
        '[audit] log failed:',
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  async query(opts: QueryAuditLogOptions = {}): Promise<AuditRow[]> {
    const limit = clampLimit(opts.limit);
    let q = this.auditDb().selectFrom('audit_log').selectAll();

    if (opts.actorEmail) q = q.where('actor_email', '=', opts.actorEmail);
    if (opts.event) q = q.where('event', '=', opts.event);
    if (opts.subjectType) q = q.where('subject_type', '=', opts.subjectType);
    if (opts.subjectId) q = q.where('subject_id', '=', opts.subjectId);
    if (opts.since) q = q.where('at', '>=', opts.since);
    if (opts.until) q = q.where('at', '<=', opts.until);

    const rows = await q.orderBy('at', 'desc').limit(limit).execute();
    return rows.map(rowToAuditRow);
  }

  private auditDb(): Kysely<AuditDB> {
    return this.db as unknown as Kysely<AuditDB>;
  }
}

function normalizeMetadata(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (value == null) return null;
  JSON.stringify(value);
  return value;
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 200;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

interface AuditLogRow {
  id: string;
  at: Date;
  actor_email: string;
  actor_name: string | null;
  event: string;
  subject_type: string | null;
  subject_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
}

function rowToAuditRow(row: AuditLogRow): AuditRow {
  return {
    id: row.id,
    at: row.at,
    actorEmail: row.actor_email,
    actorName: row.actor_name,
    event: row.event,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    metadata: row.metadata,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  };
}
