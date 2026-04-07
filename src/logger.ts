import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './types';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  ts: string;
  agentId: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

class AgentLogger implements Logger {
  private readonly agentId: string;
  private readonly logFilePath: string;

  constructor(agentId: string, logDir: string) {
    this.agentId = agentId;
    fs.mkdirSync(logDir, { recursive: true });
    this.logFilePath = path.join(logDir, `${agentId}.log`);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      agentId: this.agentId,
      level,
      message,
      ...(data !== undefined ? { data } : {}),
    };

    const line = JSON.stringify(entry);
    const pretty = JSON.stringify(entry, null, 2);

    // Write to stdout (pretty-printed for readability)
    process.stdout.write(pretty + '\n');

    // Write to log file (compact, one entry per line)
    try {
      fs.appendFileSync(this.logFilePath, line + '\n', 'utf-8');
    } catch {
      // If we can't write to the log file, just continue
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }
}

export function createLogger(agentId: string, logDir: string): Logger {
  return new AgentLogger(agentId, logDir);
}
