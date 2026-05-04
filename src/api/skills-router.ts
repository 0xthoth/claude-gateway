import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentConfig, ApiKey } from '../types';
import { createApiAuthMiddleware, canAccessAgent } from './auth';
import { loadSkills } from '../skills/loader';
import { extractFrontmatter } from '../skills/parser';

type AuthedRequest = Request & { apiKey: ApiKey };

const SHARED_SKILLS_DIR = path.join(os.homedir(), '.claude-gateway', 'shared-skills');
const MCP_TOOLS_DIR = path.resolve(__dirname, '..', '..', 'mcp', 'tools');
const MAX_SKILL_SIZE = 100 * 1024; // 100KB

// Skill name validation: lowercase alphanumeric + hyphens, 1-64 chars
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_NAMES = new Set([
  'help', 'sessions', 'session', 'new', 'clear', 'compact',
  'rename', 'model', 'restart', 'access', 'configure',
]);

function validateSkillName(name: string): string | null {
  if (!VALID_NAME_RE.test(name)) {
    return `Invalid skill name "${name}". Must be lowercase alphanumeric with hyphens, 1-64 chars.`;
  }
  if (RESERVED_NAMES.has(name)) {
    return `Skill name "${name}" is reserved.`;
  }
  return null;
}

function getSkillDir(scope: 'workspace' | 'shared', name: string, workspaceDir: string): string {
  return scope === 'workspace'
    ? path.join(workspaceDir, 'skills', name)
    : path.join(SHARED_SKILLS_DIR, name);
}

function toRawGitHubUrl(url: string): string {
  if (url.includes('raw.githubusercontent.com')) return url;
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(tree|blob)\/([^/]+)\/(.+)$/);
  if (match) {
    const [, owner, repo, , branch, filePath] = match;
    const finalPath = filePath.endsWith('SKILL.md') ? filePath : `${filePath}/SKILL.md`;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${finalPath}`;
  }
  return url;
}

export function createSkillsRouter(
  agentConfigs: Map<string, AgentConfig>,
  apiKeys: ApiKey[],
): Router {
  const router = Router();
  const auth = createApiAuthMiddleware(apiKeys);

  /**
   * GET /api/v1/agents/:agentId/skills
   * List all skills (workspace + module + shared).
   */
  router.get('/v1/agents/:agentId/skills', auth, (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const registry = loadSkills({
      workspaceDir: config.workspace,
      mcpToolsDir: MCP_TOOLS_DIR,
      sharedSkillsDir: SHARED_SKILLS_DIR,
    });

    const skills = [...registry.skills.entries()].map(([key, skill]) => ({
      key,
      name: skill.name,
      description: skill.description,
      scope: skill.source,
      emoji: skill.emoji ?? null,
      userInvocable: skill.userInvocable,
      modulePrefix: skill.modulePrefix ?? null,
    }));

    res.json({ skills });
  });

  /**
   * GET /api/v1/agents/:agentId/skills/:name
   * Get a single skill's content.
   */
  router.get('/v1/agents/:agentId/skills/:name', auth, (req: Request, res: Response) => {
    const { agentId, name } = req.params as { agentId: string; name: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const registry = loadSkills({
      workspaceDir: config.workspace,
      mcpToolsDir: MCP_TOOLS_DIR,
      sharedSkillsDir: SHARED_SKILLS_DIR,
    });

    const skill = registry.skills.get(name);
    if (!skill) {
      res.status(404).json({ error: `Skill '${name}' not found` });
      return;
    }

    let rawContent = '';
    try {
      rawContent = fs.readFileSync(skill.filePath, 'utf-8');
    } catch {
      rawContent = skill.content;
    }

    res.json({
      key: name,
      name: skill.name,
      description: skill.description,
      scope: skill.source,
      emoji: skill.emoji ?? null,
      content: rawContent,
    });
  });

  /**
   * POST /api/v1/agents/:agentId/skills
   * Create a new skill.
   * Body: { name, description, content, scope?: 'workspace' | 'shared' }
   */
  router.post('/v1/agents/:agentId/skills', auth, async (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const body = req.body as { name?: unknown; description?: unknown; content?: unknown; scope?: unknown };

    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (typeof body.description !== 'string' || !body.description.trim()) {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    if (typeof body.content !== 'string' || !body.content.trim()) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const name = body.name.trim();
    const description = body.description.trim();
    const content = body.content.trim();
    const scope = body.scope === 'shared' ? 'shared' : 'workspace';

    const nameErr = validateSkillName(name);
    if (nameErr) {
      res.status(400).json({ error: nameErr });
      return;
    }

    const skillDir = getSkillDir(scope, name, config.workspace);
    const skillFile = path.join(skillDir, 'SKILL.md');

    if (fs.existsSync(skillFile)) {
      res.status(409).json({ error: `Skill "${name}" already exists. Delete it first or choose a different name.` });
      return;
    }

    const skillMd = `---\nname: ${name}\ndescription: "${description.replace(/"/g, '\\"')}"\n---\n\n${content}`;

    try {
      fs.mkdirSync(skillDir, { recursive: true });
      const tmpFile = skillFile + '.tmp';
      fs.writeFileSync(tmpFile, skillMd, 'utf-8');
      fs.renameSync(tmpFile, skillFile);
      res.status(201).json({ message: `Skill "${name}" created (scope: ${scope})` });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/v1/agents/:agentId/skills/install
   * Install a skill from a GitHub or raw URL.
   * Body: { url, scope?: 'workspace' | 'shared', name?, force? }
   */
  router.post('/v1/agents/:agentId/skills/install', auth, async (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const body = req.body as { url?: unknown; scope?: unknown; name?: unknown; force?: unknown };

    if (typeof body.url !== 'string' || !body.url.trim()) {
      res.status(400).json({ error: 'url is required' });
      return;
    }

    const url = body.url.trim();
    if (!url.startsWith('https://')) {
      res.status(400).json({ error: 'Only HTTPS URLs are supported' });
      return;
    }

    const rawUrl = toRawGitHubUrl(url);
    const scope = body.scope === 'shared' ? 'shared' : 'workspace';
    const force = body.force === true;

    try {
      const response = await fetch(rawUrl);
      if (!response.ok) {
        res.status(400).json({ error: `Failed to fetch URL: ${response.status} ${response.statusText}` });
        return;
      }

      const content = await response.text();

      if (content.length > MAX_SKILL_SIZE) {
        res.status(400).json({ error: `SKILL.md exceeds ${MAX_SKILL_SIZE / 1024}KB limit` });
        return;
      }

      const extracted = extractFrontmatter(content);
      if (!extracted) {
        res.status(400).json({ error: 'Invalid SKILL.md: no valid YAML frontmatter found' });
        return;
      }

      const fm = extracted.frontmatter;
      const skillName = (typeof body.name === 'string' && body.name.trim())
        ? body.name.trim()
        : (typeof fm['name'] === 'string' ? fm['name'] : '');

      if (!skillName) {
        res.status(400).json({ error: 'Could not determine skill name from frontmatter. Use the name parameter.' });
        return;
      }

      const nameErr = validateSkillName(skillName);
      if (nameErr) {
        res.status(400).json({ error: nameErr });
        return;
      }

      const skillDir = getSkillDir(scope, skillName, config.workspace);
      const skillFile = path.join(skillDir, 'SKILL.md');

      if (fs.existsSync(skillFile) && !force) {
        res.status(409).json({ error: `Skill "${skillName}" already exists. Use force: true to overwrite.` });
        return;
      }

      fs.mkdirSync(skillDir, { recursive: true });
      const tmpFile = skillFile + '.tmp';
      fs.writeFileSync(tmpFile, content, 'utf-8');
      fs.renameSync(tmpFile, skillFile);

      const description = typeof fm['description'] === 'string' ? fm['description'] : '(no description)';
      res.status(201).json({
        message: `Skill "${skillName}" installed from ${rawUrl} (scope: ${scope})`,
        description,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * DELETE /api/v1/agents/:agentId/skills/:name
   * Delete a skill by name.
   * Query: scope=workspace|shared (default: workspace)
   */
  router.delete('/v1/agents/:agentId/skills/:name', auth, (req: Request, res: Response) => {
    const { agentId, name } = req.params as { agentId: string; name: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }

    const config = agentConfigs.get(agentId);
    if (!config) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const scope = req.query['scope'] === 'shared' ? 'shared' : 'workspace';
    const skillDir = getSkillDir(scope, name, config.workspace);
    const skillFile = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillFile)) {
      res.status(404).json({ error: `Skill "${name}" not found in ${scope}` });
      return;
    }

    try {
      fs.rmSync(skillDir, { recursive: true, force: true });
      res.json({ message: `Skill "${name}" deleted from ${scope}` });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
