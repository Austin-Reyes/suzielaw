import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { MembersStore, Role } from '@counsel/sharing';
import type { WorkspacesStore } from '@counsel/workspaces';
import type { WorkflowsStore } from '@counsel/workflows';
import { ROLES, ROLE_RANK } from '@counsel/sharing';
import { getSessionUser } from './auth.js';

const SUBJECT_MATTER = 'matter';
const SUBJECT_WORKFLOW = 'workflow';

function lowerEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function parseRole(raw: unknown): Role | null {
  if (typeof raw !== 'string') return null;
  return (ROLES as readonly string[]).includes(raw) ? (raw as Role) : null;
}

/**
 * Single-user demo bridge: matters created before the membership
 * surface existed have no `members` row. Without a backfill, the demo
 * user can't see any of their pre-existing matters once
 * `requireMatterAccess` lights up. Grant the demo user owner on every
 * member-less matter at boot. Multi-user production would fail-closed
 * and require manual repair instead.
 */
export async function backfillMatterOwnership(opts: {
  members: MembersStore;
  workspaces: WorkspacesStore;
  ownerEmail: string;
}): Promise<{ granted: number }> {
  const { members, workspaces, ownerEmail } = opts;
  let granted = 0;
  for (const w of await workspaces.listWorkspaces({ includeArchived: true })) {
    const existing = await members.listMembersFor({ type: SUBJECT_MATTER, id: w.id });
    if (existing.length === 0) {
      await members.addMember({
        subjectType: SUBJECT_MATTER,
        subjectId: w.id,
        userId: ownerEmail,
        role: 'owner',
        grantedBy: null,
      });
      granted += 1;
    }
  }
  return { granted };
}

/**
 * Express middleware that gates a matter-scoped path on the session user
 * having any role on that matter. Mount on `/api/matters/:matterId` (or
 * any nested path) so it intercepts every request that targets a
 * specific matter. Returns 401 unauthenticated, 403 if the matter
 * exists but the user has no role, 404 if the matter doesn't exist at
 * all.
 */
export function createRequireMatterAccess(opts: {
  members: MembersStore;
  workspaces: WorkspacesStore;
}): RequestHandler {
  const { members, workspaces } = opts;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const matterId = String(req.params.matterId ?? '');
    if (!matterId) {
      res.status(400).json({ error: 'matterId required' });
      return;
    }
    const userId = getSessionUser(req)?.email;
    if (!userId) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (!(await workspaces.getWorkspace(matterId))) {
      res.status(404).json({ error: 'matter not found' });
      return;
    }
    const role = await members.getRole({ type: SUBJECT_MATTER, id: matterId }, userId);
    if (!role) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    (req as Request & { _matterRole?: Role })._matterRole = role;
    next();
  };
}

/**
 * Member CRUD for matters. Mount under `/api/matters/:matterId/members`.
 * Only owners can add/remove members. Self-removal of the last owner is
 * blocked so a matter can't be orphaned.
 */
export function createMatterMembersRouter(opts: {
  members: MembersStore;
  workspaces: WorkspacesStore;
}): Router {
  const { members, workspaces } = opts;
  const router: Router = Router({ mergeParams: true });

  async function requireOwner(
    req: Request,
    res: Response,
  ): Promise<{ matterId: string; userId: string } | null> {
    const matterId = String((req.params as { matterId?: string }).matterId ?? '');
    const session = getSessionUser(req);
    if (!session?.email) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    if (!(await workspaces.getWorkspace(matterId))) {
      res.status(404).json({ error: 'matter not found' });
      return null;
    }
    const role = await members.getRole({ type: SUBJECT_MATTER, id: matterId }, session.email);
    if (role !== 'owner') {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
    return { matterId, userId: session.email };
  }

  router.get('/', async (req, res) => {
    // Any member can list — needed for the share dialog to render the
    // current state for editors/viewers, even if they can't mutate it.
    const matterId = String((req.params as { matterId?: string }).matterId ?? '');
    const session = getSessionUser(req);
    if (!session?.email) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (!(await workspaces.getWorkspace(matterId))) {
      res.status(404).json({ error: 'matter not found' });
      return;
    }
    const role = await members.getRole({ type: SUBJECT_MATTER, id: matterId }, session.email);
    if (!role) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const items = await members.listMembersFor({ type: SUBJECT_MATTER, id: matterId });
    res.json({ items, role });
  });

  router.post('/', async (req, res) => {
    const ctx = await requireOwner(req, res);
    if (!ctx) return;
    const inviteEmail = lowerEmail(req.body?.email);
    const role = parseRole(req.body?.role);
    if (!inviteEmail) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    if (!role) {
      res.status(400).json({ error: 'role must be one of owner, editor, viewer' });
      return;
    }
    const member = await members.addMember({
      subjectType: SUBJECT_MATTER,
      subjectId: ctx.matterId,
      userId: inviteEmail,
      role,
      grantedBy: ctx.userId,
    });
    res.status(201).json({ item: member });
  });

  router.delete('/:userId', async (req, res) => {
    const ctx = await requireOwner(req, res);
    if (!ctx) return;
    const target = lowerEmail(req.params.userId);
    if (!target) {
      res.status(400).json({ error: 'userId required' });
      return;
    }
    // Block removing the last owner — keeps every matter reachable by
    // at least one user.
    const all = await members.listMembersFor({ type: SUBJECT_MATTER, id: ctx.matterId });
    const owners = all.filter((m) => m.role === 'owner');
    const targetIsOwner = owners.some((m) => m.userId === target);
    if (targetIsOwner && owners.length <= 1) {
      res.status(400).json({ error: 'cannot remove the last owner' });
      return;
    }
    const removed = await members.removeMember(SUBJECT_MATTER, ctx.matterId, target);
    if (!removed) {
      res.status(404).json({ error: 'member not found' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}

/**
 * Workflow access: visibility merges the owner-side `listVisible` with
 * any workflows the user has explicit member access to. Used to gate
 * `GET /api/workflows`, `GET /:id`, and the from-workflow review
 * launch. Owner / editor can edit; viewer can only run.
 */
export async function listVisibleWorkflowsForUser(opts: {
  workflows: WorkflowsStore;
  members: MembersStore;
  ownerId: string;
  includeArchived?: boolean;
}) {
  const { workflows, members, ownerId, includeArchived } = opts;
  const owned = await workflows.listVisible({ ownerId, includeArchived });
  const ownedIds = new Set(owned.map((w) => w.id));
  const sharedSubjects = await members.listSubjectsFor(ownerId, SUBJECT_WORKFLOW);
  const extras = [];
  for (const sub of sharedSubjects) {
    if (ownedIds.has(sub.subjectId)) continue;
    const wf = await workflows.get(sub.subjectId);
    if (!wf) continue;
    if (!includeArchived && wf.archivedAt !== null) continue;
    extras.push(wf);
  }
  // Stable sort: owned first, then shared, both by name.
  return [...owned, ...extras.sort((a, b) => a.name.localeCompare(b.name))];
}

/**
 * Resolve the strongest role a user has on a workflow: their own rows
 * are implicit owner; system rows are implicit viewer (run-only); other
 * users' rows depend on explicit grants. Returns null when the user has
 * no path to the workflow.
 */
export async function resolveWorkflowRole(opts: {
  workflows: WorkflowsStore;
  members: MembersStore;
  workflowId: string;
  userId: string;
}): Promise<Role | null> {
  const { workflows, members, workflowId, userId } = opts;
  const wf = await workflows.get(workflowId);
  if (!wf) return null;
  // System rows: every authenticated user can read + run, but no edit.
  if (wf.source === 'system') {
    const explicit = await members.getRole({ type: SUBJECT_WORKFLOW, id: workflowId }, userId);
    if (explicit && ROLE_RANK[explicit] > ROLE_RANK['viewer']) return explicit;
    return 'viewer';
  }
  // User rows: implicit owner for the creator.
  if (wf.ownerId === userId) return 'owner';
  return members.getRole({ type: SUBJECT_WORKFLOW, id: workflowId }, userId);
}

/**
 * Member CRUD for workflows. Mount under `/api/workflows/:workflowId/members`.
 * Only owner/editor can mutate (editors get the full mutation set,
 * including sharing). Viewers can list to see who else has access.
 */
export function createWorkflowMembersRouter(opts: {
  members: MembersStore;
  workflows: WorkflowsStore;
}): Router {
  const { members, workflows } = opts;
  const router: Router = Router({ mergeParams: true });

  async function requireOwnerOrEditor(
    req: Request,
    res: Response,
  ): Promise<{ workflowId: string; userId: string; role: Role } | null> {
    const workflowId = String((req.params as { workflowId?: string }).workflowId ?? '');
    const session = getSessionUser(req);
    if (!session?.email) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    const role = await resolveWorkflowRole({
      workflows,
      members,
      workflowId,
      userId: session.email,
    });
    if (!role) {
      res.status(404).json({ error: 'workflow not found' });
      return null;
    }
    if (role !== 'owner' && role !== 'editor') {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
    return { workflowId, userId: session.email, role };
  }

  router.get('/', async (req, res) => {
    const workflowId = String((req.params as { workflowId?: string }).workflowId ?? '');
    const session = getSessionUser(req);
    if (!session?.email) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const role = await resolveWorkflowRole({
      workflows,
      members,
      workflowId,
      userId: session.email,
    });
    if (!role) {
      res.status(404).json({ error: 'workflow not found' });
      return;
    }
    const items = await members.listMembersFor({ type: SUBJECT_WORKFLOW, id: workflowId });
    res.json({ items, role });
  });

  router.post('/', async (req, res) => {
    const ctx = await requireOwnerOrEditor(req, res);
    if (!ctx) return;
    // Sharing system workflows is a no-op — every user already sees them.
    const wf = (await workflows.get(ctx.workflowId))!;
    if (wf.source === 'system') {
      res.status(400).json({ error: 'system workflows are visible to all users' });
      return;
    }
    const inviteEmail = lowerEmail(req.body?.email);
    const role = parseRole(req.body?.role);
    if (!inviteEmail) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    if (!role) {
      res.status(400).json({ error: 'role must be one of owner, editor, viewer' });
      return;
    }
    // Don't let a user share a workflow with its own creator at a
    // demoted role — the implicit owner role wins anyway.
    if (inviteEmail === wf.ownerId) {
      res.status(400).json({ error: 'cannot share with the workflow creator' });
      return;
    }
    const member = await members.addMember({
      subjectType: SUBJECT_WORKFLOW,
      subjectId: ctx.workflowId,
      userId: inviteEmail,
      role,
      grantedBy: ctx.userId,
    });
    res.status(201).json({ item: member });
  });

  router.delete('/:userId', async (req, res) => {
    const ctx = await requireOwnerOrEditor(req, res);
    if (!ctx) return;
    const target = lowerEmail(req.params.userId);
    if (!target) {
      res.status(400).json({ error: 'userId required' });
      return;
    }
    const removed = await members.removeMember(SUBJECT_WORKFLOW, ctx.workflowId, target);
    if (!removed) {
      res.status(404).json({ error: 'member not found' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
