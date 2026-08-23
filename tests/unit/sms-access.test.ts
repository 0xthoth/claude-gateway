/**
 * Unit tests for the SMS sender access gate (src/api/sms-access.ts). Pure
 * logic, no network. Closed-by-default posture — mirrors
 * tests/unit/slack-access.test.ts's coverage, minus the group/channel half
 * (SMS has no group concept: every message is a 1:1 DM keyed on phone number).
 */
import {
  isSmsSenderAllowed,
  isSmsConversationAllowed,
  resolveSmsSource,
} from '../../src/api/sms-access';

const N1 = '+15551234567';
const N2 = '+15557654321';

describe('isSmsSenderAllowed()', () => {
  describe("policy 'open' → allow everyone", () => {
    test('listed or not, always true', () => {
      expect(isSmsSenderAllowed('open', [], N1)).toBe(true);
      expect(isSmsSenderAllowed('open', [N2], N1)).toBe(true);
      expect(isSmsSenderAllowed('open', undefined, N1)).toBe(true);
    });
    test('even an empty number passes', () => {
      expect(isSmsSenderAllowed('open', [], '')).toBe(true);
    });
  });

  describe("policy 'disabled' → deny everyone", () => {
    test('always false, even if in the list', () => {
      expect(isSmsSenderAllowed('disabled', [N1], N1)).toBe(false);
      expect(isSmsSenderAllowed('disabled', [], N1)).toBe(false);
    });
  });

  describe("policy 'allowlist' → only listed numbers", () => {
    test('number in list → true', () => {
      expect(isSmsSenderAllowed('allowlist', [N1, N2], N1)).toBe(true);
    });
    test('number not in list → false', () => {
      expect(isSmsSenderAllowed('allowlist', [N2], N1)).toBe(false);
    });
    test('empty or undefined list → false', () => {
      expect(isSmsSenderAllowed('allowlist', [], N1)).toBe(false);
      expect(isSmsSenderAllowed('allowlist', undefined, N1)).toBe(false);
    });
  });

  describe('policy undefined → closed default (allowlist semantics)', () => {
    test('number in list → true', () => {
      expect(isSmsSenderAllowed(undefined, [N1], N1)).toBe(true);
    });
    test('number not in list / empty / undefined list → false', () => {
      expect(isSmsSenderAllowed(undefined, [N2], N1)).toBe(false);
      expect(isSmsSenderAllowed(undefined, [], N1)).toBe(false);
      expect(isSmsSenderAllowed(undefined, undefined, N1)).toBe(false);
    });
  });

  describe('empty number', () => {
    test('false under closed/allowlist even if "" somehow in the list', () => {
      expect(isSmsSenderAllowed(undefined, [''], '')).toBe(false);
      expect(isSmsSenderAllowed('allowlist', [''], '')).toBe(false);
    });
  });
});

describe('resolveSmsSource()', () => {
  test('From number → both conversationId and senderId equal the number', () => {
    expect(resolveSmsSource({ From: N1 })).toEqual({ conversationId: N1, senderId: N1 });
  });
  test('missing From → both empty', () => {
    expect(resolveSmsSource({})).toEqual({ conversationId: '', senderId: '' });
    expect(resolveSmsSource(undefined)).toEqual({ conversationId: '', senderId: '' });
  });
});

describe('isSmsConversationAllowed()', () => {
  test('gates on dmPolicy/dmAllowlist keyed on the From number', () => {
    expect(isSmsConversationAllowed({ dmPolicy: 'open' }, { From: N1 })).toBe(true);
    expect(isSmsConversationAllowed({ dmAllowlist: [N1] }, { From: N1 })).toBe(true);
    expect(isSmsConversationAllowed({}, { From: N1 })).toBe(false); // closed default
    expect(isSmsConversationAllowed({ dmPolicy: 'disabled', dmAllowlist: [N1] }, { From: N1 })).toBe(false);
    // Allowlisting a different number must NOT grant access:
    expect(isSmsConversationAllowed({ dmAllowlist: [N2] }, { From: N1 })).toBe(false);
  });
  test('missing From → denied regardless of policy', () => {
    expect(isSmsConversationAllowed({ dmPolicy: 'open' }, {})).toBe(false);
    expect(isSmsConversationAllowed({ dmPolicy: 'open' }, undefined)).toBe(false);
  });
});
