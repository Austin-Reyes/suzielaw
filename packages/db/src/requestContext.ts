import { AsyncLocalStorage } from 'node:async_hooks';

// One deliberate AsyncLocalStorage carve-out. Every other piece of state is
// passed via DI. This exception exists because HIPAA audit log entries
// (app_audit_log) need actor_id / request_id / ip / route on every read or
// write, and threading those through every store method signature rots fast.
// Mirrors rbl_shared's request_context ContextVar (ADR 0008).

export interface RequestContext {
  /** Identity from Easy Auth (x-ms-client-principal-name). Null for system jobs. */
  actorId: string | null;
  /** Per-request UUID assigned by the inbound HTTP middleware. */
  requestId: string;
  /** Caller IP from x-forwarded-for or socket. */
  ip: string | null;
  /** HTTP method + path, e.g. "POST /api/matters/m-1/documents". */
  route: string | null;
  /** Free-form reason captured for sensitive operations (e.g. PHI export). */
  reason: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Throws when called outside a request scope. Use in store methods that MUST audit. */
export function requireRequestContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error('No RequestContext in scope — wrap the call in withRequestContext');
  }
  return ctx;
}
