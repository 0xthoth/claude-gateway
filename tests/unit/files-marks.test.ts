import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findHold, releaseHold } from '../../src/files/holds';
import { busyPaths, FolderWork, releaseMark, takeMark } from '../../src/files/marks';
import { RelPath } from '../../src/files/paths';
import type { WorkReason } from '../../src/session/cwd';

describe('takeMark', () => {
  let root: string;
  const held: string[] = [];
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marks-unit-')));
    fs.mkdirSync(path.join(root, 'app'));
  });
  afterEach(() => {
    for (const id of held.splice(0)) releaseHold(id);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('checks for work and inserts the mark in one synchronous step, so work queued meanwhile sees the mark', async () => {
    let seenByConcurrentWork: unknown = 'not run';
    const work: FolderWork = {
      prepare: async () => {},
      reasons: (dir) => {
        // Whatever the event loop runs next, a turn starting say, must already find the mark.
        queueMicrotask(() => { seenByConcurrentWork = findHold(dir)?.kind; });
        return new Set<WorkReason>();
      },
    };
    const mark = await takeMark(root, 'app' as RelPath, 'cleaning', 60, work);
    expect(mark.ok).toBe(true);
    if (mark.ok) held.push(mark.value.markId);
    expect(seenByConcurrentWork).toBe('mark');
  });

  it('refuses with the blocking reasons and leaves no mark when the folder is busy', async () => {
    const work: FolderWork = { prepare: async () => {}, reasons: () => new Set<WorkReason>(['session', 'task']) };
    const mark = await takeMark(root, 'app' as RelPath, 'cleaning', 60, work);
    expect(mark).toEqual({ ok: false, error: { code: 'in_use', reasons: ['task'] } });
    expect(findHold(path.join(root, 'app'))).toBeUndefined();
  });

  it('releases a mark so the folder reads idle again', async () => {
    const idle: FolderWork = { prepare: async () => {}, reasons: () => new Set() };
    const mark = await takeMark(root, 'app' as RelPath, 'cleaning', 60, idle);
    if (!mark.ok) throw new Error('mark refused');
    held.push(mark.value.markId);
    releaseMark(mark.value.markId);
    expect(findHold(path.join(root, 'app'))).toBeUndefined();
    const report = await busyPaths(root, ['app' as RelPath], idle);
    expect(report).toEqual([{ path: 'app', abs: path.join(root, 'app'), busy: false, reasons: [] }]);
  });
});
