/**
 * The marks API a pod-side cleaner uses to close its check-then-remove race: POST /v1/files/busy, POST /v1/files/marks
 * and DELETE /v1/files/marks/:id. Real AgentRunner, real filesystem, real HTTP through GatewayRouter.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import supertest from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import { createCwdResolver } from '../../src/files/session-cwd';
import { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';
import { silentLogger } from '../helpers/silent-logger';
import { waitForCondition } from '../helpers/wait-for';

const MOCK_CLAUDE = path.resolve(__dirname, '../helpers/mock-claude-argv.js');
const ADMIN: ApiKey = { key: 'sk-admin', agents: '*', admin: true };
const WRITER: ApiKey = { key: 'sk-writer', agents: '*', write: true };

interface Harness {
  base: string;
  root: string;
  argvLog: string;
  app: ReturnType<GatewayRouter['getApp']>;
  runner: AgentRunner;
}

async function harness(): Promise<Harness> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-marks-')));
  const root = path.join(base, 'projects');
  for (const dir of ['site/web', 'other']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.mkdirSync(path.join(base, 'outside'));
  fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'escape'));
  const workspace = path.join(base, 'agents', 'alfred', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '# alfred\n');
  const agent: AgentConfig = { id: 'alfred', description: 'alfred', workspace, env: '', claude: { model: 'claude-test', dangerouslySkipPermissions: true, extraFlags: [] } };
  const gateway: GatewayConfig = {
    gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', orchestration: false, api: { keys: [ADMIN, WRITER] }, files: { root } },
    agents: [agent],
  };
  const runner = new AgentRunner(agent, gateway, undefined, createCwdResolver(gateway, silentLogger));
  const router = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', agent]]), undefined, gateway);
  const argvLog = path.join(base, 'argv.jsonl');
  process.env.MOCK_CLAUDE_ARGV_LOG = argvLog;
  return { base, root, argvLog, app: router.getApp(), runner };
}

const spawnCount = (h: Harness): number => (fs.existsSync(h.argvLog) ? fs.readFileSync(h.argvLog, 'utf8').trim().split('\n').length : 0);
const as = (key: ApiKey) => `Bearer ${key.key}`;
const mark = (h: Harness, body: Record<string, unknown>, key = ADMIN) => supertest(h.app).post('/api/v1/files/marks').set('Authorization', as(key)).send(body);
const release = (h: Harness, id: string) => supertest(h.app).delete(`/api/v1/files/marks/${id}`).set('Authorization', as(ADMIN));
const busy = (h: Harness, paths: unknown) => supertest(h.app).post('/api/v1/files/busy').set('Authorization', as(ADMIN)).send({ paths });
const del = (h: Harness, rel: string) => supertest(h.app).delete('/api/v1/files').set('Authorization', as(ADMIN)).send({ path: rel, confirm: rel.split('/').pop() });
const createSession = (h: Harness, cwd: string) => supertest(h.app).post('/api/v1/agents/alfred/sessions').set('Authorization', as(ADMIN)).query({ chat_id: 'web' }).send({ cwd });
const send = (h: Harness, sessionId: string, message: string) => supertest(h.app).post('/api/v1/agents/alfred/messages').set('Authorization', as(ADMIN)).send({ message, chat_id: 'web', session_id: sessionId });
const cleaning = (rel: string) => ({ path: rel, purpose: 'cleaning', ttlSec: 60 });

describe('files marks', () => {
  let h: Harness;
  beforeAll(() => { process.env.CLAUDE_BIN = `node ${MOCK_CLAUDE}`; });
  afterAll(() => { delete process.env.CLAUDE_BIN; delete process.env.MOCK_CLAUDE_ARGV_LOG; });
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => {
    jest.restoreAllMocks();
    await h.runner.stop().catch(() => {});
    fs.rmSync(h.base, { recursive: true, force: true });
  });

  it('takes a mark and answers its id, path, real folder, purpose and expiry', async () => {
    const before = Date.now();
    const res = await mark(h, cleaning('site'));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ markId: expect.stringMatching(/^[0-9a-f-]{36}$/), path: 'site', abs: path.join(h.root, 'site'), purpose: 'cleaning', expiresAt: expect.any(String) });
    const expires = Date.parse(res.body.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it.each([
    ['an unknown purpose', { path: 'site', purpose: 'wiping', ttlSec: 60 }, 400, 'invalid_mark'],
    ['a ttl under 60 s', { path: 'site', purpose: 'cleaning', ttlSec: 59 }, 400, 'invalid_mark'],
    ['a ttl over 300 s', { path: 'site', purpose: 'cleaning', ttlSec: 301 }, 400, 'invalid_mark'],
    ['a fractional ttl', { path: 'site', purpose: 'cleaning', ttlSec: 60.5 }, 400, 'invalid_mark'],
    ['the root', cleaning(''), 400, 'invalid_path'],
    ['a traversal', cleaning('../x'), 400, 'invalid_name'],
    ['a link out of the root', cleaning('escape'), 403, 'path_escape'],
    ['a missing folder', cleaning('nope'), 404, 'not_found'],
    ['a file', cleaning('notes.txt'), 400, 'not_a_directory'],
  ])('refuses %s', async (_name, body, status, code) => {
    fs.writeFileSync(path.join(h.root, 'notes.txt'), 'x');
    const res = await mark(h, body);
    expect([res.status, res.body.code]).toEqual([status, code]);
  });

  it('refuses a non-admin key on every marks route', async () => {
    expect((await mark(h, cleaning('site'), WRITER)).body.code).toBe('forbidden_key');
    expect((await supertest(h.app).post('/api/v1/files/busy').set('Authorization', as(WRITER)).send({ paths: ['site'] })).body.code).toBe('forbidden_key');
    const held = await mark(h, cleaning('site'));
    const res = await supertest(h.app).delete(`/api/v1/files/marks/${held.body.markId}`).set('Authorization', as(WRITER));
    expect(res.status).toBe(403);
    expect((await mark(h, cleaning('site'))).body.code).toBe('marked');
  });

  it('refuses an overlapping mark: the same folder, one inside it, one holding it, through an alias; a sibling is free', async () => {
    fs.symlinkSync(path.join(h.root, 'site'), path.join(h.root, 'alias'));
    expect((await mark(h, cleaning('site/web'))).status).toBe(201);
    for (const rel of ['site/web', 'site', 'alias']) {
      const res = await mark(h, cleaning(rel));
      expect([rel, res.status, res.body.code]).toEqual([rel, 409, 'marked']);
    }
    expect((await mark(h, cleaning('other'))).status).toBe(201);
  });

  it('refuses a delete that overlaps a mark and leaves the folder in place', async () => {
    await mark(h, cleaning('site/web'));
    for (const rel of ['site', 'site/web']) {
      const res = await del(h, rel);
      expect([rel, res.status, res.body.code]).toEqual([rel, 409, 'marked']);
    }
    expect(fs.existsSync(path.join(h.root, 'site', 'web'))).toBe(true);
    expect((await del(h, 'other')).status).toBe(200);
  });

  it('refuses a new folder inside a marked folder with 409 marked, and creates it once released; a sibling of a marked folder is free', async () => {
    const mkdir = (rel: string) => supertest(h.app).post('/api/v1/files/mkdir').set('Authorization', as(ADMIN)).send({ path: rel });
    const held = await mark(h, cleaning('site'));
    for (const rel of ['site/new', 'site/web/new']) {
      const res = await mkdir(rel);
      expect([rel, res.status, res.body.code]).toEqual([rel, 409, 'marked']);
      expect(fs.existsSync(path.join(h.root, rel))).toBe(false);
    }
    await release(h, held.body.markId);
    await mark(h, cleaning('site/web'));
    expect((await mkdir('site/new')).status).toBe(201);
    expect((await mkdir('site/web/new')).body.code).toBe('marked');
  });

  it('releases idempotently, and an unknown id is not an error', async () => {
    const held = await mark(h, cleaning('site'));
    expect((await release(h, held.body.markId)).status).toBe(204);
    expect((await release(h, held.body.markId)).status).toBe(204);
    expect((await release(h, '00000000-0000-4000-8000-000000000000')).status).toBe(204);
    expect((await del(h, 'site')).status).toBe(200);
  });

  it('expires on its own after ttlSec, so a cleaner that crashed frees the folder', async () => {
    await mark(h, cleaning('site'));
    expect((await mark(h, cleaning('site'))).body.code).toBe('marked');
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect((await mark(h, cleaning('site'))).status).toBe(201);
  });

  it('refuses a new chat, a turn and a respawn in a marked folder with path_marked, and lets them run once released', async () => {
    const bound = await createSession(h, 'site/web');
    expect(bound.status).toBe(201);
    const held = await mark(h, cleaning('site'));
    expect(held.status).toBe(201);

    const created = await createSession(h, 'site');
    expect([created.status, created.body.code]).toEqual([409, 'path_marked']);
    const turn = await send(h, bound.body.sessionId, 'hello');
    expect([turn.status, turn.body.code]).toEqual([409, 'PATH_MARKED']);
    const streamed = await supertest(h.app).post('/api/v1/agents/alfred/messages').set('Authorization', as(ADMIN))
      .send({ message: 'hello', chat_id: 'web', session_id: bound.body.sessionId, stream: true });
    expect(streamed.status).toBe(200);
    expect(streamed.text).toMatch(/"type":"error"[^\n]*"code":"PATH_MARKED"/);
    expect(spawnCount(h)).toBe(0);
    const list = await supertest(h.app).get('/api/v1/agents/alfred/sessions').set('Authorization', as(ADMIN)).query({ chat_id: 'web' });
    expect(list.body.sessions.find((s: { id: string }) => s.id === bound.body.sessionId)).toMatchObject({ cwd: path.join(h.root, 'site', 'web'), cwdState: 'unavailable', active: false });

    await release(h, held.body.markId);
    expect((await send(h, bound.body.sessionId, 'hello')).status).toBe(200);
    expect(spawnCount(h)).toBe(1);
  }, 30_000);

  it('refuses a mark while a turn works in the folder, then takes it once the turn ends', async () => {
    const bound = await createSession(h, 'site/web');
    const turn = Promise.resolve(send(h, bound.body.sessionId, 'HOLD-TURN'));
    await waitForCondition(() => spawnCount(h) > 0, 10_000);

    const refused = await mark(h, cleaning('site'));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'in_use', reasons: ['turn'] });
    const report = await busy(h, ['site', 'other', 'nope']);
    expect(report.body.results).toEqual([
      { path: 'site', abs: path.join(h.root, 'site'), busy: true, reasons: ['turn', 'session'] },
      { path: 'other', abs: path.join(h.root, 'other'), busy: false, reasons: [] },
      { path: 'nope', abs: null, busy: false, reasons: [], error: 'not_found' },
    ]);

    await supertest(h.app).post(`/api/v1/agents/alfred/sessions/${bound.body.sessionId}/stop`).set('Authorization', as(ADMIN)).query({ chat_id: 'web' });
    await turn;
    await waitForCondition(() => !h.runner.hasActiveApiSession(bound.body.sessionId), 10_000);
    expect((await mark(h, cleaning('site'))).status).toBe(201);
  }, 30_000);

  it('reports an idle session process as a reason that does not make the folder busy', async () => {
    const bound = await createSession(h, 'site');
    expect((await send(h, bound.body.sessionId, 'hello')).status).toBe(200);
    const report = await busy(h, ['site']);
    expect(report.body.results[0]).toMatchObject({ busy: false, reasons: ['session'] });
    expect((await mark(h, cleaning('site'))).status).toBe(201);
    expect((await busy(h, ['site/web'])).body.results[0]).toMatchObject({ busy: true, reasons: ['marked', 'session'] });
  }, 30_000);

  it('validates the busy request: 1 to 200 paths, each a non-root path', async () => {
    for (const paths of [[], 'site', Array(201).fill('site')]) expect((await busy(h, paths)).body.code).toBe('invalid_mark');
    expect((await busy(h, [''])).body.code).toBe('invalid_path');
    expect((await busy(h, ['a//b'])).body.code).toBe('invalid_path');
  });

  it('answers deleting to a mark taken while a delete is mid-rename, and never lets both win', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    let reached!: () => void;
    const atRename = new Promise<void>((resolve) => { reached = resolve; });
    const realRename = fs.promises.rename.bind(fs.promises);
    jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (!path.basename(String(to)).startsWith('.deleting-')) return realRename(from, to);
      reached();
      await gate;
      return realRename(from, to);
    });
    const deleting = Promise.resolve(del(h, 'site'));
    await atRename;
    const res = await mark(h, cleaning('site/web'));
    expect([res.status, res.body.code]).toEqual([409, 'deleting']);
    unblock();
    expect((await deleting).status).toBe(200);
  });

  it('lets exactly one of a delete and a mark sent at once win', async () => {
    for (let i = 0; i < 10; i++) {
      const rel = `race${i}`;
      fs.mkdirSync(path.join(h.root, rel));
      const [d, m] = await Promise.all([del(h, rel), mark(h, cleaning(rel))]);
      const winners = [d.status === 200, m.status === 201].filter(Boolean).length;
      expect([rel, winners]).toEqual([rel, 1]);
      if (m.status === 201) expect(fs.existsSync(path.join(h.root, rel))).toBe(true);
    }
  });

  it('lets exactly one of a turn and a mark sent at once run in the folder', async () => {
    const bound = await createSession(h, 'site');
    const [turn, held] = await Promise.all([send(h, bound.body.sessionId, 'hello'), mark(h, cleaning('site'))]);
    const turnRan = turn.status === 200;
    const marked = held.status === 201;
    expect([turnRan, marked].filter(Boolean)).toHaveLength(1);
    if (marked) expect(turn.body.code).toBe('PATH_MARKED');
    else expect(held.body).toMatchObject({ code: 'in_use' });
  }, 30_000);
});
