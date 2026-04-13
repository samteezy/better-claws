import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createErrorClass, type EventType, type LogEntry } from "../types.js";
import { redactObject } from "../utils/redact.js";

export const LoggerError = createErrorClass("LoggerError", "logger", "LOGGER_ERROR");

const SENSITIVE_KEYS =
  /^(apikey|api_key|token|secret|password|authorization|credential)$/i;

function redactPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return redactObject(
    payload,
    (key) => SENSITIVE_KEYS.test(key),
  ) as Record<string, unknown>;
}

export interface StructuredLoggerOptions {
  readonly directory: string;
  readonly redactSensitive: boolean;
}

export class StructuredLogger {
  private readonly directory: string;
  private readonly redactSensitive: boolean;
  private readonly writeQueue: string[] = [];
  private draining = false;
  private dirCreated = false;

  constructor(options: StructuredLoggerOptions) {
    this.directory = options.directory;
    this.redactSensitive = options.redactSensitive;
  }

  log(entry: {
    sessionId: string | null;
    eventType: EventType;
    component: string;
    payload: Record<string, unknown>;
  }): void {
    const full: LogEntry = {
      timestamp: new Date().toISOString(),
      sessionId: entry.sessionId,
      eventType: entry.eventType,
      component: entry.component,
      payload: this.redactSensitive
        ? redactPayload(entry.payload)
        : entry.payload,
    };

    this.writeQueue.push(JSON.stringify(full) + "\n");
    this.scheduleDrain();
  }

  async flush(): Promise<void> {
    while (this.writeQueue.length > 0) {
      await this.drainQueue();
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleDrain(): void {
    if (!this.draining) {
      this.draining = true;
      queueMicrotask(() => {
        void this.drainQueue().finally(() => {
          this.draining = false;
          if (this.writeQueue.length > 0) {
            this.scheduleDrain();
          }
        });
      });
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.writeQueue.length === 0) return;

    const batch = this.writeQueue.splice(0);
    const data = batch.join("");

    try {
      await this.ensureDirectory();
      const filePath = this.getFilePath();
      await appendFile(filePath, data, "utf-8");
    } catch (err) {
      process.stderr.write(
        `[betterclaws:logger] Failed to write log: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.dirCreated) {
      await mkdir(this.directory, { recursive: true });
      this.dirCreated = true;
    }
  }

  private getFilePath(): string {
    const date = new Date().toISOString().slice(0, 10);
    return join(this.directory, `${date}.jsonl`);
  }
}
