import type { RequestHandler } from 'express';
import type { AuditStore } from '@counsel/audit';
import { getSessionUser } from './auth.js';

export interface RouteAuditOptions {
  subjectType?: string;
  subjectId?: string;
  metadata?: Record<string, unknown>;
}

declare global {
  namespace Express {
    interface Request {
      audit(event: string, opts?: RouteAuditOptions): void;
    }
  }
}

export function createAuditMiddleware(store: AuditStore): RequestHandler {
  return async (req, _res, next) => {
    const user = getSessionUser(req);
    const ipAddress = req.ip || null;
    const userAgent = truncate(req.get('user-agent') || null, 200);

    req.audit = (event, opts = {}) => {
      if (!user) return;
      void store.log({
        actorEmail: user.email,
        actorName: user.name,
        event,
        subjectType: opts.subjectType ?? null,
        subjectId: opts.subjectId ?? null,
        metadata: opts.metadata ?? null,
        ipAddress,
        userAgent,
      });
    };

    if (!user) {
      next();
      return;
    }

    const session = req.session as { audited?: boolean } | null;
    if (session && !session.audited) {
      const logged = await store.log({
        actorEmail: user.email,
        actorName: user.name,
        event: 'auth.login',
        metadata: {},
        ipAddress,
        userAgent,
      });
      if (logged) session.audited = true;
    }

    next();
  };
}

function truncate(value: string | null, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}
