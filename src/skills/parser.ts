import yaml from 'js-yaml';

export interface SkillRequires {
  bins?: string[];
  env?: string[];
  plugins?: string[];
}

export interface SkillInstallDescriptor {
  id: string;
  kind: 'brew' | 'python' | 'npm' | 'apt';
  package?: string;
  formula?: string;
  bins?: string[];
  label: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  emoji?: string;
  userInvocable: boolean;
  allowedTools?: string[];
  readWhen?: string[];
  requires?: SkillRequires;
  install?: SkillInstallDescriptor[];
  primaryEnv?: string;
  homepage?: string;
  version?: string;
  author?: string;
  keywords?: string[];
  content: string;
  filePath: string;
  source: 'workspace' | 'module' | 'shared';
  modulePrefix?: string;
}

interface ParsedFrontmatter {
  [key: string]: unknown;
}

/**
 * Extract YAML frontmatter from a SKILL.md file.
 * Frontmatter is the content between the first two `---` lines.
 */
export function extractFrontmatter(raw: string): { frontmatter: ParsedFrontmatter; body: string } | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) return null;

  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) return null;

  const yamlBlock = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).trim();

  try {
    const parsed = yaml.load(yamlBlock);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return { frontmatter: parsed as ParsedFrontmatter, body };
  } catch {
    return null;
  }
}

/**
 * Resolve metadata from either `metadata.openclaw` or `metadata.clawdbot` namespace.
 * Returns the resolved namespace object, or undefined if neither exists.
 */
function resolveMetadataNamespace(fm: ParsedFrontmatter): Record<string, unknown> | undefined {
  const meta = fm.metadata;
  if (typeof meta !== 'object' || meta === null) return undefined;

  const obj = meta as Record<string, unknown>;
  // Prefer openclaw, fallback to clawdbot
  for (const ns of ['openclaw', 'clawdbot']) {
    const nsObj = obj[ns];
    if (typeof nsObj === 'object' && nsObj !== null) {
      return nsObj as Record<string, unknown>;
    }
  }
  return undefined;
}

function toStringArray(val: unknown): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  const arr = val.filter((v): v is string => typeof v === 'string');
  return arr.length > 0 ? arr : undefined;
}

function parseRequires(nsMeta: Record<string, unknown> | undefined): SkillRequires | undefined {
  if (!nsMeta) return undefined;
  const req = nsMeta.requires;
  if (typeof req !== 'object' || req === null) return undefined;

  const r = req as Record<string, unknown>;
  const result: SkillRequires = {};
  const bins = toStringArray(r.bins);
  const env = toStringArray(r.env);
  const plugins = toStringArray(r.plugins);

  if (bins) result.bins = bins;
  if (env) result.env = env;
  if (plugins) result.plugins = plugins;

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseInstall(nsMeta: Record<string, unknown> | undefined): SkillInstallDescriptor[] | undefined {
  if (!nsMeta) return undefined;
  const inst = nsMeta.install;
  if (!Array.isArray(inst)) return undefined;

  const descriptors: SkillInstallDescriptor[] = [];
  for (const item of inst) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== 'string' || typeof obj.kind !== 'string' || typeof obj.label !== 'string') continue;
    const validKinds = ['brew', 'python', 'npm', 'apt'];
    if (!validKinds.includes(obj.kind)) continue;

    const desc: SkillInstallDescriptor = {
      id: obj.id,
      kind: obj.kind as SkillInstallDescriptor['kind'],
      label: obj.label,
    };
    if (typeof obj.package === 'string') desc.package = obj.package;
    if (typeof obj.formula === 'string') desc.formula = obj.formula;
    const bins = toStringArray(obj.bins);
    if (bins) desc.bins = bins;

    descriptors.push(desc);
  }

  return descriptors.length > 0 ? descriptors : undefined;
}

export interface ParseSkillOptions {
  filePath: string;
  source: SkillDefinition['source'];
  modulePrefix?: string;
}

/**
 * Parse a SKILL.md file content into a SkillDefinition.
 * Returns null if the file is invalid (missing name/description, bad frontmatter).
 */
export function parseSkill(raw: string, opts: ParseSkillOptions): SkillDefinition | null {
  const extracted = extractFrontmatter(raw);
  if (!extracted) return null;

  const { frontmatter: fm, body } = extracted;

  // Required: name
  const name = typeof fm.name === 'string' ? fm.name : undefined;
  if (!name) return null;

  // Description: from frontmatter or first line of body
  const description = typeof fm.description === 'string' ? fm.description : undefined;
  if (!description) return null;

  const nsMeta = resolveMetadataNamespace(fm);

  const skill: SkillDefinition = {
    name,
    description,
    content: raw,
    filePath: opts.filePath,
    source: opts.source,
    userInvocable: fm['user-invocable'] !== false,
  };

  // Emoji
  const emoji = nsMeta?.emoji;
  if (typeof emoji === 'string') skill.emoji = emoji;

  // Requires
  const requires = parseRequires(nsMeta);
  if (requires) skill.requires = requires;

  // Install
  const install = parseInstall(nsMeta);
  if (install) skill.install = install;

  // allowed-tools (top-level or from metadata)
  const allowedTools = fm['allowed-tools'];
  if (typeof allowedTools === 'string') {
    skill.allowedTools = [allowedTools];
  } else {
    const arr = toStringArray(allowedTools);
    if (arr) skill.allowedTools = arr;
  }

  // read_when
  const readWhen = toStringArray(fm.read_when);
  if (readWhen) skill.readWhen = readWhen;

  // primaryEnv
  const primaryEnv = nsMeta?.primaryEnv;
  if (typeof primaryEnv === 'string') skill.primaryEnv = primaryEnv;

  // Optional display fields
  if (typeof fm.homepage === 'string') skill.homepage = fm.homepage;
  if (typeof fm.version === 'string') skill.version = fm.version;
  if (typeof fm.author === 'string') skill.author = fm.author;
  const keywords = toStringArray(fm.keywords);
  if (keywords) skill.keywords = keywords;

  // Module prefix
  if (opts.modulePrefix) skill.modulePrefix = opts.modulePrefix;

  return skill;
}
