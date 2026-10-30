import type { WorkReason } from '../session/cwd';
import { resolveDir } from './fs';
import { addHold, countHolds, findHold, Hold, releaseHold } from './holds';
import { FilesErrorCode, RelPath } from './paths';
import { err, ok, Result } from '../utils/result';

/** Why a folder is busy or held, as `POST /v1/files/busy` reports it. */
export type BusyReason = WorkReason | 'marked' | 'deleting';

/** Live work in the gateway, keyed by real folder. */
export interface FolderWork {
  /** Loads what `reasons` reads, so the check itself can run with no await. */
  prepare(): Promise<void>;
  /** What works in the real folder, in one inside it or in one holding it. Synchronous. */
  reasons(realDir: string): Set<WorkReason>;
}

export const MARK_PURPOSES = ['cleaning', 'starting'] as const;
export type MarkPurpose = (typeof MARK_PURPOSES)[number];
export const MARK_TTL_SEC = { min: 60, max: 300 } as const;
/** Live marks the gateway keeps at once, so the in-memory table stays bounded. */
export const MAX_LIVE_MARKS = 512;

/** Every reason but an idle session makes a folder busy. */
export function blocking(reasons: Iterable<BusyReason>): BusyReason[] {
  return [...reasons].filter((r) => r !== 'session');
}

function holdReason(hold: Hold | undefined): BusyReason[] {
  if (!hold) return [];
  return [hold.kind === 'deleting' ? 'deleting' : 'marked'];
}

export interface BusyResult {
  path: RelPath;
  abs: string | null;
  busy: boolean;
  reasons: BusyReason[];
  /** Set when the path did not resolve; `abs` is then null and nothing was checked. */
  error?: FilesErrorCode;
}

/** Advisory: each path's live work and holds right now. A caller that acts on the answer takes a mark instead. */
export async function busyPaths(root: string, paths: RelPath[], work: FolderWork): Promise<BusyResult[]> {
  const dirs = await Promise.all(paths.map((rel) => resolveDir(root, rel)));
  await work.prepare();
  return paths.map((rel, i) => {
    const dir = dirs[i]!;
    if (!dir.ok) return { path: rel, abs: null, busy: false, reasons: [], error: dir.error };
    const reasons: BusyReason[] = [...holdReason(findHold(dir.value)), ...work.reasons(dir.value)];
    return { path: rel, abs: dir.value, busy: blocking(reasons).length > 0, reasons };
  });
}

export interface Mark {
  markId: string;
  path: RelPath;
  abs: string;
  purpose: MarkPurpose;
  expiresAt: string;
}

export type MarkError =
  | { code: FilesErrorCode }
  | { code: 'marked' | 'deleting' | 'too_many_marks' }
  | { code: 'in_use'; reasons: BusyReason[] };

/**
 * Takes a mark on the folder `rel` names, so a cleaner can remove what is inside it with no chat, spawn, task, delete
 * or other mark starting there meanwhile. The hold check, the busy check and the insert run in one synchronous step
 * with no await between them, so nothing can start in the folder between the check and the mark.
 */
export async function takeMark(root: string, rel: RelPath, purpose: MarkPurpose, ttlSec: number, work: FolderWork, now = Date.now): Promise<Result<Mark, MarkError>> {
  const dir = await resolveDir(root, rel);
  if (!dir.ok) return err({ code: dir.error });
  await work.prepare();
  // From here to addHold nothing awaits.
  const held = findHold(dir.value);
  if (held) return err({ code: held.kind === 'deleting' ? 'deleting' : 'marked' });
  const reasons = blocking(work.reasons(dir.value));
  if (reasons.length) return err({ code: 'in_use', reasons });
  if (countHolds('mark', now()) >= MAX_LIVE_MARKS) return err({ code: 'too_many_marks' });
  const expiresAt = now() + ttlSec * 1000;
  const hold = addHold({ kind: 'mark', dir: dir.value, purpose, expiresAt });
  return ok({ markId: hold.id, path: rel, abs: dir.value, purpose, expiresAt: new Date(expiresAt).toISOString() });
}

/** Idempotent: releasing a mark that expired, was released or never existed is not an error. */
export function releaseMark(markId: string): void {
  releaseHold(markId, 'mark');
}
