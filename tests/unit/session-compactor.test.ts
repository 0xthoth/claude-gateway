import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from '../../src/session/store';
import { SessionCompactor, NotEnoughMessagesError } from '../../src/session/compactor';
import { Message } from '../../src/types';

// ── Mock child_process.spawnSync ─────────────────────────────────────────────

const mockSpawnSync = jest.fn();
jest.mock('child_process', () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(role: 'user' | 'assistant', content: string, ts = Date.now()): Message {
  return { role, content, ts };
}

function makeSpawnSuccess(summaryText: string) {
  return { status: 0, stdout: summaryText, stderr: '', error: undefined };
}

function makeSpawnError(status: number, stderr = 'CLI Error') {
  return { status, stdout: '', stderr, error: undefined };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionCompactor', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let compactor: SessionCompactor;

  const agentId = 'test-agent';
  const chatId = '123456';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compactor-test-'));
    sessionStore = new SessionStore(tmpDir);
    compactor = new SessionCompactor(sessionStore);
    mockSpawnSync.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // U18: compact with < 5 messages → throws NotEnoughMessagesError
  // -------------------------------------------------------------------------
  it('U18: compact with fewer than 5 messages throws NotEnoughMessagesError', async () => {
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg('user', 'msg 1'));
    await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg('assistant', 'reply 1'));
    await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg('user', 'msg 2'));

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toThrow(NotEnoughMessagesError);

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toThrow('3 messages, minimum 5 required');
  });

  it('U18b: compact with exactly 4 messages throws NotEnoughMessagesError', async () => {
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    for (let i = 0; i < 4; i++) {
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg('user', `msg ${i}`));
    }

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toBeInstanceOf(NotEnoughMessagesError);

    // claude CLI should NOT have been called (error thrown before CLI call)
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // U19: successful compact → archive saved at {sessionId}.pre-compact-{ts}.json
  // -------------------------------------------------------------------------
  it('U19: successful compact saves archive file named {sessionId}.pre-compact-{ts}.json', async () => {
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    for (let i = 0; i < 6; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg(role, `message ${i}`));
    }

    mockSpawnSync.mockReturnValueOnce(makeSpawnSuccess('This is a concise summary of the conversation.'));

    const tsBefore = Date.now();
    await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);
    const tsAfter = Date.now();

    const telegramDir = path.join(tmpDir, agentId, 'sessions', `telegram-${chatId}`);
    const archiveFiles = fs.readdirSync(telegramDir).filter(f => f.includes('.pre-compact-'));
    expect(archiveFiles).toHaveLength(1);

    const archiveFile = archiveFiles[0];
    expect(archiveFile).toMatch(new RegExp(`^${sessionId}\\.pre-compact-\\d+\\.json$`));

    const tsInFile = parseInt(archiveFile.replace(`${sessionId}.pre-compact-`, '').replace('.json', ''), 10);
    expect(tsInFile).toBeGreaterThanOrEqual(tsBefore);
    expect(tsInFile).toBeLessThanOrEqual(tsAfter);

    const archivePath = path.join(telegramDir, archiveFile);
    const archived = JSON.parse(fs.readFileSync(archivePath, 'utf-8')) as Message[];
    expect(archived).toHaveLength(6);
  });

  // -------------------------------------------------------------------------
  // U20: compacted history has summary system message + last 40 verbatim
  // -------------------------------------------------------------------------
  it('U20: compacted history has summary system message as first entry plus last 40 verbatim messages', async () => {
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    // Populate with 7 messages (fewer than 40, so all are kept verbatim)
    const messages: Message[] = [];
    for (let i = 0; i < 7; i++) {
      const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
      const msg = makeMsg(role, `content of message ${i}`, Date.now() + i);
      messages.push(msg);
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, msg);
    }

    const summaryText = 'Summary: user asked about 7 things, assistant answered.';
    mockSpawnSync.mockReturnValueOnce(makeSpawnSuccess(summaryText));

    await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);

    const compacted = await sessionStore.loadTelegramSession(agentId, chatId, sessionId);

    // 7 messages < 40, so all 7 kept + 1 summary = 8
    expect(compacted).toHaveLength(8);

    // First message is the system summary
    expect(compacted[0].role).toBe('system');
    expect(compacted[0].content).toContain('[Conversation Summary]');
    expect(compacted[0].content).toContain(summaryText);

    // All 7 original messages are verbatim
    for (let i = 0; i < 7; i++) {
      expect(compacted[i + 1].content).toBe(messages[i].content);
    }
  });

  it('U20b: compact returns correct CompactionResult metadata', async () => {
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    // 5 messages of known content
    for (let i = 0; i < 5; i++) {
      const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg(role, '1234567890'));
    }

    mockSpawnSync.mockReturnValueOnce(makeSpawnSuccess('brief summary'));

    const result = await compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000);

    expect(result.beforeMessages).toBe(5);
    expect(result.afterMessages).toBe(6); // 1 summary + 5 verbatim (all < 40)
    expect(result.beforeTokens).toBeGreaterThan(0);
    expect(result.afterTokens).toBeGreaterThan(0);
    expect(result.reductionPct).toBeGreaterThanOrEqual(0);
    expect(result.contextPctBefore).toBeGreaterThanOrEqual(0);
    expect(result.contextPctAfter).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // U21: CLI failure mid-compact → original history unchanged
  // -------------------------------------------------------------------------
  it('U21: CLI failure mid-compact leaves original history unchanged', async () => {
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    const originalMessages: Message[] = [];
    for (let i = 0; i < 5; i++) {
      const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
      const msg = makeMsg(role, `original message ${i}`);
      originalMessages.push(msg);
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, msg);
    }

    // Mock claude CLI returning non-zero exit
    mockSpawnSync.mockReturnValueOnce(makeSpawnError(1, 'Internal error'));

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toThrow('claude CLI exited with status 1');

    const afterFailure = await sessionStore.loadTelegramSession(agentId, chatId, sessionId);
    expect(afterFailure).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(afterFailure[i].content).toBe(originalMessages[i].content);
      expect(afterFailure[i].role).toBe(originalMessages[i].role);
    }
  });

  it('U21b: CLI process error mid-compact leaves original history unchanged', async () => {
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    const originalMessages: Message[] = [];
    for (let i = 0; i < 5; i++) {
      const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
      const msg = makeMsg(role, `message ${i}`);
      originalMessages.push(msg);
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, msg);
    }

    // Simulate process spawn error (e.g., claude not found)
    mockSpawnSync.mockReturnValueOnce({ status: null, stdout: '', stderr: '', error: new Error('spawn ENOENT') });

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toThrow('claude CLI error: spawn ENOENT');

    const afterFailure = await sessionStore.loadTelegramSession(agentId, chatId, sessionId);
    expect(afterFailure).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(afterFailure[i].content).toBe(originalMessages[i].content);
    }
  });

  it('U21c: CLI failure still saves the archive file before failing', async () => {
    // Archive write happens BEFORE the CLI call, so it should survive the failure
    const index = await sessionStore.getOrCreateIndex(agentId, chatId);
    const sessionId = index.activeSessionId;

    for (let i = 0; i < 5; i++) {
      const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
      await sessionStore.appendTelegramMessage(agentId, chatId, sessionId, makeMsg(role, `msg ${i}`));
    }

    mockSpawnSync.mockReturnValueOnce(makeSpawnError(1, 'Rate limited'));

    await expect(
      compactor.compact(agentId, chatId, sessionId, 'claude-sonnet-4-6', 200000),
    ).rejects.toThrow();

    const telegramDir = path.join(tmpDir, agentId, 'sessions', `telegram-${chatId}`);
    const archiveFiles = fs.readdirSync(telegramDir).filter(f => f.includes('.pre-compact-'));
    expect(archiveFiles).toHaveLength(1);
  });
});
