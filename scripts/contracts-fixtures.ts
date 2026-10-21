/**
 * Records the golden fixtures of the files and git API from real responses of the real routers.
 *
 * Run:   npm run contracts:fixtures           (rewrites contracts/files-git/fixtures)
 * Check: tests/unit/files-contracts.test.ts   (fails when a fixture is stale or breaks its schema)
 *
 * The routers run in process on a throwaway root, and git reads a throwaway global config. Values that change from run
 * to run or release to release (the temp path, the time a folder is created, a random trash name, the gateway version)
 * are replaced by fixed ones, so a fixture changes only when a response does.
 */
import { execFileSync } from 'child_process';
import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createCapabilitiesRouter } from '../src/api/capabilities';
import { createFilesRouter } from '../src/api/files-router';
import { overlaps } from '../src/files/paths';
import type { ApiKey, GatewayConfig, Logger } from '../src/types';

export const CONTRACTS_DIR = path.join(__dirname, '..', 'contracts', 'files-git');
export const FIXTURES_DIR = path.join(CONTRACTS_DIR, 'fixtures');

/** The root every fixture shows, in place of the throwaway one. */
const SHOWN_ROOT = '/home/user/projects';
const FIXED_TIME = new Date('2026-01-02T03:04:05.000Z');

export type SchemaName = 'FilesList' | 'FilesMkdirResponse' | 'FilesDeleteResponse' | 'GitStatus' | 'GitSummary' | 'Capabilities' | 'Error';

export interface Fixture {
  request: { method: 'GET' | 'POST' | 'DELETE'; url: string; key: 'admin' | 'reader'; body?: unknown };
  status: number;
  schema: SchemaName;
  body: unknown;
}

const KEYS: Record<Fixture['request']['key'], ApiKey> = {
  admin: { key: 'k-admin', agents: '*', write: true, admin: true },
  reader: { key: 'k-reader', agents: '*' },
};

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ann Dev', GIT_AUTHOR_EMAIL: 'ann@example.com', GIT_COMMITTER_NAME: 'Ann Dev', GIT_COMMITTER_EMAIL: 'ann@example.com',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, stdio: 'pipe' });

function repo(dir: string, remote?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'First commit');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(dir, 'notes.md'), 'untracked\n');
}

/** Every folder under the root gets one fixed mtime, so `modified_at` is stable. */
function pinTimes(dir: string): void {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== '.git') pinTimes(path.join(dir, d.name));
  }
  fs.utimesSync(dir, FIXED_TIME, FIXED_TIME);
}

function seed(root: string, outside: string): void {
  fs.mkdirSync(outside, { recursive: true });
  repo(path.join(root, 'app'), 'https://ann:secret-token@github.com/acme/app.git');
  fs.mkdirSync(path.join(root, 'site', 'web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'site', 'node_modules', 'left-pad'), { recursive: true });
  repo(path.join(root, 'site', 'api'));
  fs.mkdirSync(path.join(root, 'Bad Name'));
  fs.mkdirSync(path.join(root, '.deleting-old-00000000-0000-0000-0000-000000000000'));
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.symlinkSync(path.join(root, 'site'), path.join(root, 'alias'));
  fs.mkdirSync(path.join(root, 'busy'));
  fs.mkdirSync(path.join(root, 'locked', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'locked', 'sub', 'f.txt'), 'x');
  pinTimes(root);
}

type Step = [name: string, req: Fixture['request'], schema: SchemaName, prepare?: () => void];

/** Runs every step against fresh routers and returns the fixtures keyed by their path under FIXTURES_DIR. */
export async function recordFixtures(): Promise<Record<string, Fixture>> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-')));
  const root = path.join(base, 'projects');
  const outside = path.join(base, 'outside');
  const gitConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(gitConfig, '[init]\n\tdefaultBranch = main\n');
  const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
  try {
    seed(root, outside);
    const config = { gateway: { orchestration: true }, agents: [] } as unknown as GatewayConfig;
    const app = express();
    app.use(express.json());
    app.use('/api', createCapabilitiesRouter(Object.values(KEYS), config));
    app.use('/api', createFilesRouter(Object.values(KEYS), root, { logger: quiet, inUse: (dir) => overlaps(path.join(root, 'busy'), dir) }));
    const thrower = express();
    thrower.use(express.json());
    thrower.use('/api', createFilesRouter(Object.values(KEYS), root, { logger: quiet, inUse: () => { throw new Error('boom'); } }));
    const disabled = express();
    disabled.use('/api', createCapabilitiesRouter(Object.values(KEYS), { gateway: { files: { enabled: false } }, agents: [] } as unknown as GatewayConfig));

    const steps: Step[] = [
      ['capabilities/admin', { method: 'GET', url: '/api/v1/capabilities', key: 'admin' }, 'Capabilities'],
      ['capabilities/reader', { method: 'GET', url: '/api/v1/capabilities', key: 'reader' }, 'Capabilities'],
      ['files-list/root', { method: 'GET', url: '/api/v1/files', key: 'reader' }, 'FilesList'],
      ['files-list/nested', { method: 'GET', url: '/api/v1/files?path=site', key: 'reader' }, 'FilesList'],
      ['files-list/path_escape', { method: 'GET', url: '/api/v1/files?path=escape', key: 'reader' }, 'Error'],
      ['files-list/invalid_name', { method: 'GET', url: '/api/v1/files?path=..', key: 'reader' }, 'Error'],
      ['files-list/invalid_path', { method: 'GET', url: '/api/v1/files?path=%2Fetc', key: 'reader' }, 'Error'],
      ['files-list/not_found', { method: 'GET', url: '/api/v1/files?path=nope', key: 'reader' }, 'Error'],
      ['files-mkdir/created', { method: 'POST', url: '/api/v1/files/mkdir', key: 'admin', body: { path: 'demo' } }, 'FilesMkdirResponse'],
      ['files-mkdir/created_nested_git', { method: 'POST', url: '/api/v1/files/mkdir', key: 'admin', body: { path: 'site/docs', git_init: true } }, 'FilesMkdirResponse'],
      ['files-mkdir/already_exists', { method: 'POST', url: '/api/v1/files/mkdir', key: 'admin', body: { path: 'APP' } }, 'Error'],
      ['files-mkdir/not_found', { method: 'POST', url: '/api/v1/files/mkdir', key: 'admin', body: { path: 'nope/new' } }, 'Error'],
      ['files-mkdir/forbidden_key', { method: 'POST', url: '/api/v1/files/mkdir', key: 'reader', body: { path: 'demo2' } }, 'Error'],
      ['files-delete/confirm_mismatch', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'site/web', confirm: 'site/web' } }, 'Error'],
      ['files-delete/invalid_path_root', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: '', confirm: '' } }, 'Error'],
      ['files-delete/symlink_in_path', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'alias/web', confirm: 'web' } }, 'Error'],
      ['files-delete/in_use', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'busy', confirm: 'busy' } }, 'Error'],
      ['files-delete/deleted_nested', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'site/node_modules', confirm: 'node_modules' } }, 'FilesDeleteResponse'],
      ['files-delete/deleted_with_warning', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'locked', confirm: 'locked' } }, 'FilesDeleteResponse', () => fs.chmodSync(path.join(root, 'locked', 'sub'), 0o555)],
      ['git-status/repo', { method: 'GET', url: '/api/v1/git/status?path=app', key: 'reader' }, 'GitStatus'],
      ['git-status/not_a_git_repo', { method: 'GET', url: '/api/v1/git/status?path=site/web', key: 'reader' }, 'Error'],
      ['git-summary/nested', { method: 'GET', url: '/api/v1/git/summary?path=site', key: 'reader' }, 'GitSummary'],
    ];

    const out: Record<string, Fixture> = {};
    const shown = (value: unknown): unknown => JSON.parse(JSON.stringify(value)
      .split(root).join(SHOWN_ROOT)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '00000000-0000-0000-0000-000000000000'));
    const record = async (name: string, target: express.Express, req: Fixture['request'], schema: SchemaName) => {
      let call = request(target)[req.method === 'GET' ? 'get' : req.method === 'POST' ? 'post' : 'delete'](req.url).set('Authorization', `Bearer ${KEYS[req.key].key}`);
      if (req.body !== undefined) call = call.send(req.body as object);
      const res = await call;
      const body = shown(res.body) as { version?: string };
      if (schema === 'Capabilities') body.version = '0.0.0';
      out[`${name}.json`] = { request: req, status: res.status, schema, body };
    };
    for (const [name, req, schema, prepare] of steps) {
      prepare?.();
      await record(name, app, req, schema);
      const body = out[`${name}.json`]!.body as { entry?: { modified_at: string } };
      // A created folder carries the time it was made.
      if (body.entry) body.entry.modified_at = FIXED_TIME.toISOString();
      pinTimes(root);
    }
    await record('capabilities/disabled', disabled, { method: 'GET', url: '/api/v1/capabilities', key: 'admin' }, 'Capabilities');
    await record('errors/internal', thrower, { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'busy', confirm: 'busy' } }, 'Error');
    return out;
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    execFileSync('chmod', ['-R', 'u+w', base]);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

export function writeFixtures(fixtures: Record<string, Fixture>): void {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  for (const [rel, fixture] of Object.entries(fixtures)) {
    const file = path.join(FIXTURES_DIR, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
  }
}

if (require.main === module) {
  recordFixtures().then((fixtures) => {
    writeFixtures(fixtures);
    console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${path.relative(process.cwd(), FIXTURES_DIR)}`);
  }, (e) => {
    console.error(e);
    process.exit(1);
  });
}
