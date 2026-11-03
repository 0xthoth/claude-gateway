/**
 * The working folder of a session, as core code sees it. The files module implements {@link CwdResolver} and the
 * composition root injects it, so session, runner and orchestration code never import a feature module.
 */
import type { Result } from '../utils/result';

/** A session's working folder after it resolved. */
export interface SessionCwd {
  /** Absolute path as stored on the session. */
  path: string;
  /** Its real path at resolve time: the spawn cwd. */
  dir: string;
  /** The folder's own `.claude/` settings, hooks and `.mcp.json` may load. */
  trusted: boolean;
  /** `dev:ino`, so a folder deleted and recreated at the same path reads as moved. */
  identity: string;
  /** One sentence naming the folder, for the cached orchestration prompt. */
  location: string;
}

export type CwdUnavailableReason =
  | 'disabled'
  | 'not_found'
  | 'outside_root'
  | 'not_a_directory'
  | 'permission_denied'
  | 'deleting'
  | 'marked'
  | 'unreadable'
  | 'internal';

/** Why an agent cannot work in a folder: its process or its workers would not run there. */
export type CwdUnsupportedReason = 'container' | 'workspace_mode' | 'codex';

export type CwdFailure =
  | { code: 'unavailable'; reason: CwdUnavailableReason }
  | { code: 'unsupported_agent'; reason: CwdUnsupportedReason };

export type CwdResolution = Result<SessionCwd, CwdUnavailableReason>;

/**
 * What works in a folder: a live or queued `turn`, a process still `spawn`ing, an unfinished `task`, or an idle
 * `session` process still running there. An idle session is reported but does not make a folder busy.
 */
export type WorkReason = 'turn' | 'spawn' | 'task' | 'session';

/** How a session response reports its folder: `missing` once it is gone, `unavailable` when it no longer resolves. */
export type CwdState = 'available' | 'missing' | 'unavailable';

export interface CwdResolver {
  /**
   * A client-supplied cwd, absolute or relative to the files root. `invalid` when it is not a path the files API
   * accepts. The root itself resolves to `outside_root`. The value's `path` is what the session stores.
   */
  parse(raw: unknown): Promise<Result<SessionCwd, CwdUnavailableReason | 'invalid'>>;
  /** Runs again at every spawn and turn, so a folder that moved, left the root or is held fails closed. */
  resolve(path: string): Promise<CwdResolution>;
  /** The location plus, when git answers in time, branch, change count and remote host. For the system prompt. */
  note(cwd: SessionCwd): Promise<string>;
  /**
   * Session index entries, binding files and task snapshots written before sessions stored a cwd name a project
   * directly under the root. Remove one release after the r6 and r7 dev pods update.
   */
  legacyProjectCwd(project: string): string;
}

/** For a gateway built without the files module, and for tests that never bind a folder. */
export const NO_CWD_RESOLVER: CwdResolver = {
  parse: async () => ({ ok: false, error: 'disabled' }),
  resolve: async () => ({ ok: false, error: 'disabled' }),
  note: async (cwd) => cwd.location,
  legacyProjectCwd: (project) => project,
};

/** What a session record says about its folder. A binding that cannot be read is not the same as no binding. */
export type StoredCwd = { kind: 'none' } | { kind: 'path'; path: string } | { kind: 'unreadable' };

/** The read-time fallback for dev data: `cwd ?? join(root, project)`. */
export function storedCwd(meta: { cwd?: unknown; project?: unknown }, resolver: Pick<CwdResolver, 'legacyProjectCwd'>): StoredCwd {
  if (typeof meta.cwd === 'string') return { kind: 'path', path: meta.cwd };
  if (typeof meta.project === 'string') return { kind: 'path', path: resolver.legacyProjectCwd(meta.project) };
  return { kind: 'none' };
}

/** The send-time error: a turn, spawn or task that cannot run because its folder failed to resolve. */
export function cwdError(failure: CwdFailure): Error {
  const code = failure.reason === 'marked' ? 'PATH_MARKED' : 'CWD_UNAVAILABLE';
  const message = failure.reason === 'marked' ? 'The working folder is held by a cleaning mark' : `Working folder is unavailable (${failure.reason})`;
  return Object.assign(new Error(message), { code, reason: failure.reason });
}

/** The uppercase codes a turn answers with 409 when its folder does not resolve. */
export const CWD_SEND_ERRORS: ReadonlySet<string> = new Set(['CWD_UNAVAILABLE', 'PATH_MARKED', 'SESSION_ID_IN_USE']);
