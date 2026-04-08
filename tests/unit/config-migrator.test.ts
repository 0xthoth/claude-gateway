import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { migrateConfig, compareSemver } from '../../src/config-migrator';

describe('config-migrator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJson(name: string, data: unknown): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
    return p;
  }

  // ---------------------------------------------------------------------------
  // compareSemver
  // ---------------------------------------------------------------------------
  describe('compareSemver', () => {
    it('returns 0 for equal versions', () => {
      expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    });

    it('returns -1 when a < b', () => {
      expect(compareSemver('1.0.0', '1.1.0')).toBe(-1);
      expect(compareSemver('0.9.9', '1.0.0')).toBe(-1);
    });

    it('returns 1 when a > b', () => {
      expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
      expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Config file missing (first run)
  // ---------------------------------------------------------------------------
  it('returns migrated:false when config file does not exist', () => {
    const templatePath = writeJson('template.json', { configVersion: '1.0.0' });
    const configPath = path.join(tmpDir, 'nonexistent.json');
    const result = migrateConfig(configPath, templatePath, '1.0.0');
    expect(result.migrated).toBe(false);
    expect(result.addedFields).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Template file missing
  // ---------------------------------------------------------------------------
  it('throws when template file does not exist', () => {
    const configPath = writeJson('config.json', { configVersion: '0.0.0' });
    const templatePath = path.join(tmpDir, 'missing-template.json');
    expect(() => migrateConfig(configPath, templatePath, '1.0.0')).toThrow(
      /Config template not found/,
    );
  });

  // ---------------------------------------------------------------------------
  // Same version => no migration
  // ---------------------------------------------------------------------------
  it('returns migrated:false when configVersion matches currentVersion', () => {
    const configPath = writeJson('config.json', { configVersion: '1.0.0', gateway: {} });
    const templatePath = writeJson('template.json', { configVersion: '1.0.0', gateway: {} });
    const result = migrateConfig(configPath, templatePath, '1.0.0');
    expect(result.migrated).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Missing configVersion treats as 0.0.0 => migrates
  // ---------------------------------------------------------------------------
  it('treats missing configVersion as 0.0.0 and migrates', () => {
    const configPath = writeJson('config.json', { gateway: { logDir: '/logs' } });
    const templatePath = writeJson('template.json', {
      configVersion: '1.0.0',
      gateway: { logDir: '/default', timezone: 'UTC' },
    });
    const result = migrateConfig(configPath, templatePath, '1.0.0');
    expect(result.migrated).toBe(true);
    expect(result.addedFields).toContain('configVersion');

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(updated.configVersion).toBe('1.0.0');
  });

  // ---------------------------------------------------------------------------
  // Never overwrites existing values
  // ---------------------------------------------------------------------------
  it('never overwrites existing values', () => {
    const configPath = writeJson('config.json', {
      configVersion: '0.0.1',
      gateway: { logDir: '/my/logs', timezone: 'Asia/Bangkok' },
    });
    const templatePath = writeJson('template.json', {
      configVersion: '1.0.0',
      gateway: { logDir: '/default/logs', timezone: 'UTC', newField: 'hello' },
    });
    const result = migrateConfig(configPath, templatePath, '1.0.0');
    expect(result.migrated).toBe(true);

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Existing values preserved
    expect(updated.gateway.logDir).toBe('/my/logs');
    expect(updated.gateway.timezone).toBe('Asia/Bangkok');
    // New field added
    expect(updated.gateway.newField).toBe('hello');
    expect(result.addedFields).toContain('gateway.newField');
  });

  // ---------------------------------------------------------------------------
  // Agent array: adds missing fields to each agent
  // ---------------------------------------------------------------------------
  it('adds missing fields to each agent from template schema', () => {
    const configPath = writeJson('config.json', {
      agents: [
        { id: 'agent-a', telegram: { botToken: 'tok-a' } },
        { id: 'agent-b', telegram: { botToken: 'tok-b' } },
      ],
    });
    const templatePath = writeJson('template.json', {
      configVersion: '1.0.0',
      agents: [
        {
          id: 'example',
          telegram: { botToken: '${TOKEN}', dmPolicy: 'allowlist' },
          emojiReactionMode: 'minimal',
          signatureEmoji: '',
        },
      ],
    });
    const result = migrateConfig(configPath, templatePath, '1.0.0');
    expect(result.migrated).toBe(true);

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Agent A
    expect(updated.agents[0].id).toBe('agent-a'); // not overwritten
    expect(updated.agents[0].emojiReactionMode).toBe('minimal');
    expect(updated.agents[0].signatureEmoji).toBe('');
    expect(updated.agents[0].telegram.botToken).toBe('tok-a'); // not overwritten
    expect(updated.agents[0].telegram.dmPolicy).toBe('allowlist'); // added

    // Agent B
    expect(updated.agents[1].id).toBe('agent-b');
    expect(updated.agents[1].emojiReactionMode).toBe('minimal');

    expect(result.addedFields).toContain('agents[0].emojiReactionMode');
    expect(result.addedFields).toContain('agents[1].emojiReactionMode');
  });

  // ---------------------------------------------------------------------------
  // Backup is created before migration
  // ---------------------------------------------------------------------------
  it('creates a .bak backup before writing', () => {
    const original = { gateway: { logDir: '/logs' } };
    const configPath = writeJson('config.json', original);
    const templatePath = writeJson('template.json', {
      configVersion: '1.0.0',
      gateway: { logDir: '/default', newField: true },
    });

    migrateConfig(configPath, templatePath, '1.0.0');

    const backup = JSON.parse(fs.readFileSync(configPath + '.bak', 'utf-8'));
    expect(backup).toEqual(original);
  });

  // ---------------------------------------------------------------------------
  // Invalid JSON in config => throws
  // ---------------------------------------------------------------------------
  it('throws on invalid JSON in config file', () => {
    const configPath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(configPath, '{ invalid json }', 'utf-8');
    const templatePath = writeJson('template.json', { configVersion: '1.0.0' });

    expect(() => migrateConfig(configPath, templatePath, '1.0.0')).toThrow(
      /Config file is not valid JSON/,
    );
  });

  // ---------------------------------------------------------------------------
  // Preserves extra custom fields
  // ---------------------------------------------------------------------------
  it('preserves extra custom fields not in template', () => {
    const configPath = writeJson('config.json', {
      configVersion: '0.0.1',
      gateway: { logDir: '/logs' },
      customSection: { foo: 'bar' },
    });
    const templatePath = writeJson('template.json', {
      configVersion: '1.0.0',
      gateway: { logDir: '/default', newField: 'x' },
    });

    migrateConfig(configPath, templatePath, '1.0.0');

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(updated.customSection).toEqual({ foo: 'bar' });
  });

  // ---------------------------------------------------------------------------
  // Nested object merge
  // ---------------------------------------------------------------------------
  it('recursively adds nested missing fields', () => {
    const configPath = writeJson('config.json', {
      gateway: { api: { keys: [] } },
    });
    const templatePath = writeJson('template.json', {
      configVersion: '1.0.0',
      gateway: { api: { keys: [], rateLimit: 100 }, timezone: 'UTC' },
    });

    const result = migrateConfig(configPath, templatePath, '1.0.0');

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(updated.gateway.api.rateLimit).toBe(100);
    expect(updated.gateway.timezone).toBe('UTC');
    expect(result.addedFields).toContain('gateway.api.rateLimit');
    expect(result.addedFields).toContain('gateway.timezone');
  });

  // ---------------------------------------------------------------------------
  // Newer config version => no migration
  // ---------------------------------------------------------------------------
  it('skips migration when config version is already newer', () => {
    const configPath = writeJson('config.json', { configVersion: '2.0.0', gateway: {} });
    const templatePath = writeJson('template.json', { configVersion: '1.0.0', gateway: {} });
    const result = migrateConfig(configPath, templatePath, '1.0.0');
    expect(result.migrated).toBe(false);
  });
});
