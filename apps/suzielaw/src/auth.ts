import { Router, type Request, type RequestHandler, type Response, type NextFunction } from 'express';
import cookieSession from 'cookie-session';
import { config } from './config.js';
import type { TokenBudgetStore } from '@teamsuzie/hosted-demo';

export interface SessionUser {
  email: string;
  name: string;
  role: string;
}

/**
 * Read identity from Azure Container Apps Easy Auth headers, if present.
 * Easy Auth (the platform-level auth in front of the Container App) injects
 * these headers AFTER it has validated the upstream OAuth token, so we can
 * trust them WITHOUT re-validating — but ONLY when we know we're running
 * behind Easy Auth (i.e., env var SUZIELAW_TRUST_EASY_AUTH=true).
 *
 * If those headers are present and no session user exists yet, we
 * auto-populate the session so the client sees an authenticated user and
 * skips the login page entirely.
 *
 * Reference: https://learn.microsoft.com/en-us/azure/container-apps/authentication
 */
function readEasyAuthIdentity(req: Request): SessionUser | null {
  if (!config.session.trustEasyAuth) return null;

  // The simple header — UPN of the signed-in user (e.g., austin@reyeslaw.com).
  const principalName = req.header('x-ms-client-principal-name');
  if (!principalName) return null;

  // The base64-encoded JSON claims principal — gives us the display name etc.
  let displayName = principalName;
  const encoded = req.header('x-ms-client-principal');
  if (encoded) {
    try {
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
        claims?: Array<{ typ?: string; val?: string }>;
      };
      const nameClaim = decoded.claims?.find(
        (c) =>
          c.typ === 'name' ||
          c.typ === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
      );
      if (nameClaim?.val) displayName = nameClaim.val;
    } catch {
      // Malformed header — fall back to UPN as displayName.
    }
  }

  return {
    email: principalName.toLowerCase(),
    name: displayName,
    role: 'user',
  };
}

/**
 * Middleware: if Easy Auth headers are present and the cookie session has no
 * user yet, populate it from Easy Auth. This makes Easy Auth the source of
 * truth in production and the cookie-session a passive cache. The demo
 * email/password flow remains intact for local dev (when SUZIELAW_TRUST_EASY_AUTH
 * is off).
 */
export function easyAuthBridgeMiddleware(opts?: { budget?: TokenBudgetStore }): RequestHandler {
  return (req, _res, next) => {
    const session = req.session as { user?: SessionUser } | null;
    if (session?.user) {
      next();
      return;
    }
    const identity = readEasyAuthIdentity(req);
    if (identity) {
      (req.session as { user?: SessionUser }).user = identity;
      opts?.budget?.upsertAccount({
        email: identity.email,
        name: identity.name,
        role: identity.role,
        authProvider: 'easyauth-entra',
        authSubject: identity.email,
      });
    }
    next();
  };
}

/**
 * Stub auth — single demo user from env. Real multi-user / multi-tenant auth
 * means swapping this for `@teamsuzie/shared-auth` (Postgres-backed users,
 * Redis-backed sessions, CSRF). The route shape (POST /api/auth/login,
 * POST /api/auth/logout, GET /api/session) is intentionally compatible with
 * the upstream pattern so the swap is mostly server-side.
 */
export function createSessionMiddleware(): RequestHandler {
  return cookieSession({
    name: config.session.cookieName,
    keys: [config.session.cookieSecret],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // cookie-session attaches req.session
  const user = (req.session as { user?: SessionUser } | null)?.user;
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function getSessionUser(req: Request): SessionUser | null {
  return (req.session as { user?: SessionUser } | null)?.user ?? null;
}

export function createAuthRouter(opts?: { budget?: TokenBudgetStore }): Router {
  const router: Router = Router();

  router.post('/auth/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (email !== config.demo.email.toLowerCase() || password !== config.demo.password) {
      res.status(401).json({ message: 'Invalid email or password' });
      return;
    }

    const user: SessionUser = {
      email: config.demo.email,
      name: config.demo.name,
      role: config.demo.role,
    };
    opts?.budget?.upsertAccount({
      email: user.email,
      name: user.name,
      role: user.role,
      authProvider: 'demo',
      authSubject: user.email,
    });
    (req.session as { user?: SessionUser }).user = user;
    res.json({ ok: true, user });
  });

  router.post('/auth/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  router.get('/session', (req, res) => {
    const user = getSessionUser(req);
    res.json({
      user,
      tokenBudget: user && opts?.budget ? opts.budget.getSummary(user.email) : null,
    });
  });

  return router;
}
