import * as yaml from 'js-yaml';
import { HeartbeatTask } from '../types';

// ---------- Error classes ----------

export class InvalidCronError extends Error {
  constructor(taskName: string, expr: string) {
    super(`Task "${taskName}": invalid cron expression "${expr}"`);
    this.name = 'InvalidCronError';
  }
}

export class InvalidIntervalError extends Error {
  constructor(taskName: string, interval: string) {
    super(`Task "${taskName}": invalid interval "${interval}"`);
    this.name = 'InvalidIntervalError';
  }
}

export class MissingPromptError extends Error {
  constructor(taskName: string) {
    super(`Task "${taskName}" is missing required field "prompt"`);
    this.name = 'MissingPromptError';
  }
}

export class MissingNameError extends Error {
  constructor(index: number) {
    super(`Task at index ${index} is missing required field "name"`);
    this.name = 'MissingNameError';
  }
}

export class AmbiguousScheduleError extends Error {
  constructor(taskName: string) {
    super(`Task "${taskName}" specifies both "cron" and "interval" — use exactly one`);
    this.name = 'AmbiguousScheduleError';
  }
}

export class MissingScheduleError extends Error {
  constructor(taskName: string) {
    super(`Task "${taskName}" must specify either "cron" or "interval"`);
    this.name = 'MissingScheduleError';
  }
}

// ---------- Cron validation ----------

/**
 * Validate a 5-field cron expression.
 * Fields: minute hour day-of-month month day-of-week
 */
function validateCron(expr: string): boolean {
  // Allow common step/range/wildcard patterns but reject obviously invalid values
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  // Ranges for each field: [min, max]
  const ranges: [number, number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day-of-month
    [1, 12], // month
    [0, 7],  // day-of-week (0 and 7 both = Sunday)
  ];

  for (let i = 0; i < 5; i++) {
    const field = fields[i];
    const [min, max] = ranges[i];
    if (!validateCronField(field, min, max)) {
      return false;
    }
  }
  return true;
}

function validateCronField(field: string, min: number, max: number): boolean {
  if (field === '*') return true;

  // Step: */N or N/N
  if (field.includes('/')) {
    const parts = field.split('/');
    if (parts.length !== 2) return false;
    const [base, step] = parts;
    const stepNum = parseInt(step, 10);
    if (isNaN(stepNum) || stepNum < 1) return false;
    if (base !== '*') {
      const baseNum = parseInt(base, 10);
      if (isNaN(baseNum) || baseNum < min || baseNum > max) return false;
    }
    return true;
  }

  // Range: N-M
  if (field.includes('-')) {
    const parts = field.split('-');
    if (parts.length !== 2) return false;
    const lo = parseInt(parts[0], 10);
    const hi = parseInt(parts[1], 10);
    if (isNaN(lo) || isNaN(hi)) return false;
    if (lo < min || hi > max || lo > hi) return false;
    return true;
  }

  // List: N,M,...
  if (field.includes(',')) {
    const parts = field.split(',');
    for (const p of parts) {
      const num = parseInt(p, 10);
      if (isNaN(num) || num < min || num > max) return false;
    }
    return true;
  }

  // Plain number
  const num = parseInt(field, 10);
  if (isNaN(num) || num < min || num > max) return false;
  return true;
}

// ---------- Interval conversion ----------

/**
 * Convert an interval string to a 5-field cron expression.
 * Supported: 30m, 2h, 1d, 1w
 */
export function intervalToCron(interval: string): string {
  const match = interval.match(/^(\d+)([mhdw])$/);
  if (!match) {
    return ''; // signal invalid
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'm':
      if (value < 1 || value > 59) return '';
      return `*/${value} * * * *`;
    case 'h':
      if (value < 1 || value > 23) return '';
      return `0 */${value} * * *`;
    case 'd':
      if (value !== 1) return '';
      return `0 0 * * *`;
    case 'w':
      if (value !== 1) return '';
      return `0 0 * * 0`;
    default:
      return '';
  }
}

// ---------- YAML extraction ----------

/**
 * Extract the YAML block from a heartbeat.md content string.
 * The YAML block is everything before the first markdown heading (`#`) line
 * that appears after the YAML content starts.
 *
 * Strategy: find the `tasks:` key, collect lines until we hit a line that
 * starts with `#` (markdown heading) that is NOT inside a YAML string.
 */
function extractYamlBlock(content: string): string {
  const lines = content.split('\n');
  const yamlLines: string[] = [];
  let inYaml = false;

  for (const line of lines) {
    // Detect start of YAML (tasks: key at root level)
    if (!inYaml && /^tasks\s*:/.test(line)) {
      inYaml = true;
    }

    if (inYaml) {
      // Stop at a markdown heading that is at column 0 and not part of YAML value
      // A line starting with `#` that is NOT indented signals end of YAML block
      if (/^#/.test(line)) {
        break;
      }
      yamlLines.push(line);
    }
  }

  return yamlLines.join('\n');
}

// ---------- Main parser ----------

export function parseHeartbeat(content: string): HeartbeatTask[] {
  const yamlBlock = extractYamlBlock(content);

  if (!yamlBlock.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlBlock);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.tasks)) {
    return [];
  }

  const rawTasks = root.tasks as unknown[];
  if (rawTasks.length === 0) {
    return [];
  }

  const tasks: HeartbeatTask[] = [];

  for (let i = 0; i < rawTasks.length; i++) {
    const raw = rawTasks[i] as Record<string, unknown>;

    // Validate name
    if (!raw.name || typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new MissingNameError(i);
    }
    const name = raw.name.trim();

    // Validate prompt
    if (!raw.prompt || typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
      throw new MissingPromptError(name);
    }
    const prompt = raw.prompt.trim();

    const hasCron = 'cron' in raw && raw.cron !== undefined && raw.cron !== null;
    const hasInterval = 'interval' in raw && raw.interval !== undefined && raw.interval !== null;

    if (hasCron && hasInterval) {
      throw new AmbiguousScheduleError(name);
    }
    if (!hasCron && !hasInterval) {
      throw new MissingScheduleError(name);
    }

    let cronExpr: string;

    if (hasCron) {
      cronExpr = String(raw.cron).trim();
      if (!validateCron(cronExpr)) {
        throw new InvalidCronError(name, cronExpr);
      }
    } else {
      const intervalStr = String(raw.interval).trim();
      cronExpr = intervalToCron(intervalStr);
      if (!cronExpr) {
        throw new InvalidIntervalError(name, intervalStr);
      }
    }

    tasks.push({ name, cron: cronExpr, prompt });
  }

  return tasks;
}
