/**
 * webhook-manager — Admin utility for Telegram webhook management.
 *
 * NOTE: This module is NOT used in the gateway's normal operation (Option A).
 * The gateway uses claude --channels which relies on long polling — no webhook needed.
 *
 * Use these functions as a one-time admin operation when:
 * - Migrating a bot FROM webhook mode TO long polling: call deleteWebhook() first.
 * - Diagnosing "409 Conflict" errors: call getWebhookInfo() to check existing webhook.
 */

import * as https from 'https';
import * as http from 'http';

const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';

export interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
}

function getTelegramApiBase(): string {
  return process.env.TELEGRAM_API_BASE ?? DEFAULT_TELEGRAM_API_BASE;
}

function request(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const isHttps = url.startsWith('https://');
    const lib = isHttps ? https : http;
    const urlObj = new URL(url);

    const options: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (!parsed.ok) {
            reject(new Error(`Telegram API error: ${parsed.description ?? 'unknown'}`));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Telegram API response: ${(e as Error).message}`));
        }
      });
    });

    req.on('error', reject);

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/**
 * Register a webhook URL for the given bot token.
 */
export async function registerWebhook(botToken: string, webhookUrl: string): Promise<void> {
  const base = getTelegramApiBase();
  const url = `${base}/bot${botToken}/setWebhook`;
  await request('POST', url, { url: webhookUrl });
}

/**
 * Delete (deregister) the webhook for the given bot token.
 */
export async function deleteWebhook(botToken: string): Promise<void> {
  const base = getTelegramApiBase();
  const url = `${base}/bot${botToken}/deleteWebhook`;
  await request('POST', url, {});
}

/**
 * Get webhook info for the given bot token.
 */
export async function getWebhookInfo(botToken: string): Promise<WebhookInfo> {
  const base = getTelegramApiBase();
  const url = `${base}/bot${botToken}/getWebhookInfo`;
  return request('GET', url) as Promise<WebhookInfo>;
}
