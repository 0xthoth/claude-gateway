import { HeartbeatHistory } from '../../src/heartbeat/history';
import { HeartbeatResult } from '../../src/types';

function makeResult(
  taskName: string,
  overrides: Partial<HeartbeatResult> = {},
): HeartbeatResult {
  return {
    taskName,
    sessionId: `heartbeat:agent1:${taskName}:${Date.now()}`,
    suppressed: false,
    rateLimited: false,
    response: 'ok',
    durationMs: 500,
    ts: new Date().toISOString(),
    ...overrides,
  };
}

describe('HeartbeatHistory', () => {
  // ─── record and retrieve by agentId ──────────────────────────────────────
  it('records results and retrieves by agentId', () => {
    const history = new HeartbeatHistory();
    const r1 = makeResult('morning-brief');
    const r2 = makeResult('idle-checkin');

    history.record('agent1', r1);
    history.record('agent1', r2);

    const results = history.getHistory('agent1');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.taskName)).toContain('morning-brief');
    expect(results.map((r) => r.taskName)).toContain('idle-checkin');
  });

  it('returns empty array for unknown agentId', () => {
    const history = new HeartbeatHistory();
    expect(history.getHistory('unknown-agent')).toEqual([]);
  });

  it('does not mix results between different agents', () => {
    const history = new HeartbeatHistory();
    history.record('agent1', makeResult('task-a'));
    history.record('agent2', makeResult('task-b'));

    const a = history.getHistory('agent1');
    const b = history.getHistory('agent2');

    expect(a).toHaveLength(1);
    expect(a[0].taskName).toBe('task-a');
    expect(b).toHaveLength(1);
    expect(b[0].taskName).toBe('task-b');
  });

  // ─── retrieve by agentId + taskName ─────────────────────────────────────
  it('retrieves results filtered by agentId + taskName', () => {
    const history = new HeartbeatHistory();
    history.record('agent1', makeResult('morning-brief'));
    history.record('agent1', makeResult('idle-checkin'));
    history.record('agent1', makeResult('morning-brief'));

    const results = history.getHistory('agent1', 'morning-brief');
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.taskName).toBe('morning-brief');
    }
  });

  it('returns empty array when taskName filter matches nothing', () => {
    const history = new HeartbeatHistory();
    history.record('agent1', makeResult('morning-brief'));

    const results = history.getHistory('agent1', 'nonexistent-task');
    expect(results).toEqual([]);
  });

  // ─── ring buffer: max 100 entries, oldest dropped ────────────────────────
  it('ring buffer: max 100 entries, oldest dropped when limit exceeded', () => {
    const history = new HeartbeatHistory();

    // Insert 105 results; first 105 entries (newest = 105th insert)
    for (let i = 1; i <= 105; i++) {
      history.record('agent1', makeResult('task', { response: `response-${i}` }));
    }

    const results = history.getHistory('agent1');
    expect(results).toHaveLength(100);

    // Newest (105th insert) should be index 0
    expect(results[0].response).toBe('response-105');

    // Oldest retained should be response-6 (105 - 100 + 1 = 6)
    expect(results[99].response).toBe('response-6');

    // response-1 through response-5 should have been dropped
    const responses = results.map((r) => r.response);
    expect(responses).not.toContain('response-1');
    expect(responses).not.toContain('response-5');
    expect(responses).toContain('response-6');
  });

  it('ring buffer: exactly 100 entries are retained without loss', () => {
    const history = new HeartbeatHistory();
    for (let i = 1; i <= 100; i++) {
      history.record('agent1', makeResult('task', { response: `r-${i}` }));
    }
    const results = history.getHistory('agent1');
    expect(results).toHaveLength(100);
  });

  // ─── getLastResult ────────────────────────────────────────────────────────
  it('getLastResult returns the most recent result for a task', () => {
    const history = new HeartbeatHistory();
    history.record('agent1', makeResult('morning-brief', { response: 'first' }));
    history.record('agent1', makeResult('morning-brief', { response: 'second' }));

    const last = history.getLastResult('agent1', 'morning-brief');
    expect(last).not.toBeNull();
    expect(last!.response).toBe('second');
  });

  it('getLastResult returns null when no results exist for the task', () => {
    const history = new HeartbeatHistory();
    expect(history.getLastResult('agent1', 'morning-brief')).toBeNull();
  });

  it('getLastResult returns null for unknown agentId', () => {
    const history = new HeartbeatHistory();
    history.record('agent1', makeResult('morning-brief'));
    expect(history.getLastResult('unknown-agent', 'morning-brief')).toBeNull();
  });

  it('getLastResult returns correct task even when multiple tasks are interleaved', () => {
    const history = new HeartbeatHistory();
    history.record('agent1', makeResult('morning-brief', { response: 'mb-1' }));
    history.record('agent1', makeResult('idle-checkin', { response: 'ic-1' }));
    history.record('agent1', makeResult('morning-brief', { response: 'mb-2' }));

    expect(history.getLastResult('agent1', 'morning-brief')!.response).toBe('mb-2');
    expect(history.getLastResult('agent1', 'idle-checkin')!.response).toBe('ic-1');
  });

  // ─── getHistory returns in reverse-chronological order ───────────────────
  it('getHistory returns results in reverse-chronological order (newest first)', () => {
    const history = new HeartbeatHistory();
    history.record('agent1', makeResult('task', { response: 'oldest' }));
    history.record('agent1', makeResult('task', { response: 'middle' }));
    history.record('agent1', makeResult('task', { response: 'newest' }));

    const results = history.getHistory('agent1');
    expect(results[0].response).toBe('newest');
    expect(results[1].response).toBe('middle');
    expect(results[2].response).toBe('oldest');
  });

  it('getHistory filtered by taskName also returns in reverse-chronological order', () => {
    const history = new HeartbeatHistory();
    history.record('agent1', makeResult('task-a', { response: 'a-1' }));
    history.record('agent1', makeResult('task-b', { response: 'b-1' }));
    history.record('agent1', makeResult('task-a', { response: 'a-2' }));

    const aResults = history.getHistory('agent1', 'task-a');
    expect(aResults[0].response).toBe('a-2');
    expect(aResults[1].response).toBe('a-1');
  });

  // ─── getHistory returns a copy, not the internal array ──────────────────
  it('getHistory returns a copy — mutations do not affect internal state', () => {
    const history = new HeartbeatHistory();
    history.record('agent1', makeResult('task'));

    const results = history.getHistory('agent1');
    results.length = 0; // truncate the returned array

    // Internal state unaffected
    expect(history.getHistory('agent1')).toHaveLength(1);
  });
});
