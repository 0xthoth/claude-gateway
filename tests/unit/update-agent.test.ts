/**
 * Unit tests for update-agent feature (buildUpdatePrompt and strengthened acknowledge rule).
 */

import {
  buildUpdatePrompt,
  buildGenerationPrompt,
} from '../../scripts/create-agent-prompts';

describe('buildUpdatePrompt', () => {
  // U-UA-01: agent.md already has the acknowledge rule — output should still include it (no duplicate instruction needed)
  it('U-UA-01: includes acknowledge rule instruction when rule already exists in current content', () => {
    const currentContent = `# Agent: MyBot

## Rules
- Acknowledge first (mandatory): Every message MUST begin with a short acknowledgement before taking any action or calling any tool. No exceptions.
- Be helpful.`;

    const prompt = buildUpdatePrompt('MyBot', currentContent);

    expect(prompt).toContain('Acknowledge first (mandatory)');
    expect(prompt).toContain('Every message MUST begin with a short acknowledgement');
  });

  // U-UA-02: agent.md has no acknowledge rule — output must include instruction to add it
  it('U-UA-02: includes acknowledge rule instruction when rule is missing from current content', () => {
    const currentContent = `# Agent: MyBot

## Rules
- Be helpful.
- Never reveal secrets.`;

    const prompt = buildUpdatePrompt('MyBot', currentContent);

    expect(prompt).toContain('Acknowledge first (mandatory)');
    expect(prompt).toContain('add if missing, strengthen if weak');
  });

  // U-UA-03: buildUpdatePrompt preserves the existing role section by embedding currentContent
  it('U-UA-03: embeds the current agent.md content in the prompt', () => {
    const currentContent = `# Agent: Analyst

## Role
Senior data analyst specialized in Python and SQL.`;

    const prompt = buildUpdatePrompt('Analyst', currentContent);

    expect(prompt).toContain('# Agent: Analyst');
    expect(prompt).toContain('Senior data analyst specialized in Python and SQL.');
  });

  // U-UA-04: output is plain text — no === wrapper format (unlike buildGenerationPrompt)
  it('U-UA-04: prompt instructs to output only the agent.md content without === wrapper format', () => {
    const currentContent = `# Agent: Simple\n\nA simple agent.`;
    const prompt = buildUpdatePrompt('Simple', currentContent);

    // The update prompt should NOT tell Claude to use === file === wrapper sections
    expect(prompt).not.toContain('=== agent.md ===');
    // It should instruct output-only content
    expect(prompt).toContain('Output ONLY the updated agent.md content');
  });

  it('includes the agent name in the prompt', () => {
    const prompt = buildUpdatePrompt('Jeeves', '# Agent: Jeeves\nA butler.');
    expect(prompt).toContain('"Jeeves"');
  });

  it('includes the under 500 words constraint', () => {
    const prompt = buildUpdatePrompt('Bot', '# Agent: Bot\nA bot.');
    expect(prompt).toContain('500 words');
  });

  it('instructs to preserve the existing role and purpose', () => {
    const prompt = buildUpdatePrompt('Bot', '# Agent: Bot\nA bot.');
    expect(prompt).toContain("Preserve the agent's role, purpose, and all existing rules");
  });
});

describe('buildGenerationPrompt — strengthened acknowledge rule', () => {
  it('contains the mandatory acknowledge rule wording', () => {
    const prompt = buildGenerationPrompt('TestAgent', 'A test agent.');
    expect(prompt).toContain('Acknowledge first (mandatory)');
  });

  it('states that every message MUST begin with acknowledgement', () => {
    const prompt = buildGenerationPrompt('TestAgent', 'A test agent.');
    expect(prompt).toContain('Every message MUST begin with a text reply acknowledgement');
  });

  it('states no exceptions', () => {
    const prompt = buildGenerationPrompt('TestAgent', 'A test agent.');
    expect(prompt).toContain('No exceptions.');
  });

  it('references the ## Rules section placement', () => {
    const prompt = buildGenerationPrompt('TestAgent', 'A test agent.');
    expect(prompt).toContain('## Rules');
  });

  it('does not use the old weak wording', () => {
    const prompt = buildGenerationPrompt('TestAgent', 'A test agent.');
    expect(prompt).not.toContain('send a brief acknowledgement first');
  });
});
