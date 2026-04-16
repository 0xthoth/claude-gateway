import { CronModule } from '../../mcp/tools/cron/module';

describe('CronModule', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isEnabled', () => {
    it('should return true when both GATEWAY_API_URL and GATEWAY_AGENT_ID are set', () => {
      process.env.GATEWAY_API_URL = 'http://localhost:3000';
      process.env.GATEWAY_AGENT_ID = 'test-agent';
      const mod = new CronModule();
      expect(mod.isEnabled()).toBe(true);
    });

    // CR3: GATEWAY_API_URL not set → isEnabled()=false
    it('CR3: should return false when GATEWAY_API_URL is not set', () => {
      delete process.env.GATEWAY_API_URL;
      process.env.GATEWAY_AGENT_ID = 'test-agent';
      const mod = new CronModule();
      expect(mod.isEnabled()).toBe(false);
    });

    it('should return false when GATEWAY_AGENT_ID is not set', () => {
      process.env.GATEWAY_API_URL = 'http://localhost:3000';
      delete process.env.GATEWAY_AGENT_ID;
      const mod = new CronModule();
      expect(mod.isEnabled()).toBe(false);
    });
  });

  describe('getTools', () => {
    it('should return 5 cron-prefixed tools', () => {
      const mod = new CronModule();
      const tools = mod.getTools();

      expect(tools).toHaveLength(5);

      const names = tools.map(t => t.name);
      expect(names).toContain('cron_list');
      expect(names).toContain('cron_create');
      expect(names).toContain('cron_delete');
      expect(names).toContain('cron_run');
      expect(names).toContain('cron_get_runs');
    });

    // CR1: cron_create tool has correct schema
    it('CR1: cron_create tool should have required fields in schema', () => {
      const mod = new CronModule();
      const tools = mod.getTools();
      const create = tools.find(t => t.name === 'cron_create')!;

      const schema = create.inputSchema as any;
      expect(schema.required).toContain('name');
      expect(schema.required).toContain('type');
      // schedule is optional (at-type jobs use scheduleAt instead)
      expect(schema.required).not.toContain('schedule');
      // new fields from Fix 3 are present
      expect(schema.properties).toHaveProperty('scheduleKind');
      expect(schema.properties).toHaveProperty('scheduleAt');
      expect(schema.properties).toHaveProperty('deleteAfterRun');
    });

    // CR2: cron_list tool exists
    it('CR2: cron_list tool should have empty required fields', () => {
      const mod = new CronModule();
      const tools = mod.getTools();
      const list = tools.find(t => t.name === 'cron_list')!;

      expect(list).toBeDefined();
      expect(list.description).toContain('List');
    });
  });

  describe('handleTool', () => {
    it('should return error for unknown tool name', async () => {
      process.env.GATEWAY_API_URL = 'http://localhost:3000';
      process.env.GATEWAY_AGENT_ID = 'test-agent';
      const mod = new CronModule();

      const result = await mod.handleTool('cron_unknown', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('unknown tool');
    });

    it('should return error when API call fails', async () => {
      process.env.GATEWAY_API_URL = 'http://localhost:99999'; // invalid port
      process.env.GATEWAY_AGENT_ID = 'test-agent';
      const mod = new CronModule();

      const result = await mod.handleTool('cron_list', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('failed');
    });
  });

  describe('properties', () => {
    it('should have correct id and visibility', () => {
      const mod = new CronModule();
      expect(mod.id).toBe('cron');
      expect(mod.toolVisibility).toBe('all-configured');
    });
  });

  // ─── Fix 3 regression tests ────────────────────────────────────────────────

  describe('Fix 3: deleteAfterRun defaults for at-type jobs', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
      process.env.GATEWAY_API_URL = 'http://localhost:3000';
      process.env.GATEWAY_AGENT_ID = 'test-agent';
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    function mockFetch(responseBody: unknown) {
      return jest.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        return new Response(JSON.stringify(responseBody), {
          headers: { 'Content-Type': 'application/json' },
        });
      });
    }

    function capturedBody(mockFn: jest.Mock): Record<string, unknown> {
      const [, init] = mockFn.mock.calls[0] as [string, RequestInit];
      return JSON.parse(init.body as string);
    }

    it('Fix3-1: at-type job creation defaults deleteAfterRun to true', async () => {
      const fetchMock = mockFetch({ id: 'j1', name: 'test' });
      global.fetch = fetchMock;

      const mod = new CronModule();
      await mod.handleTool('cron_create', {
        name: 'test-at-job',
        type: 'agent',
        scheduleKind: 'at',
        scheduleAt: new Date(Date.now() + 60000).toISOString(),
        prompt: 'do something',
        telegram: 'PLACEHOLDER_CHAT_ID',
      });

      const body = capturedBody(fetchMock);
      expect(body.deleteAfterRun).toBe(true);
      expect(body.scheduleKind).toBe('at');
    });

    it('Fix3-2: cron-type job creation defaults deleteAfterRun to false', async () => {
      const fetchMock = mockFetch({ id: 'j2', name: 'test' });
      global.fetch = fetchMock;

      const mod = new CronModule();
      await mod.handleTool('cron_create', {
        name: 'test-cron-job',
        type: 'agent',
        schedule: '* * * * *',
        prompt: 'do something',
        telegram: 'PLACEHOLDER_CHAT_ID',
      });

      const body = capturedBody(fetchMock);
      expect(body.deleteAfterRun).toBe(false);
      expect(body.scheduleKind).toBe('cron');
    });

    it('Fix3-3: explicit deleteAfterRun=false overrides at-type default', async () => {
      const fetchMock = mockFetch({ id: 'j3', name: 'test' });
      global.fetch = fetchMock;

      const mod = new CronModule();
      await mod.handleTool('cron_create', {
        name: 'keep-at-job',
        type: 'agent',
        scheduleKind: 'at',
        scheduleAt: new Date(Date.now() + 60000).toISOString(),
        prompt: 'do something',
        telegram: 'PLACEHOLDER_CHAT_ID',
        deleteAfterRun: false,
      });

      const body = capturedBody(fetchMock);
      expect(body.deleteAfterRun).toBe(false);
    });
  });
});
