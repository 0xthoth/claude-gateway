import { detectSkillCommand, formatSkillContext, type SkillInvocation } from '../../src/skills/invoker';
import type { SkillRegistry } from '../../src/skills/loader';
import type { SkillDefinition } from '../../src/skills/parser';

function makeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
  return {
    name: 'test',
    description: 'Test skill',
    content: '---\nname: test\ndescription: Test\n---\n\n# Test\n\nArguments: `$ARGUMENTS`',
    filePath: '/workspace/skills/test/SKILL.md',
    source: 'workspace',
    userInvocable: true,
    ...overrides,
  };
}

function makeRegistry(skills: [string, SkillDefinition][]): SkillRegistry {
  return { skills: new Map(skills) };
}

describe('Skill Invocation', () => {
  describe('detectSkillCommand', () => {
    it('I1: /github list prs → inject skill with args="list prs"', () => {
      const registry = makeRegistry([
        ['github', makeSkill({
          name: 'github',
          content: '---\nname: github\ndescription: GitHub ops\n---\n\nRun: `gh $ARGUMENTS`',
        })],
      ]);

      const result = detectSkillCommand('/github list prs', registry);
      expect(result).not.toBeNull();
      expect(result!.skillKey).toBe('github');
      expect(result!.args).toBe('list prs');
      expect(result!.content).toContain('Run: `gh list prs`');
    });

    it('I2: /telegram:access pair ABC → inject telegram:access skill', () => {
      const registry = makeRegistry([
        ['telegram:access', makeSkill({
          name: 'access',
          modulePrefix: 'telegram',
          content: '---\nname: access\n---\n\nPair: $ARGUMENTS',
        })],
      ]);

      const result = detectSkillCommand('/telegram:access pair ABC', registry);
      expect(result).not.toBeNull();
      expect(result!.skillKey).toBe('telegram:access');
      expect(result!.args).toBe('pair ABC');
      expect(result!.content).toContain('Pair: pair ABC');
    });

    it('I3: /unknown → returns null (skill not found)', () => {
      const registry = makeRegistry([
        ['github', makeSkill({ name: 'github' })],
      ]);

      const result = detectSkillCommand('/unknown', registry);
      expect(result).toBeNull();
    });

    it('I4: /github (no args) → inject skill with args=""', () => {
      const registry = makeRegistry([
        ['github', makeSkill({
          name: 'github',
          content: '---\nname: github\n---\n\nArgs: "$ARGUMENTS"',
        })],
      ]);

      const result = detectSkillCommand('/github', registry);
      expect(result).not.toBeNull();
      expect(result!.skillKey).toBe('github');
      expect(result!.args).toBe('');
      expect(result!.content).toContain('Args: ""');
    });

    it('returns null for non-command messages', () => {
      const registry = makeRegistry([
        ['github', makeSkill({ name: 'github' })],
      ]);

      expect(detectSkillCommand('Hello world', registry)).toBeNull();
      expect(detectSkillCommand('What is /github?', registry)).toBeNull();
    });

    it('returns null for empty registry', () => {
      const registry = makeRegistry([]);
      expect(detectSkillCommand('/github list prs', registry)).toBeNull();
    });

    it('returns null for non-invocable skills', () => {
      const registry = makeRegistry([
        ['internal', makeSkill({ name: 'internal', userInvocable: false })],
      ]);

      expect(detectSkillCommand('/internal', registry)).toBeNull();
    });

    it('substitutes all $ARGUMENTS occurrences', () => {
      const registry = makeRegistry([
        ['multi', makeSkill({
          name: 'multi',
          content: 'First: $ARGUMENTS\nSecond: $ARGUMENTS',
        })],
      ]);

      const result = detectSkillCommand('/multi hello', registry);
      expect(result!.content).toBe('First: hello\nSecond: hello');
    });

    it('trims whitespace from message and args', () => {
      const registry = makeRegistry([
        ['github', makeSkill({ name: 'github', content: 'Args: $ARGUMENTS' })],
      ]);

      const result = detectSkillCommand('  /github   list prs  ', registry);
      expect(result!.skillKey).toBe('github');
      expect(result!.args).toBe('list prs');
    });
  });

  describe('formatSkillContext', () => {
    it('formats skill invocation as XML context block', () => {
      const invocation: SkillInvocation = {
        skillKey: 'github',
        args: 'list prs',
        content: '# GitHub\n\nRun: `gh list prs`',
      };

      const formatted = formatSkillContext(invocation);
      expect(formatted).toContain('<skill-invocation name="github" args="list prs">');
      expect(formatted).toContain('# GitHub');
      expect(formatted).toContain('</skill-invocation>');
    });

    it('escapes quotes in args', () => {
      const invocation: SkillInvocation = {
        skillKey: 'test',
        args: 'search "hello world"',
        content: 'test',
      };

      const formatted = formatSkillContext(invocation);
      expect(formatted).toContain('args="search &quot;hello world&quot;"');
    });
  });
});
