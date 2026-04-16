import { createServer } from 'http';
import express from 'express';
import { createApiAuthMiddleware, canAccessAgent } from '../../src/api/auth';
import { ApiKey } from '../../src/types';
import * as supertest from 'supertest';

const TEST_KEYS: ApiKey[] = [
  { key: 'sk-gateway-abc123', description: 'App key', agents: ['alfred'] },
  { key: 'sk-gateway-admin00', description: 'Admin key', agents: '*' },
];

function buildApp(keys: ApiKey[]) {
  const app = express();
  app.use(express.json());
  const auth = createApiAuthMiddleware(keys);
  app.get('/protected', auth, (_req, res) => res.json({ ok: true }));
  return app;
}

describe('createApiAuthMiddleware', () => {
  it('allows valid Bearer token', async () => {
    const app = buildApp(TEST_KEYS);
    const res = await supertest.default(app)
      .get('/protected')
      .set('Authorization', 'Bearer sk-gateway-abc123');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('allows valid X-Api-Key header', async () => {
    const app = buildApp(TEST_KEYS);
    const res = await supertest.default(app)
      .get('/protected')
      .set('X-Api-Key', 'sk-gateway-abc123');
    expect(res.status).toBe(200);
  });

  it('returns 401 when no auth header is present', async () => {
    const app = buildApp(TEST_KEYS);
    const res = await supertest.default(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing api key/i);
  });

  it('returns 403 for an invalid key', async () => {
    const app = buildApp(TEST_KEYS);
    const res = await supertest.default(app)
      .get('/protected')
      .set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/invalid api key/i);
  });

  it('attaches matched apiKey to req', async () => {
    const app = express();
    app.use(express.json());
    const auth = createApiAuthMiddleware(TEST_KEYS);
    app.get('/check', auth, (req, res) => {
      res.json({ key: (req as express.Request & { apiKey: ApiKey }).apiKey.description });
    });
    const res = await supertest.default(app)
      .get('/check')
      .set('Authorization', 'Bearer sk-gateway-admin00');
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('Admin key');
  });

  it('handles length-mismatch safely (no throw)', async () => {
    const app = buildApp(TEST_KEYS);
    const res = await supertest.default(app)
      .get('/protected')
      .set('Authorization', 'Bearer short');
    expect(res.status).toBe(403);
  });
});

describe('canAccessAgent', () => {
  const appKey: ApiKey = { key: 'x', agents: ['alfred', 'baerbel'] };
  const adminKey: ApiKey = { key: 'y', agents: '*' };

  it('returns true when agentId is in agents array', () => {
    expect(canAccessAgent(appKey, 'alfred')).toBe(true);
  });

  it('returns false when agentId is not in agents array', () => {
    expect(canAccessAgent(appKey, 'unknown')).toBe(false);
  });

  it('returns true for any agentId when agents is "*"', () => {
    expect(canAccessAgent(adminKey, 'alfred')).toBe(true);
    expect(canAccessAgent(adminKey, 'anything')).toBe(true);
  });
});
