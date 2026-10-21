import { NextFunction, Request, Response, Router } from 'express';
import { ApiKey, Logger } from '../types';
import { ADMIN_KEY_REQUIRED, createApiAuthMiddleware, isAdmin } from './auth';
import { guardAsyncRoutes } from './async-guard';
import { defineRoute } from './route-registry';
import { listDir, makeDir } from '../files/fs';
import { DeleteErrorCode, deleteEntry } from '../files/delete';
import { FilesErrorCode, parseRelPath, pathSegments, RelPath } from '../files/paths';
import { getStatus, getSummaries, GitError, GitErrorCode } from '../git/read';
import { busyPaths, FolderWork, MARK_PURPOSES, MARK_TTL_SEC, MarkError, MAX_LIVE_MARKS, MarkPurpose, releaseMark, takeMark } from '../files/marks';
import { Result } from '../utils/result';

type AuthedRequest = Request & { apiKey: ApiKey };

export type FilesApiErrorCode = FilesErrorCode | GitErrorCode | DeleteErrorCode | 'confirm_mismatch' | 'invalid_mark' | 'too_many_marks';

/** The most paths one `POST /v1/files/busy` checks. */
const MAX_BUSY_PATHS = 200;

/** Every error code the files and git routes answer, with its status. website/api/files.md publishes this table. */
export const FILES_ERRORS: Record<FilesApiErrorCode, { status: number; message: string }> = {
  invalid_path: { status: 400, message: 'path must be a relative path of entry names joined by /' },
  invalid_name: { status: 400, message: 'A path segment is not a valid entry name' },
  not_a_directory: { status: 400, message: 'Not a directory' },
  confirm_mismatch: { status: 400, message: 'confirm must equal the last segment of path' },
  invalid_mark: { status: 400, message: `paths must be 1 to ${MAX_BUSY_PATHS} paths; a mark needs purpose ${MARK_PURPOSES.join(' or ')} and ttlSec ${MARK_TTL_SEC.min} to ${MARK_TTL_SEC.max}` },
  path_escape: { status: 403, message: 'Path resolves outside the files root' },
  permission_denied: { status: 403, message: 'Permission denied' },
  forbidden_key: { status: 403, message: ADMIN_KEY_REQUIRED.error },
  not_found: { status: 404, message: 'Not found' },
  already_exists: { status: 409, message: 'An entry with this name already exists' },
  symlink_in_path: { status: 409, message: 'A folder above the entry is a symbolic link' },
  cross_device: { status: 409, message: 'The entry is on another filesystem or holds a mount point' },
  in_use: { status: 409, message: 'A chat or task is working in this folder' },
  deleting: { status: 409, message: 'The folder is being deleted' },
  marked: { status: 409, message: 'A cleaning mark holds this folder, one inside it, or one holding it' },
  not_a_git_repo: { status: 409, message: 'The folder is not a git repository' },
  git_unsafe_owner: { status: 409, message: "Git refuses this repository because another user owns it. Run `git config --global --add safe.directory <path>` as the gateway's user, or fix the owner." },
  git_unreadable: { status: 409, message: 'This is a git repository the gateway cannot read safely: check its permissions, its config, and any filter drivers it defines' },
  too_many_marks: { status: 429, message: `The gateway already holds ${MAX_LIVE_MARKS} marks; release one or wait for one to expire` },
  internal: { status: 500, message: 'Internal error' },
  git_failed: { status: 500, message: 'Git failed' },
  git_unavailable: { status: 503, message: 'Git is not installed on this machine, or is not on the gateway\'s PATH' },
  timeout: { status: 504, message: 'Git took too long' },
};

type Failure = FilesApiErrorCode | GitError | MarkError;

function fail(res: Response, error: Failure): void {
  const body = typeof error === 'string' ? { code: error } : error;
  const { status, message } = FILES_ERRORS[body.code];
  res.status(status).json({ error: message, ...body });
}

function respond<T>(res: Response, result: Result<T, Failure>, status = 200): void {
  if (result.ok) res.status(status).json(result.value);
  else fail(res, result.error);
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (isAdmin((req as AuthedRequest).apiKey)) next();
  else fail(res, 'forbidden_key');
}

/** `?path=`, absent meaning the root. Repeated or nested query values are not strings and are refused. */
function queryPath(req: Request): Result<RelPath, 'invalid_path' | 'invalid_name'> {
  return parseRelPath(req.query.path ?? '');
}

export interface FilesRouterDeps {
  /** The gateway logger, for warnings such as a failed `git init` or a delete that left files behind. */
  logger: Logger;
  /** A chat turn, a spawning session or a task works in this real folder, in one inside it, or in one holding it. */
  inUse?: (realDir: string) => boolean | Promise<boolean>;
  /** Live work by real folder, for the busy and marks routes. Without it nothing counts as busy. */
  work?: FolderWork;
}

const NO_WORK: FolderWork = { prepare: async () => {}, reasons: () => new Set() };

function parseMarkBody(body: { path?: unknown; purpose?: unknown; ttlSec?: unknown }): Result<{ rel: RelPath; purpose: MarkPurpose; ttlSec: number }, Failure> {
  const rel = parseRelPath(body.path);
  if (!rel.ok) return rel;
  if (rel.value === '') return { ok: false, error: 'invalid_path' };
  const ttl = body.ttlSec;
  if (!MARK_PURPOSES.includes(body.purpose as MarkPurpose) || typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < MARK_TTL_SEC.min || ttl > MARK_TTL_SEC.max) {
    return { ok: false, error: 'invalid_mark' };
  }
  return { ok: true, value: { rel: rel.value, purpose: body.purpose as MarkPurpose, ttlSec: ttl } };
}

/**
 * Pod-wide folder and git routes under one root. Paths are relative to the root and every segment follows the entry
 * name rule. Any key may read; creating and deleting change the pod and need an admin key.
 */
export function createFilesRouter(apiKeys: ApiKey[], root: string, deps: FilesRouterDeps): Router {
  const { logger } = deps;
  // The message and stack can carry paths and secrets, so only the error's class and errno code are logged.
  const router = guardAsyncRoutes(Router(), (req, res, err) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    logger.error(`files: ${req.method} ${req.path} failed: ${err instanceof Error ? err.name : typeof err}${typeof code === 'string' ? ` ${code}` : ''}`);
    if (res.headersSent) res.end();
    else fail(res, 'internal');
  });
  const auth = createApiAuthMiddleware(apiKeys);

  defineRoute(
    router,
    { method: 'GET', path: '/v1/files', auth: 'key', summary: 'List the folders directly under a path of the files root', cli: null },
    auth,
    async (req: Request, res: Response) => {
      const rel = queryPath(req);
      if (!rel.ok) return fail(res, rel.error);
      respond(res, await listDir(root, rel.value));
    },
  );

  defineRoute(
    router,
    { method: 'POST', path: '/v1/files/mkdir', auth: 'admin', summary: 'Create one new folder under the files root', cli: null },
    auth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { path?: unknown; git_init?: unknown };
      const rel = parseRelPath(body.path);
      if (!rel.ok) return fail(res, rel.error);
      respond(res, await makeDir(root, rel.value, body.git_init === true, logger), 201);
    },
  );

  defineRoute(
    router,
    { method: 'DELETE', path: '/v1/files', auth: 'admin', summary: 'Delete a folder under the files root and everything in it', cli: null },
    auth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { path?: unknown; confirm?: unknown };
      const rel = parseRelPath(body.path);
      if (!rel.ok) return fail(res, rel.error);
      const name = pathSegments(rel.value).pop();
      if (name === undefined) return fail(res, 'invalid_path');
      if (body.confirm !== name) return fail(res, 'confirm_mismatch');
      respond(res, await deleteEntry(root, rel.value, { logger, inUse: deps.inUse ?? (() => false) }));
    },
  );

  defineRoute(
    router,
    { method: 'POST', path: '/v1/files/busy', auth: 'admin', summary: 'Which folders under the files root a chat, spawn, task, mark or delete is using', cli: null },
    auth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const raw = ((req.body ?? {}) as { paths?: unknown }).paths;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BUSY_PATHS) return fail(res, 'invalid_mark');
      const paths: RelPath[] = [];
      for (const p of raw) {
        const rel = parseRelPath(p);
        if (!rel.ok) return fail(res, rel.error);
        if (rel.value === '') return fail(res, 'invalid_path');
        paths.push(rel.value);
      }
      res.json({ results: await busyPaths(root, paths, deps.work ?? NO_WORK) });
    },
  );

  defineRoute(
    router,
    { method: 'POST', path: '/v1/files/marks', auth: 'admin', summary: 'Hold a folder under the files root while a cleaner works in it', cli: null },
    auth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const body = parseMarkBody((req.body ?? {}) as Record<string, unknown>);
      if (!body.ok) return fail(res, body.error);
      const { rel, purpose, ttlSec } = body.value;
      respond(res, await takeMark(root, rel, purpose, ttlSec, deps.work ?? NO_WORK), 201);
    },
  );

  defineRoute(
    router,
    { method: 'DELETE', path: '/v1/files/marks/:markId', auth: 'admin', summary: 'Release a mark; idempotent', cli: null },
    auth,
    requireAdmin,
    (req: Request, res: Response) => {
      releaseMark(String(req.params.markId));
      res.status(204).end();
    },
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/git/status', auth: 'key', summary: 'Git status of a folder under the files root', cli: null },
    auth,
    async (req: Request, res: Response) => {
      const rel = queryPath(req);
      if (!rel.ok) return fail(res, rel.error);
      if (rel.value === '') return fail(res, 'invalid_path');
      respond(res, await getStatus(root, rel.value, logger));
    },
  );

  defineRoute(
    router,
    { method: 'GET', path: '/v1/git/summary', auth: 'key', summary: 'Git sync summary of every repository directly under a path of the files root', cli: null },
    auth,
    async (req: Request, res: Response) => {
      const rel = queryPath(req);
      if (!rel.ok) return fail(res, rel.error);
      respond(res, await getSummaries(root, rel.value, logger));
    },
  );

  return router;
}
