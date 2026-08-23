/**
 * Unit tests for the SMS channel's pure logic and MCP tool module:
 *  - normalizeSmsMessage (src/api/sms-webhook-router.ts) — inbound parsing
 *  - SmsModule (mcp/tools/sms/module.ts) — outbound sms_reply tool
 *
 * Signature validation (verifyTwilioSignature) is covered separately in
 * sms-signature.test.ts (crypto-level, no network). This file mocks
 * `global.fetch` (mirrors tests/unit/slack-mcp.test.ts's pattern) rather
 * than hitting the real Twilio API.
 */
import { normalizeSmsMessage } from '../../src/api/sms-webhook-router';
import { SmsModule } from '../../mcp/tools/sms/module';

describe('normalizeSmsMessage()', () => {
  test('inbound message → content + meta', () => {
    const out = normalizeSmsMessage({ From: '+15551234567', Body: 'hello', MessageSid: 'SM123' });
    expect(out).toEqual({
      content: 'hello',
      meta: {
        source: 'sms',
        chat_id: '+15551234567',
        user_id: '+15551234567',
        user: '+15551234567',
        message_id: 'SM123',
      },
    });
  });

  test('missing From → null', () => {
    expect(normalizeSmsMessage({ Body: 'hi' })).toBeNull();
  });

  test('no Body → empty content, not null (an empty message is still forwarded)', () => {
    const out = normalizeSmsMessage({ From: '+15551234567' });
    expect(out?.content).toBe('');
  });

  test('no MessageSid → empty message_id, not omitted', () => {
    const out = normalizeSmsMessage({ From: '+15551234567', Body: 'hi' });
    expect(out?.meta.message_id).toBe('');
  });
});

describe('SmsModule', () => {
  const restore: Record<string, string | undefined> = {};
  const ENV_KEYS = ['GATEWAY_ORIGIN_CHANNEL', 'SMS_ACCOUNT_SID', 'SMS_AUTH_TOKEN', 'SMS_FROM_NUMBER'];
  beforeEach(() => {
    for (const k of ENV_KEYS) restore[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  });

  test('isEnabled() true only when GATEWAY_ORIGIN_CHANNEL is sms', () => {
    process.env.GATEWAY_ORIGIN_CHANNEL = 'sms';
    expect(new SmsModule().isEnabled()).toBe(true);
    process.env.GATEWAY_ORIGIN_CHANNEL = 'line';
    expect(new SmsModule().isEnabled()).toBe(false);
  });

  test('getTools() exposes exactly sms_reply, requiring chat_id + text', () => {
    const tools = new SmsModule().getTools();
    expect(tools.map((t) => t.name)).toEqual(['sms_reply']);
    expect((tools[0].inputSchema as { required: string[] }).required).toEqual(['chat_id', 'text']);
  });

  test('missing chat_id → error, no network attempted', async () => {
    const mod = new SmsModule();
    const res = await mod.handleTool('sms_reply', { text: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/missing chat_id/i);
  });

  test('empty text → error', async () => {
    const mod = new SmsModule();
    const res = await mod.handleTool('sms_reply', { chat_id: '+15551234567', text: '' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/text cannot be empty/i);
  });

  test('missing Twilio credentials → error', async () => {
    delete process.env.SMS_ACCOUNT_SID;
    delete process.env.SMS_AUTH_TOKEN;
    delete process.env.SMS_FROM_NUMBER;
    const mod = new SmsModule();
    const res = await mod.handleTool('sms_reply', { chat_id: '+15551234567', text: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/missing Twilio credentials/i);
  });

  test('unknown tool name → error', async () => {
    const mod = new SmsModule();
    const res = await mod.handleTool('nope', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/unknown tool/i);
  });

  describe('successful reply (mocked fetch)', () => {
    const realFetch = global.fetch;
    let calls: { url: string; body: Record<string, unknown> }[];

    beforeEach(() => {
      process.env.SMS_ACCOUNT_SID = 'ACtest';
      process.env.SMS_AUTH_TOKEN = 'authtoken';
      process.env.SMS_FROM_NUMBER = '+15550001111';
      calls = [];
      global.fetch = (async (url: string, init: RequestInit) => {
        const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
        calls.push({ url, body });
        return {
          ok: true,
          json: async () => ({ sid: 'SM999', status: 'queued' }),
        } as Response;
      }) as typeof fetch;
    });
    afterEach(() => {
      global.fetch = realFetch;
    });

    test('sends To/From/Body via Twilio Messages API', async () => {
      const mod = new SmsModule();
      const res = await mod.handleTool('sms_reply', { chat_id: '+15551234567', text: 'hello back' });
      expect(res.isError).toBeFalsy();
      const postCall = calls.find((c) => c.url.endsWith('/Messages.json'));
      expect(postCall?.body).toMatchObject({
        To: '+15551234567',
        From: '+15550001111',
        Body: 'hello back',
      });
    });

    test('a Twilio error_code surfaces as a tool error', async () => {
      global.fetch = (async () =>
        ({
          ok: true,
          json: async () => ({ error_code: 21211, error_message: 'Invalid To Number' }),
        }) as Response) as typeof fetch;
      const mod = new SmsModule();
      const res = await mod.handleTool('sms_reply', { chat_id: '+15551234567', text: 'hi' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/Invalid To Number/);
    });
  });
});
