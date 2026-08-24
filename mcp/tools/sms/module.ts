/**
 * SMS outbound tool module — exposes `sms_reply` to the Claude session.
 *
 * SMS is a ToolModule (reply-only, like LINE/Slack): inbound arrives via the
 * gateway's Express webhook route (src/api/sms-webhook-router.ts), not here.
 *
 * Like Slack, there is no reply-token TTL to work around, so this module
 * always sends directly from the subprocess. Unlike Slack, SMS has no
 * threads, ack-reactions, or per-message metadata — `sms_reply` only takes
 * chat_id (the sender's phone number) and text.
 */
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
// mcp/ ships as source and runs directly under bun — it may only import a
// compiled dist/ artifact, never src/ directly (see
// tests/unit/mcp-no-src-imports.test.ts). `npm run build` must have run at
// least once for this import to resolve locally.
import { SmsClient } from '../../../dist/api/sms-client.js';

export class SmsModule implements ToolModule {
  id = 'sms';
  toolVisibility: ToolVisibility = 'current-channel';

  isEnabled(): boolean {
    return process.env.GATEWAY_ORIGIN_CHANNEL === 'sms';
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'sms_reply',
        description:
          'Send a reply to the current SMS conversation. ' +
          'Pass chat_id (the phone number shown in the <channel> tag) and text. ' +
          'Plain text only — SMS has no markdown/rich formatting.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'Phone number to send to (the chat_id from the channel turn).',
            },
            text: {
              type: 'string',
              description: 'Message text.',
            },
          },
          required: ['chat_id', 'text'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name === 'sms_reply') return this.handleReply(args);
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  private async handleReply(args: Record<string, unknown>): Promise<McpToolResult> {
    const chatId = typeof args.chat_id === 'string' ? args.chat_id : '';
    const text = typeof args.text === 'string' ? args.text : '';
    const accountSid = process.env.SMS_ACCOUNT_SID ?? '';
    const authToken = process.env.SMS_AUTH_TOKEN ?? '';
    const fromNumber = process.env.SMS_FROM_NUMBER ?? '';

    if (!chatId) {
      return { content: [{ type: 'text', text: 'sms_reply: missing chat_id' }], isError: true };
    }
    if (!text) {
      return { content: [{ type: 'text', text: 'sms_reply: text cannot be empty' }], isError: true };
    }
    if (!accountSid || !authToken || !fromNumber) {
      return { content: [{ type: 'text', text: 'sms_reply: missing Twilio credentials' }], isError: true };
    }

    const client = new SmsClient({
      accountSid,
      authToken,
      fromNumber,
      logDir: process.env.GATEWAY_WORKSPACE_DIR ?? '/tmp',
    });
    try {
      const sent = await client.sendMessage(chatId, text);
      if (sent.error_code) {
        return {
          content: [{ type: 'text', text: `sms_reply failed: ${sent.error_message ?? sent.error_code}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: 'Sent message via SMS.' }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `sms_reply failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
}
