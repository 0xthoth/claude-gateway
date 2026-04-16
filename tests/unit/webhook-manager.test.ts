/**
 * Unit tests for webhook-manager
 *
 * Uses a real HTTP mock server (no external deps) to intercept Telegram API calls.
 */

import * as http from 'http';
import * as net from 'net';
import express from 'express';
import { registerWebhook, deleteWebhook, getWebhookInfo, WebhookInfo } from '../../src/webhook/manager';

// ─── Minimal mock Telegram server ───────────────────────────────────────────

interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

interface MockTelegramServer {
  server: http.Server;
  port: number;
  baseUrl: string;
  requests: RecordedRequest[];
  setNextResponse(statusCode: number, body: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function startMockServer(): Promise<MockTelegramServer> {
  const requests: RecordedRequest[] = [];
  let nextStatusCode = 200;
  let nextBody: Record<string, unknown> = { ok: true, result: {} };

  const app = express();
  app.use(express.json());

  // Catch-all handler
  app.all('*', (req, res) => {
    requests.push({ method: req.method, path: req.path, body: req.body ?? {} });
    res.status(nextStatusCode).json(nextBody);
  });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;
      const baseUrl = `http://127.0.0.1:${port}`;

      resolve({
        server,
        port,
        baseUrl,
        requests,
        setNextResponse(statusCode: number, body: Record<string, unknown>) {
          nextStatusCode = statusCode;
          nextBody = body;
        },
        close(): Promise<void> {
          return new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
        },
      });
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('webhook-manager', () => {
  let mock: MockTelegramServer;
  const BOT_TOKEN = 'test-bot-123';

  beforeAll(async () => {
    mock = await startMockServer();
    process.env.TELEGRAM_API_BASE = mock.baseUrl;
  });

  afterAll(async () => {
    delete process.env.TELEGRAM_API_BASE;
    await mock.close();
  });

  beforeEach(() => {
    mock.requests.length = 0;
    mock.setNextResponse(200, { ok: true, result: {} });
  });

  // ─── registerWebhook ─────────────────────────────────────────────────────

  describe('registerWebhook', () => {
    it('calls setWebhook endpoint with correct bot token', async () => {
      await registerWebhook(BOT_TOKEN, 'https://example.com/webhook');

      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].path).toBe(`/bot${BOT_TOKEN}/setWebhook`);
    });

    it('POSTs to setWebhook', async () => {
      await registerWebhook(BOT_TOKEN, 'https://example.com/webhook');

      expect(mock.requests[0].method).toBe('POST');
    });

    it('sends the webhook URL in the request body', async () => {
      const webhookUrl = 'https://my-gateway.example.com/webhook/abc123';
      await registerWebhook(BOT_TOKEN, webhookUrl);

      expect(mock.requests[0].body.url).toBe(webhookUrl);
    });

    it('resolves without error on success', async () => {
      mock.setNextResponse(200, { ok: true, result: true });
      await expect(registerWebhook(BOT_TOKEN, 'https://example.com/wh')).resolves.toBeUndefined();
    });

    it('rejects when Telegram returns ok: false', async () => {
      mock.setNextResponse(400, { ok: false, description: 'Bad Request: invalid webhook URL' });
      await expect(registerWebhook(BOT_TOKEN, 'not-a-url')).rejects.toThrow('Bad Request');
    });

    it('uses TELEGRAM_API_BASE env var', async () => {
      await registerWebhook(BOT_TOKEN, 'https://example.com/wh');
      // Request should have been received by our mock server
      expect(mock.requests).toHaveLength(1);
    });
  });

  // ─── deleteWebhook ───────────────────────────────────────────────────────

  describe('deleteWebhook', () => {
    it('calls deleteWebhook endpoint with correct bot token', async () => {
      await deleteWebhook(BOT_TOKEN);

      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].path).toBe(`/bot${BOT_TOKEN}/deleteWebhook`);
    });

    it('POSTs to deleteWebhook', async () => {
      await deleteWebhook(BOT_TOKEN);

      expect(mock.requests[0].method).toBe('POST');
    });

    it('resolves without error on success', async () => {
      mock.setNextResponse(200, { ok: true, result: true });
      await expect(deleteWebhook(BOT_TOKEN)).resolves.toBeUndefined();
    });

    it('rejects when Telegram returns ok: false', async () => {
      mock.setNextResponse(401, { ok: false, description: 'Unauthorized' });
      await expect(deleteWebhook(BOT_TOKEN)).rejects.toThrow('Unauthorized');
    });
  });

  // ─── getWebhookInfo ──────────────────────────────────────────────────────

  describe('getWebhookInfo', () => {
    const sampleInfo: WebhookInfo = {
      url: 'https://example.com/webhook/abc',
      has_custom_certificate: false,
      pending_update_count: 3,
      max_connections: 40,
    };

    it('calls getWebhookInfo endpoint with correct bot token', async () => {
      mock.setNextResponse(200, { ok: true, result: sampleInfo });
      await getWebhookInfo(BOT_TOKEN);

      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].path).toBe(`/bot${BOT_TOKEN}/getWebhookInfo`);
    });

    it('GETs getWebhookInfo', async () => {
      mock.setNextResponse(200, { ok: true, result: sampleInfo });
      await getWebhookInfo(BOT_TOKEN);

      expect(mock.requests[0].method).toBe('GET');
    });

    it('returns the webhook info object', async () => {
      mock.setNextResponse(200, { ok: true, result: sampleInfo });
      const info = await getWebhookInfo(BOT_TOKEN);

      expect(info.url).toBe(sampleInfo.url);
      expect(info.has_custom_certificate).toBe(false);
      expect(info.pending_update_count).toBe(3);
      expect(info.max_connections).toBe(40);
    });

    it('returns empty url when no webhook set', async () => {
      mock.setNextResponse(200, {
        ok: true,
        result: { url: '', has_custom_certificate: false, pending_update_count: 0 },
      });
      const info = await getWebhookInfo(BOT_TOKEN);
      expect(info.url).toBe('');
    });

    it('rejects when Telegram returns ok: false', async () => {
      mock.setNextResponse(401, { ok: false, description: 'Unauthorized' });
      await expect(getWebhookInfo(BOT_TOKEN)).rejects.toThrow('Unauthorized');
    });

    it('returns optional fields when present', async () => {
      const fullInfo: WebhookInfo = {
        url: 'https://example.com/wh',
        has_custom_certificate: true,
        pending_update_count: 0,
        last_error_date: 1234567890,
        last_error_message: 'Connection refused',
        allowed_updates: ['message', 'callback_query'],
      };
      mock.setNextResponse(200, { ok: true, result: fullInfo });
      const info = await getWebhookInfo(BOT_TOKEN);

      expect(info.last_error_message).toBe('Connection refused');
      expect(info.allowed_updates).toEqual(['message', 'callback_query']);
    });
  });

  // ─── TELEGRAM_API_BASE env var ───────────────────────────────────────────

  describe('TELEGRAM_API_BASE env var', () => {
    it('uses custom API base from environment', async () => {
      // Already set to mock server in beforeAll — verify it works
      await registerWebhook('custom-token', 'https://example.com/wh');
      expect(mock.requests.length).toBeGreaterThan(0);
      expect(mock.requests[0].path).toContain('custom-token');
    });
  });
});
