import { NextFunction, Request, Response, Router } from 'express';
import { ApiKey, Logger } from '../types';
import { createApiAuthMiddleware, isAdmin, PROJECTS_ADMIN_REQUIRED } from './auth';
import { guardAsyncRoutes } from './async-guard';
import { defineRoute } from './route-registry';
import { createProject, resolveProjectDir, listProjects } from '../projects/fs';
import { getStatus, getSummaries, GitError, GitErrorCode } from '../projects/git';
import { DeleteErrorCode, removeProject } from '../projects/delete';
import { isProjectDeleting, markProjectDeleting } from '../projects/chat';
import { parseProjectName, ProjectName, ProjectsErrorCode } from '../projects/paths';
import { Result } from '../utils/result';

type AuthedRequest = Request & { apiKey: ApiKey };

const ERRORS: Record<ProjectsErrorCode | GitErrorCode | DeleteErrorCode, { status: number; message: string }> = {
  invalid_name: { status: 400, message: 'Invalid project name' },
  not_a_directory: { status: 400, message: 'Not a directory' },
  path_escape: { status: 403, message: 'Path resolves outside the project' },
  permission_denied: { status: 403, message: 'Permission denied' },
  forbidden_key: { status: 403, message: PROJECTS_ADMIN_REQUIRED.error },
  not_found: { status: 404, message: 'Not found' },
  project_exists: { status: 409, message: 'Project already exists' },
  internal: { status: 500, message: 'Internal error' },
  not_a_git_repo: { status: 409, message: 'Project is not a git repository' },
  git_unsafe_owner: { status: 409, message: "Git refuses this repository because another user owns it. Run `git config --global --add safe.directory <path>` as the gateway's user, or fix the owner." },
  git_unreadable: { status: 409, message: 'This is a git repository the gateway cannot read safely: check its permissions, its config, and any filter drivers it defines' },
  timeout: { status: 504, message: 'Git took too long' },
  git_unavailable: { status: 503, message: 'Git is not installed on this machine, or is not on the gateway\'s PATH' },
  git_failed: { status: 500, message: 'Git failed' },
  confirm_mismatch: { status: 400, message: 'confirm must be the exact project name' },
  project_running: { status: 409, message: 'Stop what is running in this project first' },
  project_deleting: { status: 409, message: 'The project is being deleted' },
};

function fail(res: Response, error: ProjectsErrorCode | DeleteErrorCode | GitError): void {
  const body = typeof error === 'string' ? { code: error } : error;
  const { status, message } = ERRORS[body.code];
  res.status(status).json({ error: message, ...body });
}

function respond<T>(res: Response, result: Result<T, ProjectsErrorCode | DeleteErrorCode | GitError>, status = 200): void {
  if (result.ok) res.status(status).json(result.value);
  else fail(res, result.error);
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (isAdmin((req as AuthedRequest).apiKey)) next();
  else fail(res, 'forbidden_key');
}

export interface ProjectsRouterDeps {
  /** The gateway logger, for warnings such as a failed `git init` or a delete that left files behind. */
  logger: Logger;
  /** A chat bound to the project has a turn running, whose agent process works inside the folder. */
  chatTurnActive?: (name: ProjectName) => boolean | Promise<boolean>;
}

/**
 * Pod-wide project routes under `root`. Projects belong to no agent, so any key may read them; creating and deleting
 * one changes the pod and needs an admin key.
 */
export function createProjectsRouter(apiKeys: ApiKey[], root: string, deps: ProjectsRouterDeps): Router {
  const { logger } = deps;
  // The message and stack can carry paths and secrets, so only the error's class and errno code are logged.
  const router = guardAsyncRoutes(Router(), (req, res, err) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    logger.error(`projects: ${req.method} ${req.path} failed: ${err instanceof Error ? err.name : typeof err}${typeof code === 'string' ? ` ${code}` : ''}`);
    if (res.headersSent) res.end();
    else fail(res, 'internal');
  });
  const auth = createApiAuthMiddleware(apiKeys);

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects', auth: 'key', summary: 'List projects under the configured projects root', cli: null },
    auth,
    async (_req: Request, res: Response) => respond(res, await listProjects(root)),
  );

  defineRoute(
    router,
    { method: 'POST', path: '/v1/projects', auth: 'admin', summary: 'Create a project directory', cli: null },
    auth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { name?: unknown; git_init?: unknown };
      const name = parseProjectName(body.name);
      if (!name.ok) return fail(res, name.error);
      respond(res, await createProject(root, name.value, body.git_init === true, logger), 201);
    },
  );

  defineRoute(
    router,
    { method: 'DELETE', path: '/v1/projects/:name', auth: 'admin', summary: 'Delete a project folder and everything in it', cli: null },
    auth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      if ((req.body ?? {}).confirm !== name.value) return fail(res, 'confirm_mismatch');
      const dir = await resolveProjectDir(root, name.value);
      if (!dir.ok) return fail(res, dir.error);
      if (isProjectDeleting(dir.value)) return fail(res, 'project_deleting');
      const busy = async () => Boolean(await deps.chatTurnActive?.(name.value));
      // Checked before the mark, so a turn that began earlier is seen here and never refused by the mark.
      if (await busy()) return fail(res, 'project_running');
      const release = markProjectDeleting(dir.value);
      if (!release) return fail(res, 'project_deleting');
      try {
        if (await busy()) return fail(res, 'project_running');
        respond(res, await removeProject(root, name.value, logger));
      } finally {
        release();
      }
    },
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects/git-summary', auth: 'key', summary: 'Git sync summary for every project that is a repository', cli: null },
    auth,
    async (_req: Request, res: Response) => respond(res, await getSummaries(root, logger)),
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/projects/:name/git', auth: 'key', summary: 'Git status of a project', cli: null },
    auth,
    async (req: Request, res: Response) => {
      const name = parseProjectName(req.params.name);
      if (!name.ok) return fail(res, name.error);
      respond(res, await getStatus(root, name.value, logger));
    },
  );

  return router;
}
