import * as fs from 'fs';
import * as path from 'path';

export interface MigrationResult {
  migrated: boolean;
  addedFields: string[];
}

/**
 * Deep-merge template into target, adding missing keys only.
 * Never overwrites existing values. Returns list of added field paths.
 */
function deepMerge(
  target: Record<string, unknown>,
  template: Record<string, unknown>,
  prefix: string,
  added: string[],
): void {
  for (const key of Object.keys(template)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (!(key in target)) {
      target[key] = structuredClone(template[key]);
      added.push(fullPath);
    } else if (
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key]) &&
      typeof template[key] === 'object' &&
      template[key] !== null &&
      !Array.isArray(template[key])
    ) {
      deepMerge(
        target[key] as Record<string, unknown>,
        template[key] as Record<string, unknown>,
        fullPath,
        added,
      );
    }
  }
}

/**
 * Merge missing fields from template agent into each user agent.
 * Uses the first agent in the template as the schema source.
 */
function mergeAgentArrays(
  userAgents: Array<Record<string, unknown>>,
  templateAgents: Array<Record<string, unknown>>,
  added: string[],
): void {
  if (templateAgents.length === 0) return;
  const schema = templateAgents[0];
  for (let i = 0; i < userAgents.length; i++) {
    deepMerge(userAgents[i], schema, `agents[${i}]`, added);
  }
}

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b, 0 if equal, 1 if a > b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Migrate config.json by adding missing fields from the template.
 * - Never overwrites existing values
 * - Creates a .bak backup before writing
 * - Skips migration if config file does not exist (first run)
 */
export function migrateConfig(
  configPath: string,
  templatePath: string,
  currentVersion: string,
): MigrationResult {
  // Config file missing = first run, create-agent handles it
  if (!fs.existsSync(configPath)) {
    return { migrated: false, addedFields: [] };
  }

  // Template must exist
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Config template not found at "${templatePath}". Cannot migrate.`);
  }

  // Read and parse config
  let configRaw: string;
  try {
    configRaw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read config file: ${(err as Error).message}`);
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(configRaw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Config file is not valid JSON: ${(err as Error).message}`);
  }

  // Read template
  const templateRaw = fs.readFileSync(templatePath, 'utf-8');
  const template = JSON.parse(templateRaw) as Record<string, unknown>;

  // Version check
  const configVersion = (config.configVersion as string) ?? '0.0.0';
  if (compareSemver(configVersion, currentVersion) >= 0) {
    return { migrated: false, addedFields: [] };
  }

  // Perform migration
  const added: string[] = [];

  // Deep-merge top-level keys (except agents which need special handling)
  const templateWithoutAgents = { ...template };
  delete templateWithoutAgents.agents;
  const configWithoutAgents = { ...config };
  delete configWithoutAgents.agents;
  deepMerge(config, templateWithoutAgents, '', added);

  // Merge agent arrays
  if (Array.isArray(config.agents) && Array.isArray(template.agents)) {
    mergeAgentArrays(
      config.agents as Array<Record<string, unknown>>,
      template.agents as Array<Record<string, unknown>>,
      added,
    );
  }

  // Update configVersion
  config.configVersion = currentVersion;
  if (!added.includes('configVersion')) {
    added.push('configVersion');
  }

  // Backup before writing
  const backupPath = configPath + '.bak';
  fs.copyFileSync(configPath, backupPath);

  // Write atomically via temp file
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, configPath);

  return { migrated: true, addedFields: added };
}

// Exported for testing
export { compareSemver, deepMerge };
