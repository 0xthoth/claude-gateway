import { randomUUID } from 'crypto';
import { overlaps } from './paths';

/** Why a folder is held: a delete under way, or a mark a cleaner took through `POST /v1/files/marks`. */
export type HoldKind = 'deleting' | 'mark';

export interface Hold {
  id: string;
  kind: HoldKind;
  /** The real folder held. Keyed by real folder, so a symlink alias is held too. */
  dir: string;
  purpose?: string;
  /** Epoch ms. A mark expires on its own so a cleaner that crashed frees the folder; a delete holds until it ends. */
  expiresAt?: number;
}

const holds = new Map<string, Hold>();

function expired(hold: Hold, now: number): boolean {
  return hold.expiresAt !== undefined && hold.expiresAt <= now;
}

/**
 * The hold on `dir`, on a folder inside it or on one holding it. While a hold exists no chat turn, spawn or task
 * begins in such a folder, and no other delete or mark takes one. Synchronous, so a caller can check and add in one
 * step with nothing able to run in between.
 */
export function findHold(dir: string, now = Date.now()): Hold | undefined {
  for (const hold of holds.values()) {
    if (expired(hold, now)) holds.delete(hold.id);
    else if (overlaps(hold.dir, dir)) return hold;
  }
  return undefined;
}

/** Adds a hold without checking for an overlapping one; call {@link findHold} first in the same synchronous step. */
export function addHold(hold: Omit<Hold, 'id'>): Hold {
  const added = { ...hold, id: randomUUID() };
  holds.set(added.id, added);
  return added;
}

/** Idempotent. With `kind`, a hold of another kind is left alone, so a mark id never releases a delete. */
export function releaseHold(id: string, kind?: HoldKind): void {
  const hold = holds.get(id);
  if (hold && (kind === undefined || hold.kind === kind)) holds.delete(id);
}
