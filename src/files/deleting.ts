import { overlaps } from './paths';

const deletingFolders = new Set<string>();

/**
 * Marks the real folder `dir` as being deleted, so no chat turn or worker begins in it, in a folder inside it, or in a
 * folder holding it between the delete guard and the rename. Keyed by real folder, so a symlink alias is held too.
 * Returns the release function, or null when a delete already holds an overlapping folder.
 */
export function markDeleting(dir: string): (() => void) | null {
  if (isDeleting(dir)) return null;
  deletingFolders.add(dir);
  return () => void deletingFolders.delete(dir);
}

export function isDeleting(dir: string): boolean {
  for (const held of deletingFolders) if (overlaps(held, dir)) return true;
  return false;
}
