/**
 * HTTP-level tests for the SMS channel management surface on the agents API:
 *  - PATCH /api/v1/agents/:id accepts sms_account_sid + sms_auth_token +
 *    sms_from_number (all three or none — unlike Slack's two-credential
 *    both-or-neither, Twilio needs three). No live Save-time verification
 *    (unlike Slack's auth.test): Twilio has no cheap "verify these creds"
 *    call, so a bad credential surfaces on the first real send instead.
 *  - GET  /api/v1/agents exposes sms_connected / sms_token_preview /
 *    sms_from_number / sms_webhook_path.
 *
 * Mirrors tests/unit/api-router-slack.test.ts's structure. Uses a real temp
 * config.json because the route persists via writeAgentsToConfig().
 */
import express from 'express';
import * as supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApiRouter } from '../../src/api/router';
import { _resetPendingSenders } from '../../src/api/pending-senders';
import { AgentConfig, ApiKey } from '../../src/types';

const AGENT_ID = 'alfred';
const ADMIN = { Authorization: 'Bearer sk-test-admin' };
// Deliberately NOT a real Twilio Account SID shape (32 hex chars after "AC") —
// GitHub's secret-scanning push protection pattern-matches that exact format
// regardless of realness, so this uses non-hex filler to stay a valid-looking
// fixture without tripping it (same placeholder style as the UI's own
// credential1Placeholder in agents-panel.tsx's SMS_CARD_STATIC).
const VALID_SID = 'ACtest-account-sid-not-a-real-value';
const VALID_TOKEN = 'twilio-auth-token-abcdef';
const VALID_FROM = '+15551234567';

function makeAgentConfig(): AgentConfig {
  return {
    id: AGENT_ID,
    description: 'Personal assistant',
    workspace: '/tmp/alfred',
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
  };
}

describe('SMS channel management API', () => {
  let tmpDir: string;
  let configPath: string;
  let configs: Map<string, AgentConfig>;
  let app: express.Express;

  const apiKeys: ApiKey[] = [{ key: 'sk-test-admin', agents: '*', admin: true }];

  beforeEach(() => {
    _resetPendingSenders();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sms-api-'));
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        { gateway: { logDir: '~/logs', timezone: 'UTC' }, agents: [makeAgentConfig()] },
        null,
        2,
      ),
    );
    configs = new Map([[AGENT_ID, makeAgentConfig()]]);
    const runners = new Map();
    app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(runners, configs, apiKeys, configPath));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const patch = (body: Record<string, unknown>) =>
    supertest.default(app).patch(`/api/v1/agents/${AGENT_ID}`).set(ADMIN).send(body);

  it('connects SMS when all three credentials are provided', async () => {
    const res = await patch({
      sms_account_sid: VALID_SID,
      sms_auth_token: VALID_TOKEN,
      sms_from_number: VALID_FROM,
    });
    expect(res.status).toBe(200);
    expect(res.body.agent.sms_connected).toBe(true);
    expect(res.body.agent.sms_webhook_path).toBe(`/webhooks/sms/${AGENT_ID}`);
    expect(res.body.agent.sms_from_number).toBe(VALID_FROM);
    expect(res.body.agent.sms_token_preview).toBeTruthy();
    expect(res.body.agent.sms_token_preview).not.toContain(VALID_SID); // masked

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].sms).toEqual({
      accountSid: VALID_SID,
      authToken: VALID_TOKEN,
      fromNumber: VALID_FROM,
    });
    expect(configs.get(AGENT_ID)!.sms).toEqual({
      accountSid: VALID_SID,
      authToken: VALID_TOKEN,
      fromNumber: VALID_FROM,
    });
  });

  it('rejects a partial set (one or two of three) with 400', async () => {
    const res1 = await patch({ sms_account_sid: VALID_SID });
    expect(res1.status).toBe(400);
    expect(res1.body.error).toMatch(/together/i);

    const res2 = await patch({ sms_account_sid: VALID_SID, sms_auth_token: VALID_TOKEN });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/together/i);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].sms).toBeUndefined();
  });

  it('rejects non-string credential with 400', async () => {
    const res = await patch({
      sms_account_sid: 123,
      sms_auth_token: VALID_TOKEN,
      sms_from_number: VALID_FROM,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sms_account_sid must be a string/i);
  });

  it('disconnects SMS when all three credentials are cleared', async () => {
    await patch({ sms_account_sid: VALID_SID, sms_auth_token: VALID_TOKEN, sms_from_number: VALID_FROM });
    const res = await patch({ sms_account_sid: '', sms_auth_token: '', sms_from_number: '' });
    expect(res.status).toBe(200);
    expect(res.body.agent.sms_connected).toBe(false);
    expect(res.body.agent.sms_webhook_path).toBeNull();

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.agents[0].sms).toBeUndefined();
    expect(configs.get(AGENT_ID)!.sms).toBeUndefined();
  });

  it('GET /agents reflects SMS connection status', async () => {
    await patch({ sms_account_sid: VALID_SID, sms_auth_token: VALID_TOKEN, sms_from_number: VALID_FROM });
    const res = await supertest.default(app).get('/api/v1/agents').set(ADMIN);
    expect(res.status).toBe(200);
    const agent = res.body.agents.find((a: { id: string }) => a.id === AGENT_ID);
    expect(agent.sms_connected).toBe(true);
    expect(agent.sms_webhook_path).toBe(`/webhooks/sms/${AGENT_ID}`);
    expect(agent.sms_from_number).toBe(VALID_FROM);
  });

  it('allows setting sms_dm_policy/sms_dm_allowlist/sms_pairing independently once connected', async () => {
    await patch({ sms_account_sid: VALID_SID, sms_auth_token: VALID_TOKEN, sms_from_number: VALID_FROM });
    const res = await patch({ sms_dm_policy: 'allowlist', sms_dm_allowlist: ['+15559998888'], sms_pairing: false });
    expect(res.status).toBe(200);
    expect(res.body.agent.sms_dm_policy).toBe('allowlist');
    expect(res.body.agent.sms_dm_allowlist).toEqual(['+15559998888']);
    expect(res.body.agent.sms_pairing).toBe(false);
  });

  it('rejects an invalid sms_dm_policy value with 400', async () => {
    const res = await patch({ sms_dm_policy: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sms_dm_policy/i);
  });
});
