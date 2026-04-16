import { HeartbeatResult } from '../types';

const MAX_ENTRIES_PER_AGENT = 100;

/**
 * In-memory ring buffer of HeartbeatResult entries per agent.
 * Stores up to MAX_ENTRIES_PER_AGENT results per agent; oldest entries are
 * dropped once the limit is reached.
 */
export class HeartbeatHistory {
  // Map<agentId, HeartbeatResult[]> — newest at index 0 (prepend strategy)
  private readonly store = new Map<string, HeartbeatResult[]>();

  /**
   * Record a heartbeat result for the given agent.
   * Drops the oldest entry once MAX_ENTRIES_PER_AGENT is reached.
   */
  record(agentId: string, result: HeartbeatResult): void {
    if (!this.store.has(agentId)) {
      this.store.set(agentId, []);
    }
    const entries = this.store.get(agentId)!;

    // Prepend so index 0 is always the most recent
    entries.unshift(result);

    if (entries.length > MAX_ENTRIES_PER_AGENT) {
      entries.splice(MAX_ENTRIES_PER_AGENT); // drop oldest
    }
  }

  /**
   * Return all results for an agent (optionally filtered by taskName).
   * Results are in reverse-chronological order (newest first).
   */
  getHistory(agentId: string, taskName?: string): HeartbeatResult[] {
    const entries = this.store.get(agentId) ?? [];
    if (taskName === undefined) {
      return [...entries];
    }
    return entries.filter((r) => r.taskName === taskName);
  }

  /**
   * Return the most recent result for a specific task, or null if none exists.
   */
  getLastResult(agentId: string, taskName: string): HeartbeatResult | null {
    const entries = this.store.get(agentId) ?? [];
    return entries.find((r) => r.taskName === taskName) ?? null;
  }
}
