import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentRunner } from '../agent/runner';
import { AgentConfig, ApiKey } from '../types';
import { createApiAuthMiddleware, canAccessAgent } from './auth';

const MAX_MESSAGE_LENGTH = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;

type AuthedRequest = Request & { apiKey: ApiKey };

const AGENT_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;

/** Read config.json, mutate agents array, write back atomically. Throws if duplicate id detected. */
function writeAgentsToConfig(
  configPath: string,
  mutate: (agents: unknown[]) => void,
  newId?: string,
): void {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as { agents: unknown[]; [k: string]: unknown };
  if (newId) {
    const exists = (config.agents as Record<string, unknown>[]).some((a) => a.id === newId);
    if (exists) throw Object.assign(new Error(`Agent '${newId}' already exists in config`), { code: 'DUPLICATE' });
  }
  mutate(config.agents);
  const tmp = configPath + '.tmp.' + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmp, configPath);
}

export function createApiRouter(
  agentRunners: Map<string, AgentRunner>,
  agentConfigs: Map<string, AgentConfig>,
  apiKeys: ApiKey[],
  configPath?: string,
): Router {
  const router = Router();
  const auth = createApiAuthMiddleware(apiKeys);

  /**
   * POST /api/v1/agents/:agentId/messages
   *
   * Send a message to an agent and receive its response synchronously.
   * Body: { message: string, session_id?: string }
   */
  router.post('/v1/agents/:agentId/messages', auth, async (req: Request, res: Response) => {
    const { agentId } = req.params as { agentId: string };
    const apiKey = (req as AuthedRequest).apiKey;

    if (!canAccessAgent(apiKey, agentId)) {
      res.status(403).json({ error: `API key has no access to agent '${agentId}'` });
      return;
    }

    const runner = agentRunners.get(agentId);
    if (!runner) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const body = req.body as {
      message?: unknown;
      session_id?: unknown;
      stream?: unknown;
      timeout_ms?: unknown;
    };
    const { message, session_id, stream, timeout_ms } = body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `message too long (max ${MAX_MESSAGE_LENGTH} characters)` });
      return;
    }
    if (session_id !== undefined && typeof session_id !== 'string') {
      res.status(400).json({ error: 'session_id must be a string if provided' });
      return;
    }

    const requestId = randomUUID();
    const sessionId = (session_id as string | undefined) ?? randomUUID();
    const startTime = Date.now();
    const timeoutMs =
      typeof timeout_ms === 'number' && timeout_ms > 0 && timeout_ms <= 600_000
        ? timeout_ms
        : DEFAULT_TIMEOUT_MS;

    if (stream) {
      // SSE streaming mode
      let cleanup: (() => void) | undefined;
      try {
        const sseCallbacks = {
          onChunk: (event: import('../types').StreamEvent) => {
            try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
          },
          onDone: (fullText: string) => {
            try {
              res.write(`data: ${JSON.stringify({ type: 'result', text: fullText, request_id: requestId, session_id: sessionId, duration_ms: Date.now() - startTime })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            } catch { /* client gone */ }
          },
          onError: (err: Error) => {
            try {
              res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
              res.end();
            } catch { /* client gone */ }
          },
        };

        // Preflight conflict check — return 409 JSON before SSE headers are sent
        if (runner.hasActiveApiSession(sessionId)) {
          res.status(409).json({ error: 'Session already has a pending request' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.socket?.setNoDelay(true);

        cleanup = await runner.sendApiMessageStream(
          sessionId,
          message.trim(),
          sseCallbacks,
          { timeoutMs, allowTools: !!apiKey.allow_tools },
        );

        // Client disconnect -> cleanup
        res.on('close', cleanup);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (!res.headersSent) {
          if (code === 'CONFLICT') {
            res.status(409).json({ error: 'Session already has a pending request' });
          } else {
            res.status(500).json({ error: 'Internal error' });
          }
        } else {
          try {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'Internal error' })}\n\n`);
            res.end();
          } catch { /* client gone */ }
        }
      }
    } else {
      // Synchronous mode (existing behavior)
      try {
        const response = await runner.sendApiMessage(sessionId, message.trim(), {
          timeoutMs,
          allowTools: !!apiKey.allow_tools,
        });
        res.json({
          request_id: requestId,
          agent_id: agentId,
          response,
          session_id: sessionId,
          duration_ms: Date.now() - startTime,
        });
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === 'TIMEOUT') {
          res.status(504).json({ error: 'Agent response timeout' });
        } else if (code === 'CONFLICT') {
          res.status(409).json({ error: 'Session already has a pending request' });
        } else {
          res.status(500).json({ error: 'Internal error' });
        }
      }
    }
  });

  /**
   * GET /api/v1/agents
   *
   * List all agents (no API-key scope filter — auth is handled by Go API).
   */
  router.get('/v1/agents', auth, (_req: Request, res: Response) => {
    const agents = [...agentConfigs.entries()].map(([id, cfg]) => ({
      id,
      description: cfg.description,
      model: cfg.claude?.model ?? null,
    }));
    res.json({ agents });
  });

  /**
   * POST /api/v1/agents
   *
   * Create a new agent entry in config.json.
   * Body: { id, description, model? }
   */
  router.post('/v1/agents', auth, (req: Request, res: Response) => {
    if (!configPath) {
      res.status(501).json({ error: 'Agent management not available (no configPath)' });
      return;
    }
    const body = req.body as { id?: unknown; description?: unknown; model?: unknown };
    const { id, description, model } = body;

    if (!id || typeof id !== 'string' || !AGENT_ID_RE.test(id)) {
      res.status(400).json({ error: 'id must match pattern [a-z][a-z0-9_-]{1,31}' });
      return;
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    if (agentConfigs.has(id)) {
      res.status(409).json({ error: `Agent '${id}' already exists` });
      return;
    }

    const workspace = path.join(path.dirname(configPath), 'agents', id, 'workspace');
    const newAgent: Record<string, unknown> = {
      id,
      description: description.trim(),
      workspace,
      env: path.join(path.dirname(configPath), 'agents', id, 'workspace', '.env'),
      claude: {
        model: typeof model === 'string' && model.trim() ? model.trim() : 'claude-sonnet-4-6',
        dangerouslySkipPermissions: false,
        extraFlags: [],
      },
    };

    // Create workspace directory and required AGENTS.md so startAgent validation passes
    try {
      fs.mkdirSync(workspace, { recursive: true });
      const agentsMdPath = path.join(workspace, 'AGENTS.md');
      if (!fs.existsSync(agentsMdPath)) {
        fs.writeFileSync(agentsMdPath, `# Agent: ${id}\n\n${description.trim()}\n`, 'utf8');
      }
    } catch (err) {
      res.status(500).json({ error: `Failed to create workspace: ${(err as Error).message}` });
      return;
    }

    try {
      writeAgentsToConfig(configPath, (agents) => agents.push(newAgent), id);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'DUPLICATE') {
        res.status(409).json({ error: `Agent '${id}' already exists` });
      } else {
        res.status(500).json({ error: `Failed to write config: ${(err as Error).message}` });
      }
      return;
    }

    res.status(201).json({ agent: { id, description: newAgent.description, model: (newAgent.claude as Record<string, unknown>).model } });
  });

  /**
   * PATCH /api/v1/agents/:agentId
   *
   * Update agent description and/or model.
   * Body: { description?, model? }
   */
  router.patch('/v1/agents/:agentId', auth, (req: Request, res: Response) => {
    if (!configPath) {
      res.status(501).json({ error: 'Agent management not available (no configPath)' });
      return;
    }
    const { agentId } = req.params as { agentId: string };
    if (!agentConfigs.has(agentId)) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const body = req.body as { description?: unknown; model?: unknown };
    const { description, model } = body;
    if (description !== undefined && (typeof description !== 'string' || !description.trim())) {
      res.status(400).json({ error: 'description must be a non-empty string' });
      return;
    }
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
      res.status(400).json({ error: 'model must be a non-empty string' });
      return;
    }

    try {
      writeAgentsToConfig(configPath, (agents) => {
        const agent = (agents as Record<string, unknown>[]).find((a) => a.id === agentId);
        if (!agent) return;
        if (description !== undefined) agent.description = (description as string).trim();
        if (model !== undefined) {
          const claude = agent.claude as Record<string, unknown> | undefined;
          if (claude) claude.model = (model as string).trim();
        }
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to write config: ${(err as Error).message}` });
      return;
    }

    const cfg = agentConfigs.get(agentId)!;
    res.json({ agent: { id: agentId, description: cfg.description, model: cfg.claude?.model } });
  });

  /**
   * DELETE /api/v1/agents/:agentId
   *
   * Remove agent from config.json.
   */
  router.delete('/v1/agents/:agentId', auth, (req: Request, res: Response) => {
    if (!configPath) {
      res.status(501).json({ error: 'Agent management not available (no configPath)' });
      return;
    }
    const { agentId } = req.params as { agentId: string };
    if (!agentConfigs.has(agentId)) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    try {
      writeAgentsToConfig(configPath, (agents) => {
        const idx = (agents as Record<string, unknown>[]).findIndex((a) => a.id === agentId);
        if (idx !== -1) agents.splice(idx, 1);
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to write config: ${(err as Error).message}` });
      return;
    }

    res.json({ success: true, id: agentId });
  });

  return router;
}
