import type { SkillRegistry } from './loader';

export interface SkillInvocation {
  skillKey: string;
  args: string;
  content: string;
}

/**
 * Detect if a message starts with a /skill-name command and resolve it.
 * Returns the skill invocation details, or null if no skill command detected.
 */
export function detectSkillCommand(text: string, registry: SkillRegistry): SkillInvocation | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  // Extract command and args: "/github list prs" → command="github", args="list prs"
  const spaceIdx = trimmed.indexOf(' ');
  const command = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  if (!command) return null;

  const skill = registry.skills.get(command);
  if (!skill) return null;

  if (!skill.userInvocable) return null;

  // Substitute $ARGUMENTS in content
  const content = skill.content.replace(/\$ARGUMENTS/g, args);

  return { skillKey: command, args, content };
}

/**
 * Format a skill invocation as a context block to append to the session message.
 */
export function formatSkillContext(invocation: SkillInvocation): string {
  return (
    `\n<skill-invocation name="${invocation.skillKey}" args="${invocation.args.replace(/"/g, '&quot;')}">\n` +
    `${invocation.content}\n` +
    `</skill-invocation>`
  );
}
