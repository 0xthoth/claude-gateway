/**
 * SMS (Twilio) inbound webhook handler.
 *
 * Exposed as a WebhookAppHandler ({ verify, handlePost }) wired into the
 * unified `/webhooks/:app` dispatcher (see webhooks-router.ts) under app
 * "sms" — mirrors `slack-webhook-router.ts`'s shape, with the mechanics that
 * genuinely differ from Slack called out inline below: Twilio's signature
 * scheme (HMAC-SHA1 over the full URL + sorted params, not the raw body),
 * form-urlencoded (not JSON) POST bodies, no URL-verification handshake, and
 * no threads/mentions/reactions — every inbound message is a flat 1:1 DM.
 *
 * Flow: verify X-Twilio-Signature → ack fast → for an allowed sender, forward
 * a normalized {content, meta} to the target agent's existing /channel
 * callback (the same intake Telegram/LINE/Slack use).
 */
import { type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import type { AgentRunner } from '../agent/runner';
import { createLogger } from '../logger';
import {
  isResolvedSourceAllowed,
  resolveSmsSource,
  type SmsMessageLike,
} from './sms-access';
import {
  recordDeniedSender,
  getPendingSender,
  generatePairingCode,
} from './pending-senders';
import { SmsClient } from './sms-client';
import type { WebhookAppHandler } from './webhooks-router';

/**
 * One-time pairing-code message — same visual-match-code contract as
 * LINE's/Slack's `pairingMessage` (the sender reports the code to the admin,
 * who matches it in the UI before adding them to the allowlist; the sender
 * does NOT reply with it). Plain text only — SMS has no rich formatting.
 */
function pairingMessage(code: string): string {
  return (
    `รหัสจับคู่ (pairing code) ของคุณคือ: ${code}\n` +
    `กรุณาแจ้งรหัสนี้ให้แอดมินเพื่อขอเปิดใช้งานบอท (ไม่ต้องพิมพ์รหัสตอบกลับ)\n\n` +
    `Your pairing code: ${code}\n` +
    `Share this code with the admin to get access. (No need to reply with it.)`
  );
}

export type NormalizedSmsMessage = {
  content: string;
  meta: Record<string, string>;
};

interface TwilioInboundParams {
  From?: string;
  Body?: string;
  MessageSid?: string;
}

/** Normalize a Twilio inbound payload into the gateway's {content, meta} intake shape. */
export function normalizeSmsMessage(params: TwilioInboundParams): NormalizedSmsMessage | null {
  const resolved = resolveSmsSource(params as SmsMessageLike);
  if (!resolved.senderId) return null;
  const meta: Record<string, string> = {
    source: 'sms',
    chat_id: resolved.conversationId,
    user_id: resolved.senderId,
    user: resolved.senderId,
    message_id: params.MessageSid ?? '',
  };
  return { content: params.Body ?? '', meta };
}

/**
 * Verify `X-Twilio-Signature`: base64(HMAC-SHA1(authToken, url + sorted(key+value)...)).
 * Per Twilio's documented request-validation algorithm
 * (https://www.twilio.com/docs/usage/security#validating-requests): sort the
 * POST params by key, concatenate each key immediately followed by its value
 * (no separator) onto the full request URL (protocol+host+path+querystring,
 * exactly as configured in the Twilio console), then HMAC-SHA1 with the auth
 * token as key and base64-encode. No timestamp/replay-window component —
 * unlike Slack, Twilio's scheme has none.
 */
export function verifyTwilioSignature(
  fullUrl: string,
  params: URLSearchParams,
  authToken: string,
  signatureHeader: string | undefined,
): boolean {
  if (!authToken || !fullUrl || !signatureHeader) return false;

  const sortedKeys = [...new Set([...params.keys()])].sort();
  let data = fullUrl;
  for (const key of sortedKeys) {
    // Twilio sends each key at most once for standard inbound-message webhooks;
    // if a key repeats, concatenate every value in encounter order (matches
    // Twilio's own reference implementations, which iterate params.getAll()).
    for (const value of params.getAll(key)) {
      data += key + value;
    }
  }

  const expected = createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Find the agent that has SMS configured (mirrors resolveSlackAgent — single-agent-per-account POC, or by id). */
function resolveSmsAgent(
  agents: Map<string, AgentRunner>,
  agentId?: string,
): AgentRunner | null {
  if (agentId) {
    const r = agents.get(agentId);
    return r && r.getAgentConfig().sms?.authToken ? r : null;
  }
  for (const runner of agents.values()) {
    if (runner.getAgentConfig().sms?.authToken) return runner;
  }
  return null;
}

export interface SmsWebhookOptions {
  /** Test-only Twilio REST API base override (see SmsClient). */
  apiBase?: string;
  /** Test-only override for the "full URL Twilio signed" — bypasses gateway.publicUrl. */
  publicUrlOverride?: string;
}

export function createSmsWebhookHandler(
  agents: Map<string, AgentRunner>,
  logDir: string,
  opts: SmsWebhookOptions = {},
): WebhookAppHandler {
  const logger = createLogger('sms-webhook', logDir);

  // Twilio has no URL-verification handshake (unlike Slack/LINE's console
  // "Verify" probes) — kept only because WebhookAppHandler requires it.
  const verify = (_req: Request, res: Response): void => {
    res.status(200).json({ ok: true });
  };

  const handlePost = async (req: Request, res: Response): Promise<void> => {
    const agentId = req.params.agentId as string | undefined;
    const runner = resolveSmsAgent(agents, agentId);
    if (!runner) {
      res.status(404).json({ error: 'no SMS-enabled agent' });
      return;
    }
    const cfg = runner.getAgentConfig().sms;
    const authToken = cfg?.authToken ?? '';
    const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    // Twilio POSTs application/x-www-form-urlencoded — parse the raw buffer
    // ourselves (webhooks-router.ts mounts express.raw before dispatch, so
    // express.urlencoded() never runs on this path) so the exact same params
    // feed both the signature check and the message content.
    const params = new URLSearchParams(buf.toString('utf8'));

    const publicUrl = opts.publicUrlOverride ?? runner.getGatewayPublicUrl();
    const fullUrl = publicUrl ? `${publicUrl}/webhooks/sms/${runner.getAgentConfig().id}` : '';
    if (!fullUrl) {
      logger.warn('SMS webhook rejected: gateway.publicUrl is not configured', {
        agentId: runner.getAgentConfig().id,
      });
      res.status(401).json({ error: 'gateway not publicly configured' });
      return;
    }

    if (!verifyTwilioSignature(fullUrl, params, authToken, req.header('x-twilio-signature'))) {
      logger.warn('SMS webhook rejected: bad signature', { agentId: runner.getAgentConfig().id });
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    // Ack immediately (Twilio retries on a slow/non-2xx response) — process after.
    // Twilio expects TwiML (or empty 200) back, not JSON — an empty 200 sends no
    // auto-reply, which is what we want since replies go out via the agent's own
    // sms_reply tool call, not synchronously in this response.
    res.status(200).type('text/xml').send('<Response></Response>');

    const from = params.get('From') ?? '';
    const body = params.get('Body') ?? '';
    const messageSid = params.get('MessageSid') ?? '';
    if (!from) return;

    const deniedAgentId = runner.getAgentConfig().id;
    const resolved = resolveSmsSource({ From: from });

    if (!isResolvedSourceAllowed(cfg, resolved)) {
      logger.debug('SMS webhook: source not allowed', {
        agentId: deniedAgentId,
        policy: cfg?.dmPolicy ?? '(closed)',
        from,
      });
      const isPairing = cfg?.pairing !== false && cfg?.dmPolicy !== 'open' && cfg?.dmPolicy !== 'disabled';
      const prev = getPendingSender('sms', deniedAgentId, from);
      const code = prev?.code ?? (isPairing ? generatePairingCode() : undefined);
      const wasNew = recordDeniedSender('sms', deniedAgentId, from, undefined, Date.now(), code);

      if (isPairing && wasNew && code && cfg?.accountSid && cfg?.authToken && cfg?.fromNumber) {
        const client = new SmsClient({
          accountSid: cfg.accountSid,
          authToken: cfg.authToken,
          fromNumber: cfg.fromNumber,
          logDir,
          apiBase: opts.apiBase,
        });
        void client
          .sendMessage(from, pairingMessage(code))
          .catch((err) => logger.debug('SMS pairing code reply failed', { error: (err as Error).message }));
      }
      return;
    }

    const norm = normalizeSmsMessage({ From: from, Body: body, MessageSid: messageSid });
    if (!norm) return;

    try {
      await fetch(`http://127.0.0.1:${runner.getCallbackPort()}/channel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(norm),
      });
    } catch (err) {
      logger.error('SMS webhook: failed to forward to callback', {
        error: (err as Error).message,
      });
    }
  };

  return { verify, handlePost };
}
