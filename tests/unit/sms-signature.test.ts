/**
 * Unit tests for verifyTwilioSignature (src/api/sms-webhook-router.ts) — the
 * security-critical HMAC check that gates every inbound SMS webhook request.
 * Pure crypto, no network. Mirrors tests/unit/slack-signature.test.ts's
 * coverage shape, adapted for Twilio's different scheme: HMAC-SHA1 over the
 * full URL + sorted POST params (not the raw body), no timestamp/replay
 * window (Twilio's scheme has none, unlike Slack's).
 */
import { createHmac } from 'crypto';
import { verifyTwilioSignature } from '../../src/api/sms-webhook-router';

const AUTH_TOKEN = 'test-auth-token';
const URL = 'https://vm.example.com/gateway/webhooks/sms/getpod';

function sign(url: string, params: URLSearchParams, authToken = AUTH_TOKEN): string {
  const sortedKeys = [...new Set([...params.keys()])].sort();
  let data = url;
  for (const key of sortedKeys) {
    for (const value of params.getAll(key)) data += key + value;
  }
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

describe('verifyTwilioSignature()', () => {
  test('accepts a correctly signed request', () => {
    const params = new URLSearchParams({ From: '+15551234567', Body: 'hi', MessageSid: 'SM123' });
    const sig = sign(URL, params);
    expect(verifyTwilioSignature(URL, params, AUTH_TOKEN, sig)).toBe(true);
  });

  test('signature is independent of param insertion order (params are sorted before signing)', () => {
    const params = new URLSearchParams({ From: '+15551234567', Body: 'hi', MessageSid: 'SM123' });
    const sig = sign(URL, params);
    const reordered = new URLSearchParams({ MessageSid: 'SM123', From: '+15551234567', Body: 'hi' });
    expect(verifyTwilioSignature(URL, reordered, AUTH_TOKEN, sig)).toBe(true);
  });

  test('rejects a signature computed with the wrong auth token', () => {
    const params = new URLSearchParams({ From: '+15551234567', Body: 'hi' });
    const sig = sign(URL, params, 'wrong-token');
    expect(verifyTwilioSignature(URL, params, AUTH_TOKEN, sig)).toBe(false);
  });

  test('rejects when a param value was tampered with after signing', () => {
    const params = new URLSearchParams({ From: '+15551234567', Body: 'hi' });
    const sig = sign(URL, params);
    const tampered = new URLSearchParams({ From: '+15551234567', Body: 'tampered' });
    expect(verifyTwilioSignature(URL, tampered, AUTH_TOKEN, sig)).toBe(false);
  });

  test('rejects when the URL does not match what was signed (e.g. wrong agentId path)', () => {
    const params = new URLSearchParams({ From: '+15551234567', Body: 'hi' });
    const sig = sign(URL, params);
    const wrongUrl = 'https://vm.example.com/gateway/webhooks/sms/otheragent';
    expect(verifyTwilioSignature(wrongUrl, params, AUTH_TOKEN, sig)).toBe(false);
  });

  test('rejects when the auth token is empty', () => {
    const params = new URLSearchParams({ From: '+15551234567' });
    const sig = sign(URL, params);
    expect(verifyTwilioSignature(URL, params, '', sig)).toBe(false);
  });

  test('rejects when the URL is empty', () => {
    const params = new URLSearchParams({ From: '+15551234567' });
    const sig = sign(URL, params);
    expect(verifyTwilioSignature('', params, AUTH_TOKEN, sig)).toBe(false);
  });

  test('rejects when the signature header is missing', () => {
    const params = new URLSearchParams({ From: '+15551234567' });
    expect(verifyTwilioSignature(URL, params, AUTH_TOKEN, undefined)).toBe(false);
  });

  test('rejects a signature of a different length (no timing-unsafe throw)', () => {
    const params = new URLSearchParams({ From: '+15551234567' });
    expect(verifyTwilioSignature(URL, params, AUTH_TOKEN, 'short')).toBe(false);
  });

  test('no params — signs the bare URL', () => {
    const params = new URLSearchParams();
    const sig = sign(URL, params);
    expect(verifyTwilioSignature(URL, params, AUTH_TOKEN, sig)).toBe(true);
  });
});
