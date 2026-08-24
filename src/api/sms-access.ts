/**
 * SMS (Twilio) sender access control — pure, stateless sender gate.
 *
 * Structural port of `slack-access.ts`/`line-access.ts`, minus their group/
 * channel tier entirely: a phone number has no "group" concept, so every
 * inbound SMS is a 1:1 conversation gated on `dmPolicy`/`dmAllowlist` alone.
 * The webhook router reads `sms` config directly and calls this once per
 * inbound message — no env plumbing, no state files.
 *
 * Default (policy absent) is CLOSED: only numbers in the allowlist pass. Set
 * `dmPolicy: 'open'` to restore "reply to anyone" behavior.
 *
 * Allowlist entries MUST be E.164 phone numbers (e.g. "+15551234567") — the
 * same form Twilio's `From` param always arrives in.
 */
export function isSmsSenderAllowed(
  policy: 'open' | 'allowlist' | 'disabled' | undefined,
  allowlist: string[] | undefined,
  fromNumber: string,
): boolean {
  if (policy === 'open') return true;
  if (policy === 'disabled') return false;
  // 'allowlist' OR undefined (closed default) → only listed numbers pass.
  return !!fromNumber && (allowlist ?? []).includes(fromNumber);
}

/**
 * Structural view of an inbound Twilio SMS webhook payload — the only fields
 * the gate needs. Every inbound SMS resolves to a 1:1 conversation: the
 * conversation id and sender id are both the sender's E.164 `From` number.
 */
export interface SmsMessageLike {
  From?: string;
}

export interface ResolvedSmsSource {
  /** Conversation key — the reply target: the sender's E.164 number. */
  conversationId: string;
  /** The human who sent the message — same as conversationId for SMS. */
  senderId: string;
}

/** Map a raw Twilio inbound payload to {conversationId, senderId}. */
export function resolveSmsSource(message: SmsMessageLike | undefined | null): ResolvedSmsSource {
  const from = message?.From ?? '';
  return { conversationId: from, senderId: from };
}

/** The subset of `sms` config the conversation gate reads. */
export interface SmsAccessConfig {
  dmPolicy?: 'open' | 'allowlist' | 'disabled';
  dmAllowlist?: string[];
}

/** Gate an already-resolved SMS source against `dmPolicy`/`dmAllowlist`. */
export function isResolvedSourceAllowed(
  cfg: SmsAccessConfig | undefined,
  resolved: ResolvedSmsSource,
): boolean {
  if (!resolved.senderId) return false;
  return isSmsSenderAllowed(cfg?.dmPolicy, cfg?.dmAllowlist, resolved.senderId);
}

/**
 * Convenience wrapper that resolves a raw inbound payload and gates it in
 * one call. Equivalent to `isResolvedSourceAllowed(cfg, resolveSmsSource(message))`.
 */
export function isSmsConversationAllowed(
  cfg: SmsAccessConfig | undefined,
  message: SmsMessageLike | undefined | null,
): boolean {
  return isResolvedSourceAllowed(cfg, resolveSmsSource(message));
}
