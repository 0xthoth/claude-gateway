import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createProjectsRouter } from '../../src/api/projects-router';
import type { ApiKey } from '../../src/types';
import { silentLogger } from '../helpers/silent-logger';

const apiKeys: ApiKey[] = [
  { key: 'k-write', agents: '*', write: true, admin: true },
  { key: 'k-read', agents: '*' },
  { key: 'k-agent', agents: ['alfred'], write: true },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });

let base: string;
let root: string;
let outside: string;
let chatting: Set<string>;

const app = (): express.Express => {
  const a = express();
  a.use(express.json());
  a.use('/api', createProjectsRouter(apiKeys, root, { logger: silentLogger, chatTurnActive: (name) => chatting.has(name) }));
  return a;
};
const del = (name = 'api', body: object = { confirm: name }, key = 'k-write') =>
  request(app()).delete(`/api/v1/projects/${name}`).set(as(key)).send(body);
const exists = (...p: string[]) => fs.existsSync(path.join(root, ...p));

beforeEach(() => {
  chatting = new Set();
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-')));
  root = path.join(base, 'projects');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'api', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'api', 'src', 'index.js'), 'x');
  fs.mkdirSync(path.join(root, 'keep'));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('DELETE /api/v1/projects/:name', () => {
  it('removes the project and everything in it, and only that project', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'api' });
    expect(exists('api')).toBe(false);
    expect(exists('keep')).toBe(true);
    const list = await request(app()).get('/api/v1/projects').set(as('k-write'));
    expect(list.body.projects.map((p: { name: string }) => p.name)).toEqual(['keep']);
  });

  it('needs the exact name as confirmation', async () => {
    for (const body of [{}, { confirm: 'API' }, { confirm: 'keep' }, { confirm: true }]) {
      const res = await del('api', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('confirm_mismatch');
    }
    expect(exists('api', 'src', 'index.js')).toBe(true);
  });

  it('needs a key that can write and reach the whole pod', async () => {
    expect((await del('api', { confirm: 'api' }, 'k-read')).status).toBe(403);
    expect((await del('api', { confirm: 'api' }, 'k-agent')).status).toBe(403);
    expect(
      (await request(app()).delete('/api/v1/projects/api').send({ confirm: 'api' })).status,
    ).toBe(401);
    expect(exists('api')).toBe(true);
  });

  it('answers 404 for a project that is not there and 400 for a bad name', async () => {
    expect((await del('ghost')).status).toBe(404);
    const bad = await del('a b', { confirm: 'a b' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_name');
  });

  it('refuses while a chat turn runs in the project, and deletes once it ends', async () => {
    chatting.add('api');
    const blocked = await del();
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('project_running');
    expect(exists('api', 'src', 'index.js')).toBe(true);
    expect((await del('keep')).status).toBe(200);

    chatting.delete('api');
    const res = await del();
    expect(res.status).toBe(200);
    expect(exists('api')).toBe(false);
  });

  it('answers project_deleting to a second delete of the folder, by its name or through a symlink alias', async () => {
    fs.symlinkSync(path.join(root, 'api'), path.join(root, 'alias'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const atRename = new Promise<void>((resolve) => { reached = resolve; });
    const realRename = fs.promises.rename.bind(fs.promises);
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(to)).startsWith('.deleting-')) { reached(); await gate; }
      return realRename(from, to);
    });
    try {
      const first = Promise.resolve(del());
      await atRename;
      const again = await del();
      const viaAlias = await del('alias');
      release();
      expect([again.status, again.body.code]).toEqual([409, 'project_deleting']);
      expect([viaAlias.status, viaAlias.body.code]).toEqual([409, 'project_deleting']);
      expect((await first).status).toBe(200);
    } finally {
      release();
      rename.mockRestore();
    }
  });

  describe('when the busy check throws', () => {
    let failOn: (call: number) => boolean;
    let logged: string[];
    const throwingApp = (): express.Express => {
      const a = express();
      a.use(express.json());
      let calls = 0;
      const logger = { ...silentLogger, error: (m: string) => { logged.push(m); } };
      a.use('/api', createProjectsRouter(apiKeys, root, {
        logger,
        chatTurnActive: (name) => {
          if (failOn(++calls)) throw new Error(`store gone at ${root}/${name} token=hunter2`);
          return false;
        },
      }));
      return a;
    };
    const delVia = (a: express.Express) => request(a).delete('/api/v1/projects/api').set(as('k-write')).send({ confirm: 'api' });

    beforeEach(() => {
      failOn = () => true;
      logged = [];
    });

    it('answers 500 internal and removes nothing', async () => {
      const res = await delVia(throwingApp());
      expect([res.status, res.body]).toEqual([500, { error: 'Internal error', code: 'internal' }]);
      expect(exists('api', 'src', 'index.js')).toBe(true);
    });

    it('logs one line to the injected logger, without the message, and nothing to the console', async () => {
      const spies = (['error', 'warn', 'log', 'info'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
      try {
        await delVia(throwingApp());
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      expect(logged).toEqual(['projects: DELETE /v1/projects/api failed: Error']);
    });

    it('releases the deleting mark, so a later delete succeeds', async () => {
      failOn = (call) => call === 2;
      const a = throwingApp();
      expect((await delVia(a)).status).toBe(500);
      const res = await delVia(a);
      expect([res.status, res.body]).toEqual([200, { name: 'api' }]);
      expect(exists('api')).toBe(false);
    });
  });

  it('removes a link inside the project without touching what it points to', async () => {
    fs.symlinkSync(outside, path.join(root, 'api', 'link-out'));
    expect((await del()).status).toBe(200);
    expect(exists('api')).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  (process.getuid?.() === 0 ? it.skip : it)('never leaves a half-deleted project listed when a subfolder cannot be emptied', async () => {
    fs.writeFileSync(path.join(root, 'api', 'a.txt'), 'a');
    const locked = path.join(root, 'api', 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'b.txt'), 'b');
    fs.chmodSync(locked, 0o500);
    try {
      const res = await del();
      const list = await request(app()).get('/api/v1/projects').set(as('k-write'));
      const names = list.body.projects.map((p: { name: string }) => p.name);
      if (res.status === 200) {
        expect(names).toEqual(['keep']);
        expect(exists('api')).toBe(false);
        expect(res.body).toEqual({ name: 'api', warning: expect.stringContaining('could not be removed') });
      } else {
        expect(names).toEqual(['api', 'keep']);
        expect(exists('api', 'a.txt')).toBe(true);
        expect(exists('api', 'src', 'index.js')).toBe(true);
        expect(exists('api', 'locked', 'b.txt')).toBe(true);
      }
    } finally {
      for (const e of fs.readdirSync(root)) {
        const sub = path.join(root, e, 'locked');
        if (fs.existsSync(sub)) fs.chmodSync(sub, 0o700);
      }
    }
  });

  it('will not follow a project that is a link out of the root', async () => {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const res = await del('escape');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('path_escape');
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
  });
});
