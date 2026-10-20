import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import type { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';

const KEYS = {
  admin: { key: 'k-admin', agents: '*', admin: true },
  podRead: { key: 'k-ro', agents: '*' },
} satisfies Record<string, ApiKey>;
const A = '/api/v1/agents/alfred';

describe('a bindings folder that cannot be read', () => {
  let base: string;
  let runner: AgentRunner;
  let gw: ReturnType<GatewayRouter['getApp']>;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bindings-broken-')));
    const workspace = path.join(base, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(base, 'agents', 'alfred', 'project-bindings'), 'not a folder');
    const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
    const gateway: GatewayConfig = {
      gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', api: { keys: Object.values(KEYS) } },
      agents: [cfg],
    };
    runner = new AgentRunner(cfg, gateway);
    gw = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gateway).getApp();
  });
  afterEach(async () => {
    await runner.stop().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('leaves every read alone, whatever the key', async () => {
    for (const key of ['k-admin', 'k-ro']) {
      for (const url of [`${A}/chats`, `${A}/chats/api-web/messages`, `${A}/sessions?chat_id=web`]) {
        expect([key, url, (await request(gw).get(url).set('Authorization', `Bearer ${key}`)).status]).toEqual([key, url, 200]);
      }
    }
  });
});
