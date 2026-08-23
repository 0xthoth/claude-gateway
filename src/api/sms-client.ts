/**
 * Thin Twilio Messages API wrapper — the outbound half of the SMS channel.
 *
 * Unlike Slack (`slack-client.ts`, bearer token) Twilio's REST API uses HTTP
 * Basic Auth (Account SID as username, Auth Token as password). SMS has no
 * reactions, threads, or profile/name lookups — this client is intentionally
 * smaller than `SlackClient`, exposing only what the channel needs: send.
 */
import { createLogger } from '../logger';

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

export interface SmsClientOptions {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  logDir: string;
  /** Test-only override for the Twilio REST API base URL. Production uses the real default. */
  apiBase?: string;
}

interface TwilioMessageResponse {
  sid?: string;
  status?: string;
  error_code?: number | null;
  error_message?: string | null;
  [key: string]: unknown;
}

export class SmsClient {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;
  private readonly apiBase: string;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(opts: SmsClientOptions) {
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.fromNumber = opts.fromNumber;
    this.apiBase = opts.apiBase ?? TWILIO_API_BASE;
    this.logger = createLogger('sms-client', opts.logDir);
  }

  /**
   * Send a plain-text SMS. No markdown/rich formatting on this channel — the
   * caller is responsible for passing plain text (mirrors LINE/Slack's own
   * "strip markup before this call" convention). Twilio itself splits/joins
   * messages over the ~1600-char single-segment limit, so no chunking here.
   */
  async sendMessage(to: string, body: string): Promise<TwilioMessageResponse> {
    const params = new URLSearchParams();
    params.set('To', to);
    params.set('From', this.fromNumber);
    params.set('Body', body);

    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const res = await fetch(
      `${this.apiBase}/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: params,
      },
    );
    const json = (await res.json()) as TwilioMessageResponse;
    if (!res.ok || json.error_code) {
      this.logger.warn('Twilio send failed', {
        status: res.status,
        error_code: json.error_code,
        error_message: json.error_message,
      });
    }
    return json;
  }
}
