import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createFilesRouter } from '../../src/api/files-router';
import type { ApiKey } from '../../src/types';
import { silentLogger } from '../helpers/silent-logger';

const apiKeys: ApiKey[] = [
  { key: 'k-pod-write', agents: '*', write: true, admin: true },
  { key: 'k-pod-read', agents: '*' },
  { key: 'k-agent', agents: ['alfred'], write: true },
];
const as = (key: string) => ({ Authorization: `Bearer ${key}` });
const POD = as('k-pod-write');

let base: string;
let root: string;
let outside: string;
let app: express.Express;
let inUse: (realDir: string) => boolean;

function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function seed(): void {
  // A node project: node_modules is cleanable because package.json sits at the top.
  write(path.join(root, 'app', 'package.json'), '{}');
  write(path.join(root, 'app', 'src', 'index.js'));
  write(path.join(root, 'app', 'node_modules', 'dep', 'index.js'));
  // A Python project: .venv is cleanable because pyvenv.cfg is inside it and a requirements file is at the top.
  write(path.join(root, 'py', 'requirements.txt'));
  write(path.join(root, 'py', 'src', 'main.py'));
  write(path.join(root, 'py', '.venv', 'pyvenv.cfg'));
  write(path.join(root, 'py', '.venv', 'bin', 'python'));
  // A folder named like a cache but with nothing that says it is one.
  write(path.join(root, 'bare', 'src', 'a.txt'));
  write(path.join(root, 'bare', 'node_modules', 'x.js'));
  // A node_modules that is a link. Removing it would still reach the folder it points to.
  write(path.join(root, 'linked', 'package.json'), '{}');
  write(path.join(outside, 'precious.txt'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'linked', 'node_modules'));
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-cleanup-')));
  root = path.join(base, 'projects');
  outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  seed();
  inUse = () => false;
  app = express();
  app.use(express.json());
  app.use('/api', createFilesRouter(apiKeys, root, { logger: silentLogger, inUse: (dir) => inUse(dir) }));
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('GET /v1/files/cleanup/candidates', () => {
  it('lists only the folders the gateway knows are cleanable, with their markers present', async () => {
    const res = await request(app).get('/api/v1/files/cleanup/candidates').set(POD);
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([
      { project: 'app', folder: 'node_modules' },
      { project: 'py', folder: '.venv' },
    ]);
  });

  it('lists nothing it cannot prove cleanable, and answers only an admin key', async () => {
    const res = await request(app).get('/api/v1/files/cleanup/candidates').set(POD);
    expect(res.body.candidates.map((c: { project: string }) => c.project)).not.toContain('bare');
    expect(res.body.candidates.map((c: { project: string }) => c.project)).not.toContain('linked');
    expect((await request(app).get('/api/v1/files/cleanup/candidates').set(as('k-pod-read'))).status).toBe(403);
    expect((await request(app).get('/api/v1/files/cleanup/candidates').set(as('k-agent'))).status).toBe(403);
  });
});

describe('POST /v1/files/cleanup', () => {
  it('removes the selected candidates and leaves the rest of each project alone', async () => {
    const res = await request(app)
      .post('/api/v1/files/cleanup')
      .set(POD)
      .send({ items: [{ project: 'app', folder: 'node_modules' }, { project: 'py', folder: '.venv' }] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { project: 'app', folder: 'node_modules', state: 'removed' },
      { project: 'py', folder: '.venv', state: 'removed' },
    ]);
    expect(fs.existsSync(path.join(root, 'app', 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'py', '.venv'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'app', 'src', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'py', 'src', 'main.py'))).toBe(true);
  });

  it('refuses a folder that is not on the gateway list, and removes nothing', async () => {
    const res = await request(app)
      .post('/api/v1/files/cleanup')
      .set(POD)
      .send({ items: [{ project: 'bare', folder: 'src' }, { project: 'app', folder: 'src' }] });
    expect(res.body.results).toEqual([
      { project: 'bare', folder: 'src', state: 'failed', code: 'not_a_candidate' },
      { project: 'app', folder: 'src', state: 'failed', code: 'not_a_candidate' },
    ]);
    expect(fs.existsSync(path.join(root, 'bare', 'src', 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'app', 'src', 'index.js'))).toBe(true);
  });

  it('refuses node_modules in a project with no package.json at its top', async () => {
    const res = await request(app).post('/api/v1/files/cleanup').set(POD).send({ items: [{ project: 'bare', folder: 'node_modules' }] });
    expect(res.body.results).toEqual([{ project: 'bare', folder: 'node_modules', state: 'failed', code: 'not_a_candidate' }]);
    expect(fs.existsSync(path.join(root, 'bare', 'node_modules', 'x.js'))).toBe(true);
  });

  it('refuses a node_modules that is a link, and leaves the folder it points to', async () => {
    const res = await request(app).post('/api/v1/files/cleanup').set(POD).send({ items: [{ project: 'linked', folder: 'node_modules' }] });
    expect(res.body.results).toEqual([{ project: 'linked', folder: 'node_modules', state: 'failed', code: 'not_a_candidate' }]);
    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
  });

  it('refuses a project name that walks out of the root', async () => {
    const res = await request(app).post('/api/v1/files/cleanup').set(POD).send({ items: [{ project: '..', folder: 'node_modules' }] });
    expect(res.body.results).toEqual([{ project: '..', folder: 'node_modules', state: 'failed', code: 'invalid_name' }]);
    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
  });

  it('skips a candidate that a chat, task or mark is using, and reports why', async () => {
    inUse = (dir) => dir.endsWith(path.join('app', 'node_modules'));
    const res = await request(app).post('/api/v1/files/cleanup').set(POD).send({ items: [{ project: 'app', folder: 'node_modules' }] });
    expect(res.body.results).toEqual([{ project: 'app', folder: 'node_modules', state: 'skipped', code: 'in_use' }]);
    expect(fs.existsSync(path.join(root, 'app', 'node_modules', 'dep', 'index.js'))).toBe(true);
  });

  it('needs an admin key', async () => {
    const body = { items: [{ project: 'app', folder: 'node_modules' }] };
    expect((await request(app).post('/api/v1/files/cleanup').set(as('k-pod-read')).send(body)).status).toBe(403);
    expect((await request(app).post('/api/v1/files/cleanup').set(as('k-agent')).send(body)).status).toBe(403);
    expect(fs.existsSync(path.join(root, 'app', 'node_modules'))).toBe(true);
  });

  it('answers 400 for an empty or oversized list', async () => {
    expect((await request(app).post('/api/v1/files/cleanup').set(POD).send({ items: [] })).status).toBe(400);
    const many = Array.from({ length: 201 }, () => ({ project: 'app', folder: 'node_modules' }));
    expect((await request(app).post('/api/v1/files/cleanup').set(POD).send({ items: many })).status).toBe(400);
  });
});
