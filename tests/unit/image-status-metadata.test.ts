import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImageModule } from '../../mcp/tools/image/module';

describe('image status preserves generation metadata', () => {
  const keys = ['IMAGE_BASE_URL', 'IMAGE_API_KEY', 'GATEWAY_API_URL', 'GATEWAY_API_KEY', 'GATEWAY_AGENT_ID', 'GATEWAY_SESSION_ID', 'GATEWAY_SESSION_MEDIA_DIR'];
  const saved: Record<string, string | undefined> = {};
  const originalFetch = global.fetch;
  let directory: string;

  beforeEach(() => {
    for (const key of keys) saved[key] = process.env[key];
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-status-'));
    Object.assign(process.env, {
      IMAGE_BASE_URL: 'https://image.example.test', IMAGE_API_KEY: 'test-key',
      GATEWAY_API_URL: 'http://127.0.0.1:19999', GATEWAY_API_KEY: 'gateway-key',
      GATEWAY_AGENT_ID: 'agent', GATEWAY_SESSION_ID: 'session', GATEWAY_SESSION_MEDIA_DIR: directory,
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('a later status call registers the provider/model returned by the job', async () => {
    const registrations: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/api/v1/image-artifacts')) {
        registrations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ items: [{ artifact_id: 'img_1', artifact_ref: 'artifact:img_1' }] }), { status: 201 });
      }
      return new Response(JSON.stringify({ status: 'done', task_id: 'job-1', provider: 'provider-a', model: 'model-b', images: [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')] }), { status: 200 });
    }) as typeof fetch;
    const result = await new ImageModule().handleTool('generate_image', { action: 'status', task_id: 'job-1' });
    expect(result.isError).toBeUndefined();
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({ provider: 'provider-a', model: 'model-b', task_id: 'job-1' });
    expect(JSON.parse(result.content[0]!.text).artifacts[0]).toMatchObject({ provider: 'provider-a', model: 'model-b' });
  });
});
