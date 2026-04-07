import express from 'express';
import { EventEmitter } from 'events';
import * as supertest from 'supertest';
import { createApiRouter } from '../../src/api-router';
import { AgentConfig, ApiKey } from '../../src/types';

// ── Minimal mock AgentRunner ─────────────────────────────────────────────────

class MockAgentRunner extends EventEmitter {
  sendApiMessageImpl: (sessionId: string, message: string) => Promise<string>;

  constructor(impl: (sessionId: string, message: string) => Promise<string>) {
    super();
    this.sendApiMessageImpl = impl;
  }

  async sendApiMessage(
    sessionId: string,
    message: string,
    _opts: { timeoutMs: number },
  ): Promise<string> {
    return this.sendApiMessageImpl(sessionId, message);
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

const AGENT_ID = 'alfred';

const agentConfig: AgentConfig = {
  id: AGENT_ID,
  description: 'Personal assistant',
  workspace: '/tmp/alfred',
  env: '',
  telegram: { botToken: 'tok', allowedUsers: [], dmPolicy: 'allowlist' },
  claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
};

const apiKeys: ApiKey[] = [
  { key: 'sk-test-app', agents: [AGENT_ID] },
  { key: 'sk-test-admin', agents: '*' },
];

function buildApp(runnerImpl: (sessionId: string, msg: string) => Promise<string>) {
  const runner = new MockAgentRunner(runnerImpl);
  const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent-runner').AgentRunner]]);
  const configs = new Map([[AGENT_ID, agentConfig]]);
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(runners, configs, apiKeys));
  return app;
}

const AUTH = { Authorization: 'Bearer sk-test-app' };
const POST_URL = `/api/v1/agents/${AGENT_ID}/messages`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/agents/:agentId/messages', () => {
  it('returns 200 with response on success', async () => {
    const app = buildApp(async () => 'Hello!');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'Hi' });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe('Hello!');
    expect(res.body.agent_id).toBe(AGENT_ID);
    expect(typeof res.body.request_id).toBe('string');
    expect(typeof res.body.session_id).toBe('string');
    expect(typeof res.body.duration_ms).toBe('number');
  });

  it('echoes back provided session_id', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'ping', session_id: 'my-session-001' });
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe('my-session-001');
  });

  it('generates a uuid session_id when not provided', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'ping' });
    expect(res.status).toBe(200);
    // UUID v4 pattern
    expect(res.body.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('returns 400 when message is missing', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message is required/i);
  });

  it('returns 400 when message is empty string', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when message exceeds 10,000 chars', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'x'.repeat(10_001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  it('returns 400 when session_id is not a string', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi', session_id: 123 });
    expect(res.status).toBe(400);
  });

  it('returns 401 when no auth header', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .post(POST_URL)
      .send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when key has no access to agent', async () => {
    const app = buildApp(async () => 'ok');
    // Use a key that only accesses a different agent
    const restrictedKeys: ApiKey[] = [{ key: 'sk-test-app', agents: ['other-agent'] }];
    const runner = new MockAgentRunner(async () => 'ok');
    const runners = new Map([[AGENT_ID, runner as unknown as import('../../src/agent-runner').AgentRunner]]);
    const configs = new Map([[AGENT_ID, agentConfig]]);
    const restrictedApp = express();
    restrictedApp.use(express.json());
    restrictedApp.use('/api', createApiRouter(runners, configs, restrictedKeys));
    const res = await supertest.default(restrictedApp)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown agent', async () => {
    const app = buildApp(async () => 'ok');
    const adminAuth = { Authorization: 'Bearer sk-test-admin' };
    const res = await supertest.default(app)
      .post('/api/v1/agents/unknown-agent/messages')
      .set(adminAuth)
      .send({ message: 'hi' });
    expect(res.status).toBe(404);
  });

  it('returns 504 on TIMEOUT error', async () => {
    const app = buildApp(async () => {
      const err = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      throw err;
    });
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi' });
    expect(res.status).toBe(504);
  });

  it('returns 409 on CONFLICT error', async () => {
    const app = buildApp(async () => {
      const err = Object.assign(new Error('conflict'), { code: 'CONFLICT' });
      throw err;
    });
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi' });
    expect(res.status).toBe(409);
  });

  it('returns 500 on unexpected error', async () => {
    const app = buildApp(async () => {
      throw new Error('unexpected');
    });
    const res = await supertest.default(app)
      .post(POST_URL)
      .set(AUTH)
      .send({ message: 'hi' });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/v1/agents', () => {
  it('returns only agents accessible by the key', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .get('/api/v1/agents')
      .set(AUTH); // sk-test-app → only alfred
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].id).toBe(AGENT_ID);
  });

  it('admin key returns all agents', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app)
      .get('/api/v1/agents')
      .set({ Authorization: 'Bearer sk-test-admin' });
    expect(res.status).toBe(200);
    expect(res.body.agents.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 401 without auth', async () => {
    const app = buildApp(async () => 'ok');
    const res = await supertest.default(app).get('/api/v1/agents');
    expect(res.status).toBe(401);
  });
});
