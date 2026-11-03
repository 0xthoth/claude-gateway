import { promises as fsp } from 'fs';
import * as path from 'path';
import { deleteEntry, DeleteErrorCode } from './delete';
import { folderSize, listDir, resolveRealDir } from './fs';
import { FilesErrorCode, parseEntryName, RelPath } from './paths';
import { err, ok, Result } from '../utils/result';
import type { Logger } from '../types';

/**
 * What a cleaner may remove, owned here so the gateway decides it and the caller only chooses among it. Each folder
 * names what must sit at its project's top and, when set, what must sit inside it. A folder that fails its check is
 * not a candidate, so a cache-like name with nothing that proves it is one stays.
 */
interface CleanupRule {
  /** At least one entry at the project's top must match. */
  topMarkers: readonly RegExp[];
  /** A file that must exist inside the folder. */
  inner: string | null;
}

const PYTHON_TOP_MARKERS = [/^requirements.*\.txt$/, /^pyproject\.toml$/, /^Pipfile(\.lock)?$/, /^poetry\.lock$/, /^uv\.lock$/, /^setup\.py$/];

export const CLEANUP_RULES = {
  node_modules: { topMarkers: [/^package\.json$/], inner: null },
  '.venv': { topMarkers: PYTHON_TOP_MARKERS, inner: 'pyvenv.cfg' },
  venv: { topMarkers: PYTHON_TOP_MARKERS, inner: 'pyvenv.cfg' },
} as const satisfies Record<string, CleanupRule>;

export type CleanupFolder = keyof typeof CLEANUP_RULES;

export const CLEANUP_FOLDERS = Object.keys(CLEANUP_RULES) as CleanupFolder[];

export function isCleanupFolder(raw: unknown): raw is CleanupFolder {
  return typeof raw === 'string' && (CLEANUP_FOLDERS as string[]).includes(raw);
}

export interface CleanupCandidate {
  project: string;
  folder: CleanupFolder;
}

export type CleanupItemCode = 'not_a_candidate' | FilesErrorCode | DeleteErrorCode;

export type CleanupResult =
  | { project: string; folder: string; state: 'removed' }
  | { project: string; folder: string; state: 'skipped' | 'failed'; code: CleanupItemCode };

export interface CleanupDeps {
  logger: Logger;
  /** The same check the delete route uses: a chat, task or mark working in the folder. */
  inUse: (realDir: string) => boolean | Promise<boolean>;
}

async function isFile(file: string): Promise<boolean> {
  const st = await fsp.lstat(file).catch(() => null);
  return st !== null && st.isFile();
}

/**
 * Whether `folder` directly under the real project folder `projectDir` is a cleanable candidate. A link is never one:
 * lstat sees the link, not a folder.
 */
async function isCandidate(projectDir: string, folder: CleanupFolder): Promise<boolean> {
  const rule: CleanupRule = CLEANUP_RULES[folder];
  const folderPath = path.join(projectDir, folder);
  const st = await fsp.lstat(folderPath).catch(() => null);
  if (!st?.isDirectory()) return false;
  const top = await fsp.readdir(projectDir).catch(() => [] as string[]);
  if (!top.some((name) => rule.topMarkers.some((re) => re.test(name)))) return false;
  if (rule.inner !== null && !(await isFile(path.join(folderPath, rule.inner)))) return false;
  return true;
}

export interface CleanupListing extends CleanupCandidate {
  /** Bytes the folder occupies, as the files listing counts them. Null when the measurement ran out of time. */
  bytes: number | null;
}

/** Every project directly under the root, that has a cleanable folder, with what each one occupies. Reads only. */
export async function listCleanupCandidates(root: string): Promise<CleanupListing[]> {
  const listing = await listDir(root, '' as RelPath);
  if (!listing.ok) return [];
  const found: CleanupListing[] = [];
  for (const entry of listing.value.entries) {
    const projectDir = await resolveRealDir(root, entry.path);
    if (!projectDir.ok) continue;
    for (const folder of CLEANUP_FOLDERS) {
      if (!(await isCandidate(projectDir.value, folder))) continue;
      const bytes = await folderSize(path.join(projectDir.value, folder));
      found.push({ project: entry.name, folder, bytes });
    }
  }
  return found;
}

/**
 * Removes the candidates named in `items`, one at a time. Each item is checked against the same rules as the listing
 * right before its delete, so a folder that stopped qualifying is refused. The delete itself keeps every guard it
 * already has: no link on the way, no mount point, and no chat, task or mark working there.
 */
export async function removeCleanupItems(root: string, items: CleanupCandidate[], deps: CleanupDeps): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];
  for (const item of items) {
    results.push(await removeOne(root, item, deps));
  }
  return results;
}

async function removeOne(root: string, item: CleanupCandidate, deps: CleanupDeps): Promise<CleanupResult> {
  const { project, folder } = item;
  const failed = (code: CleanupItemCode): CleanupResult => ({ project, folder, state: 'failed', code });
  if (!parseEntryName(project).ok) return failed('invalid_name');
  if (!isCleanupFolder(folder)) return failed('not_a_candidate');
  const projectDir = await resolveRealDir(root, project as RelPath);
  if (!projectDir.ok) return failed(projectDir.error === 'not_found' ? 'not_found' : 'not_a_candidate');
  if (!(await isCandidate(projectDir.value, folder))) return failed('not_a_candidate');
  // The folder name is one of CLEANUP_FOLDERS, which the entry name rule would refuse for its leading dot. It is
  // safe here because the project part was parsed above and the folder part is fixed by this list.
  const rel = `${project}/${folder}` as RelPath;
  const removed = await deleteEntry(root, rel, deps);
  if (removed.ok) return { project, folder, state: 'removed' };
  const busy = removed.error === 'in_use' || removed.error === 'deleting' || removed.error === 'marked';
  return { project, folder, state: busy ? 'skipped' : 'failed', code: removed.error };
}

/** The most items one `POST /v1/files/cleanup` takes. */
export const MAX_CLEANUP_ITEMS = 200;

export type CleanupError = 'invalid_cleanup';

/** Validates the request body shape before any filesystem work. */
export function parseCleanupItems(raw: unknown): Result<CleanupCandidate[], CleanupError> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CLEANUP_ITEMS) return err('invalid_cleanup');
  const items: CleanupCandidate[] = [];
  for (const item of raw) {
    const { project, folder } = (item ?? {}) as { project?: unknown; folder?: unknown };
    if (typeof project !== 'string' || typeof folder !== 'string') return err('invalid_cleanup');
    items.push({ project, folder: folder as CleanupFolder });
  }
  return ok(items);
}
