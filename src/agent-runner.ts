import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { AgentConfig, GatewayConfig, Logger } from './types';
import { createLogger } from './logger';

const AUTO_RESTART_DELAY_MS = 5_000;
const MAX_RESTARTS = 3;

export class AgentRunner extends EventEmitter {
  private readonly agentConfig: AgentConfig;
  private readonly gatewayConfig: GatewayConfig;
  private readonly logger: Logger;
  private process: ChildProcess | null = null;
  private restartCount = 0;
  private stopping = false;
  private initialPrompt: string = '';
  private callbackServer: http.Server | null = null;
  private callbackPort = 0;

  constructor(agentConfig: AgentConfig, gatewayConfig: GatewayConfig, logger?: Logger) {
    super();
    this.agentConfig = agentConfig;
    this.gatewayConfig = gatewayConfig;
    this.logger = logger ?? createLogger(agentConfig.id, gatewayConfig.gateway.logDir);
  }

  /**
   * Bind a local HTTP server that receives POST /channel from the Telegram
   * plugin (CLAUDE_CHANNEL_CALLBACK).  Each received payload is injected as
   * a stream-json user turn into the running Claude subprocess stdin.
   */
  private async startCallbackServer(): Promise<void> {
    this.callbackPort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
      srv.on('error', reject);
    });

    this.callbackServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
        try {
          const params = JSON.parse(raw) as { content?: string; meta?: Record<string, string> };
          const meta = params.meta ?? {};
          const chatId = meta['chat_id'] ?? '';
          const messageId = meta['message_id'] ?? '';
          const user = meta['user'] ?? '';
          const ts = meta['ts'] ?? new Date().toISOString();
          const content = params.content ?? '';

          // Inject as a stream-json user turn using the <channel> XML format
          // that Claude's --channels mode understands.
          const channelXml =
            `<channel source="telegram" chat_id="${chatId}" ` +
            `message_id="${messageId}" user="${user}" ts="${ts}">` +
            `${content}` +
            `</channel>`;
          this.sendMessage(channelXml);
          this.logger.debug('Injected channel turn into Claude stdin', { chatId, user });
        } catch (err) {
          this.logger.warn('Failed to parse channel callback body', { error: (err as Error).message });
        }
      });
    });

    this.callbackServer.listen(this.callbackPort, '127.0.0.1');
    this.logger.info('Channel callback server listening', { port: this.callbackPort });
  }

  /**
   * Wrap a plain-text message as a stream-json user turn.
   */
  private static toStreamJsonTurn(text: string): string {
    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    });
  }

  /**
   * Build the arguments for the `claude` subprocess.
   *
   * --input-format stream-json  — accept newline-delimited JSON turns on stdin,
   *                               enabling multi-turn injection while stdin stays open.
   * --output-format stream-json — required counterpart to --input-format stream-json.
   * --print                     — non-interactive output mode (no TTY required).
   * --verbose                   — required alongside --print for stream-json mode.
   * --channels plugin:telegram  — subscribe to notifications/claude/channel from
   *                               the telegram MCP plugin and keep the process
   *                               alive after the initial turn.
   */
  private buildArgs(mcpConfigPath: string): string[] {
    const args: string[] = [
      '--mcp-config', mcpConfigPath,
      '--strict-mcp-config',
      '--model', this.agentConfig.claude.model,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--print',
      '--verbose',
      '--channels', 'plugin:telegram',
    ];

    if (this.agentConfig.claude.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    for (const flag of this.agentConfig.claude.extraFlags) {
      args.push(flag);
    }

    return args;
  }

  /**
   * Build the environment for the subprocess.
   */
  private buildEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      TELEGRAM_BOT_TOKEN: this.agentConfig.telegram.botToken,
      CLAUDE_WORKSPACE: this.agentConfig.workspace,
      // Isolate Telegram state (allowlist, polling offset) per agent
      TELEGRAM_STATE_DIR: path.join(this.agentConfig.workspace, '.telegram-state'),
    };
  }

  /**
   * Ensure the agent's Telegram state directory exists and return its path.
   */
  private getTelegramStateDir(): string {
    const stateDir = path.join(this.agentConfig.workspace, '.telegram-state');
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.logger.warn('Could not create Telegram state dir', { error: (err as Error).message });
    }
    return stateDir;
  }

  /**
   * Write a per-agent MCP config that launches the Telegram plugin with
   * the correct bot token and isolated state directory.
   * Returns the path to the written config file.
   */
  private writeMcpConfig(): string {
    const stateDir = this.getTelegramStateDir();
    const pluginServerPath = path.resolve(__dirname, '..', 'plugins', 'telegram', 'server.ts');
    const mcpConfig = {
      mcpServers: {
        telegram: {
          command: 'bun',
          args: [pluginServerPath],
          env: {
            TELEGRAM_BOT_TOKEN: this.agentConfig.telegram.botToken,
            TELEGRAM_STATE_DIR: stateDir,
            CLAUDE_CHANNEL_CALLBACK: `http://127.0.0.1:${this.callbackPort}/channel`,
          },
        },
      },
    };
    const configPath = path.join(this.agentConfig.workspace, '.mcp-config.json');
    fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
    return configPath;
  }

  /**
   * Spawn the claude subprocess.
   */
  private spawnProcess(): void {
    const mcpConfigPath = this.writeMcpConfig();
    const args = this.buildArgs(mcpConfigPath);
    const env = this.buildEnv();

    // CLAUDE_BIN may contain a binary + extra args (space-separated), e.g. "node /path/mock.js"
    const claudeBinRaw = process.env.CLAUDE_BIN ?? 'claude';
    const claudeBinParts = claudeBinRaw.split(' ');
    const claudeBin = claudeBinParts[0];
    const extraBinArgs = claudeBinParts.slice(1);
    const allArgs = [...extraBinArgs, ...args];

    this.logger.info('Spawning claude subprocess', { args: allArgs, workspace: this.agentConfig.workspace, bin: claudeBin });

    const proc = spawn(claudeBin, allArgs, {
      env,
      cwd: this.agentConfig.workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process = proc;

    // Send initial prompt as a stream-json user turn.  stdin stays OPEN so
    // that subsequent channel notifications (injected via sendMessage) can be
    // delivered as additional turns.  --channels mode keeps Claude alive
    // after the initial turn and injects notifications/claude/channel events
    // from the MCP plugin as new conversation turns automatically.
    proc.stdin?.write(AgentRunner.toStreamJsonTurn(this.initialPrompt) + '\n');

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          this.emit('output', line);
          this.logger.debug('subprocess output', { line });
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      this.logger.warn('subprocess stderr', { stderr: data.toString() });
    });

    proc.on('exit', (code, signal) => {
      this.logger.info('subprocess exited', { code, signal });
      this.process = null;

      if (!this.stopping) {
        this.scheduleRestart();
      }
    });

    proc.on('error', (err) => {
      this.logger.error('subprocess error', { error: err.message });
    });
  }

  private scheduleRestart(): void {
    if (this.restartCount >= MAX_RESTARTS) {
      this.logger.error('Max restarts reached, giving up', { restartCount: this.restartCount });
      this.emit('failed');
      return;
    }

    this.restartCount++;
    this.logger.warn(`Scheduling restart in ${AUTO_RESTART_DELAY_MS}ms`, { attempt: this.restartCount });

    setTimeout(() => {
      if (!this.stopping) {
        this.logger.info('Auto-restarting subprocess');
        this.spawnProcess();
      }
    }, AUTO_RESTART_DELAY_MS);
  }

  /** Default prompt used on restarts (not first-run bootstrap). */
  private static readonly CHANNELS_ACTIVATION_PROMPT =
    'Channels mode is active. Wait for incoming messages from your channels and respond to them.';

  async start(bootstrapPrompt?: string): Promise<void> {
    this.stopping = false;
    this.restartCount = 0;
    this.initialPrompt = bootstrapPrompt ?? AgentRunner.CHANNELS_ACTIVATION_PROMPT;
    await this.startCallbackServer();
    this.spawnProcess();
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
    }

    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      const proc = this.process!;

      const onExit = () => {
        this.process = null;
        resolve();
      };

      proc.once('exit', onExit);
      proc.kill('SIGTERM');

      // Force kill after 10s if process doesn't respond to SIGTERM
      const forceKillTimer = setTimeout(() => {
        if (this.process) {
          this.logger.warn('Force-killing subprocess after timeout');
          proc.kill('SIGKILL');
        }
      }, 10_000);

      proc.once('exit', () => {
        clearTimeout(forceKillTimer);
      });
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    this.stopping = false;
    this.restartCount = 0;
    await this.startCallbackServer();
    this.spawnProcess();
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Inject a message into the running subprocess as a stream-json user turn.
   * Used for heartbeat/cron tasks and any out-of-band prompts that need to
   * be delivered while the agent is already running in --channels mode.
   */
  sendMessage(message: string): void {
    if (!this.process || !this.process.stdin) {
      this.logger.warn('Cannot send message: subprocess not running');
      return;
    }
    if (!this.process.stdin.writable) {
      this.logger.warn('Cannot send message: stdin not writable');
      return;
    }
    this.process.stdin.write(AgentRunner.toStreamJsonTurn(message) + '\n');
  }
}
