import { parseSkill, extractFrontmatter, type ParseSkillOptions } from '../../src/skills/parser';

const defaultOpts: ParseSkillOptions = {
  filePath: '/workspace/skills/test/SKILL.md',
  source: 'workspace',
};

describe('Skill Parser', () => {
  describe('extractFrontmatter', () => {
    it('extracts YAML frontmatter between --- delimiters', () => {
      const raw = `---\nname: test\n---\n\nBody content here`;
      const result = extractFrontmatter(raw);
      expect(result).not.toBeNull();
      expect(result!.frontmatter.name).toBe('test');
      expect(result!.body).toBe('Body content here');
    });

    it('returns null if no frontmatter delimiters', () => {
      expect(extractFrontmatter('No frontmatter')).toBeNull();
    });

    it('returns null if only opening delimiter', () => {
      expect(extractFrontmatter('---\nname: test\nNo closing')).toBeNull();
    });

    it('returns null if YAML is invalid', () => {
      expect(extractFrontmatter('---\n: :\n  bad: [yaml\n---\n')).toBeNull();
    });
  });

  describe('parseSkill', () => {
    it('P1: parses metadata.openclaw format (baidu-search style)', () => {
      const raw = [
        '---',
        'name: baidu-search',
        'description: Search the web using Baidu AI Search Engine',
        'metadata:',
        '  openclaw:',
        '    emoji: "🔍"',
        '    requires:',
        '      bins: ["python3"]',
        '      env: ["BAIDU_API_KEY"]',
        '    primaryEnv: "BAIDU_API_KEY"',
        '---',
        '',
        '# Baidu Search',
      ].join('\n');

      const skill = parseSkill(raw, defaultOpts);
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe('baidu-search');
      expect(skill!.description).toBe('Search the web using Baidu AI Search Engine');
      expect(skill!.emoji).toBe('🔍');
      expect(skill!.requires).toEqual({ bins: ['python3'], env: ['BAIDU_API_KEY'] });
      expect(skill!.primaryEnv).toBe('BAIDU_API_KEY');
    });

    it('P2: parses metadata.clawdbot format (canva style)', () => {
      const raw = [
        '---',
        'name: canva',
        'description: Canva design operations',
        'version: 1.0.0',
        'author: clawdbot',
        'metadata:',
        '  clawdbot:',
        '    emoji: "🎨"',
        '    requires:',
        '      env:',
        '        - CANVA_CLIENT_ID',
        '        - CANVA_CLIENT_SECRET',
        '    primaryEnv: CANVA_CLIENT_ID',
        '---',
        '',
        '# Canva Skill',
      ].join('\n');

      const skill = parseSkill(raw, defaultOpts);
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe('canva');
      expect(skill!.emoji).toBe('🎨');
      expect(skill!.requires).toEqual({ env: ['CANVA_CLIENT_ID', 'CANVA_CLIENT_SECRET'] });
      expect(skill!.primaryEnv).toBe('CANVA_CLIENT_ID');
      expect(skill!.version).toBe('1.0.0');
      expect(skill!.author).toBe('clawdbot');
    });

    it('P3: parses allowed-tools + read_when (agent-browser style)', () => {
      const raw = [
        '---',
        'name: agent-browser',
        'description: Headless browser automation',
        'read_when:',
        '  - Automating web interactions',
        '  - Extracting structured data from pages',
        'metadata:',
        '  clawdbot:',
        '    emoji: "🌐"',
        '    requires:',
        '      bins: ["node", "npm"]',
        'allowed-tools: Bash(agent-browser:*)',
        '---',
        '',
        '# Agent Browser',
      ].join('\n');

      const skill = parseSkill(raw, defaultOpts);
      expect(skill).not.toBeNull();
      expect(skill!.allowedTools).toEqual(['Bash(agent-browser:*)']);
      expect(skill!.readWhen).toEqual(['Automating web interactions', 'Extracting structured data from pages']);
      expect(skill!.requires).toEqual({ bins: ['node', 'npm'] });
    });

    it('P4: parses requires.plugins + keywords (elite-memory style)', () => {
      const raw = [
        '---',
        'name: elite-longterm-memory',
        'description: Ultimate AI agent memory system',
        'keywords: [memory, ai-agent, long-term-memory, vector-search]',
        'metadata:',
        '  openclaw:',
        '    emoji: "🧠"',
        '    requires:',
        '      env:',
        '        - OPENAI_API_KEY',
        '      plugins:',
        '        - memory-lancedb',
        '---',
        '',
        '# Memory System',
      ].join('\n');

      const skill = parseSkill(raw, defaultOpts);
      expect(skill).not.toBeNull();
      expect(skill!.requires).toEqual({
        env: ['OPENAI_API_KEY'],
        plugins: ['memory-lancedb'],
      });
      expect(skill!.keywords).toEqual(['memory', 'ai-agent', 'long-term-memory', 'vector-search']);
    });

    it('P5: parses install[] with kind: brew + kind: python (garmin style)', () => {
      const raw = [
        '---',
        'name: garmin-health',
        'description: Garmin health analysis',
        'metadata:',
        '  clawdbot:',
        '    emoji: "⌚"',
        '    requires:',
        '      env: ["GARMIN_EMAIL", "GARMIN_PASSWORD"]',
        '    install:',
        '      - id: garminconnect',
        '        kind: python',
        '        package: garminconnect',
        '        label: "Install garminconnect (pip)"',
        '      - id: gog',
        '        kind: brew',
        '        formula: steipete/tap/gogcli',
        '        bins: ["gog"]',
        '        label: "Install gog (brew)"',
        '---',
        '',
        '# Garmin Health',
      ].join('\n');

      const skill = parseSkill(raw, defaultOpts);
      expect(skill).not.toBeNull();
      expect(skill!.install).toHaveLength(2);
      expect(skill!.install![0]).toEqual({
        id: 'garminconnect',
        kind: 'python',
        package: 'garminconnect',
        label: 'Install garminconnect (pip)',
      });
      expect(skill!.install![1]).toEqual({
        id: 'gog',
        kind: 'brew',
        formula: 'steipete/tap/gogcli',
        bins: ['gog'],
        label: 'Install gog (brew)',
      });
    });

    it('P6: returns null when name is missing', () => {
      const raw = [
        '---',
        'description: A skill without a name',
        '---',
        '',
        '# No Name',
      ].join('\n');

      expect(parseSkill(raw, defaultOpts)).toBeNull();
    });

    it('P7: returns null for broken YAML frontmatter', () => {
      const raw = [
        '---',
        'name: test',
        '  bad_indent: [unclosed',
        '---',
        '',
        '# Broken',
      ].join('\n');

      expect(parseSkill(raw, defaultOpts)).toBeNull();
    });

    it('P8: parses primaryEnv + homepage + version + author', () => {
      const raw = [
        '---',
        'name: full-skill',
        'description: A skill with all optional fields',
        'version: 2.1.0',
        'author: TestAuthor',
        'homepage: https://example.com/skill',
        'metadata:',
        '  openclaw:',
        '    emoji: "🔧"',
        '    primaryEnv: MY_API_KEY',
        '---',
        '',
        '# Full Skill',
      ].join('\n');

      const skill = parseSkill(raw, defaultOpts);
      expect(skill).not.toBeNull();
      expect(skill!.primaryEnv).toBe('MY_API_KEY');
      expect(skill!.homepage).toBe('https://example.com/skill');
      expect(skill!.version).toBe('2.1.0');
      expect(skill!.author).toBe('TestAuthor');
    });

    it('preserves source and filePath from options', () => {
      const raw = '---\nname: test\ndescription: Test skill\n---\n\nBody';
      const opts: ParseSkillOptions = {
        filePath: '/shared/skills/test/SKILL.md',
        source: 'shared',
      };
      const skill = parseSkill(raw, opts);
      expect(skill!.source).toBe('shared');
      expect(skill!.filePath).toBe('/shared/skills/test/SKILL.md');
    });

    it('preserves modulePrefix from options', () => {
      const raw = '---\nname: access\ndescription: Manage access\n---\n\nBody';
      const opts: ParseSkillOptions = {
        filePath: '/mcp/tools/telegram/skills/access/SKILL.md',
        source: 'module',
        modulePrefix: 'telegram',
      };
      const skill = parseSkill(raw, opts);
      expect(skill!.modulePrefix).toBe('telegram');
    });

    it('defaults user-invocable to true', () => {
      const raw = '---\nname: test\ndescription: Test\n---\n\nBody';
      const skill = parseSkill(raw, defaultOpts);
      expect(skill!.userInvocable).toBe(true);
    });

    it('respects user-invocable: false', () => {
      const raw = '---\nname: test\ndescription: Test\nuser-invocable: false\n---\n\nBody';
      const skill = parseSkill(raw, defaultOpts);
      expect(skill!.userInvocable).toBe(false);
    });

    it('returns null when description is missing', () => {
      const raw = '---\nname: no-desc\n---\n\nBody';
      expect(parseSkill(raw, defaultOpts)).toBeNull();
    });

    it('stores full raw content in the content field', () => {
      const raw = '---\nname: test\ndescription: Test\n---\n\n# Instructions\nDo stuff';
      const skill = parseSkill(raw, defaultOpts);
      expect(skill!.content).toBe(raw);
    });
  });
});
