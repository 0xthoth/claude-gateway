import supertest from 'supertest';
import { GatewayRouter } from '../../src/api/gateway-router';
import { GatewayConfig } from '../../src/types';

function makeConfig(corsField: 'allowedOrigins' | 'cors' | 'none', origins?: string[]): GatewayConfig {
  const apiBase = {
    keys: [{ key: 'test-key', description: 'test', agents: ['*'] as unknown as string }],
  } as GatewayConfig['gateway']['api'];

  if (corsField === 'allowedOrigins' && origins) {
    apiBase!.allowedOrigins = origins;
  } else if (corsField === 'cors' && origins) {
    apiBase!.cors = { origins };
  }

  return {
    gateway: { logDir: '/tmp', timezone: 'UTC', api: apiBase },
    agents: [],
  };
}

describe('GatewayRouter CORS', () => {
  it('sets Access-Control-Allow-Origin when origin matches allowedOrigins (legacy field)', async () => {
    const router = new GatewayRouter(new Map(), new Map(), undefined, makeConfig('allowedOrigins', ['http://localhost:3000']));
    const app = router.getApp();
    const res = await supertest(app)
      .get('/api/v1/agents')
      .set('Authorization', 'Bearer test-key')
      .set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('sets Access-Control-Allow-Origin when origin matches cors.origins (config.json field)', async () => {
    const router = new GatewayRouter(new Map(), new Map(), undefined, makeConfig('cors', ['http://localhost:3001']));
    const app = router.getApp();
    const res = await supertest(app)
      .get('/api/v1/agents')
      .set('Authorization', 'Bearer test-key')
      .set('Origin', 'http://localhost:3001');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3001');
  });

  it('blocks unknown origin when cors.origins is set', async () => {
    const router = new GatewayRouter(new Map(), new Map(), undefined, makeConfig('cors', ['http://localhost:3001']));
    const app = router.getApp();
    const res = await supertest(app)
      .get('/api/v1/agents')
      .set('Authorization', 'Bearer test-key')
      .set('Origin', 'http://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows wildcard origin with cors.origins ["*"]', async () => {
    const router = new GatewayRouter(new Map(), new Map(), undefined, makeConfig('cors', ['*']));
    const app = router.getApp();
    const res = await supertest(app)
      .get('/api/v1/agents')
      .set('Authorization', 'Bearer test-key')
      .set('Origin', 'http://anything.example.com');
    expect(res.headers['access-control-allow-origin']).toBeTruthy();
  });

  it('skips CORS middleware when no origins configured', async () => {
    const router = new GatewayRouter(new Map(), new Map(), undefined, makeConfig('none'));
    const app = router.getApp();
    const res = await supertest(app)
      .get('/api/v1/agents')
      .set('Authorization', 'Bearer test-key')
      .set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('handles preflight OPTIONS correctly', async () => {
    const router = new GatewayRouter(new Map(), new Map(), undefined, makeConfig('cors', ['http://localhost:3001']));
    const app = router.getApp();
    const res = await supertest(app)
      .options('/api/v1/agents')
      .set('Origin', 'http://localhost:3001')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3001');
  });
});
