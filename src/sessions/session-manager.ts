import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  BetterClawsError,
  type Capability,
  type ChatMessage,
  type GrantScope,
  type InboundMessage,
  type OutboundMessage,
  type SessionLogEntry,
  type SessionState,
  type ToolCall,
  type ToolResult,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";

export class SessionError extends BetterClawsError {
  constructor(message: string, code: string = "SESSION_ERROR") {
    super(message, "session", code);
    this.name = "SessionError";
  }
}

export interface Session {
  readonly id: string;
  readonly state: SessionState;
  readonly logPath: string;
}

export interface SessionManagerOptions {
  readonly sessionsDirectory: string;
  readonly idleTimeoutMs: number;
  readonly logger: StructuredLogger;
}

export class SessionManager {
  private readonly sessionsDirectory: string;
  private readonly idleTimeoutMs: number;
  private readonly logger: StructuredLogger;
  private readonly sessions = new Map<string, Session>();
  private dirCreated = false;

  constructor(options: SessionManagerOptions) {
    this.sessionsDirectory = options.sessionsDirectory;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.logger = options.logger;
  }

  async getOrCreate(
    adapterId: string,
    channelId: string,
    senderId: string,
  ): Promise<Session> {
    const id = this.deriveSessionId(adapterId, channelId, senderId);
    const existing = this.sessions.get(id);
    if (existing) {
      existing.state.lastActivityAt = Date.now();
      return existing;
    }

    await this.ensureDirectory();
    const logPath = join(this.sessionsDirectory, `${id}.jsonl`);
    const now = Date.now();

    const session: Session = {
      id,
      state: {
        id,
        adapterId,
        channelId,
        senderId,
        createdAt: now,
        lastActivityAt: now,
        capabilityGrants: new Map(),
      },
      logPath,
    };

    this.sessions.set(id, session);

    this.logger.log({
      sessionId: id,
      eventType: "session:create",
      component: "session",
      payload: { adapterId, channelId, senderId },
    });

    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  async appendToLog(
    sessionId: string,
    entry: SessionLogEntry,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionError(
        `Session "${sessionId}" not found`,
        "NOT_FOUND",
      );
    }

    session.state.lastActivityAt = Date.now();
    const line = JSON.stringify(entry) + "\n";

    try {
      await appendFile(session.logPath, line, "utf-8");
    } catch (err) {
      throw new SessionError(
        `Failed to write to session log: ${err instanceof Error ? err.message : String(err)}`,
        "WRITE_ERROR",
      );
    }
  }

  async getHistory(
    sessionId: string,
    limit?: number,
  ): Promise<ChatMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    let content: string;
    try {
      content = await readFile(session.logPath, "utf-8");
    } catch {
      return [];
    }

    const lines = content.trim().split("\n").filter(Boolean);
    const messages: ChatMessage[] = [];

    for (const line of lines) {
      let entry: SessionLogEntry;
      try {
        entry = JSON.parse(line) as SessionLogEntry;
      } catch {
        continue; // skip malformed lines
      }

      switch (entry.type) {
        case "inbound":
          messages.push({
            role: "user",
            content: entry.message.text,
          });
          break;
        case "outbound":
          messages.push({
            role: "assistant",
            content: entry.message.text,
          });
          break;
        case "toolResult":
          messages.push({
            role: "tool",
            content: JSON.stringify(entry.result.output),
            tool_call_id: entry.toolName,
          });
          break;
      }
    }

    if (limit !== undefined) {
      if (limit <= 0) return [];
      return messages.slice(-limit);
    }
    return messages;
  }

  grantCapability(
    sessionId: string,
    capability: Capability,
    scope: GrantScope,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionError(
        `Session "${sessionId}" not found`,
        "NOT_FOUND",
      );
    }
    session.state.capabilityGrants.set(capability, scope);
  }

  getGrants(sessionId: string): Map<string, GrantScope> {
    const session = this.sessions.get(sessionId);
    if (!session) return new Map();
    return session.state.capabilityGrants;
  }

  markActive(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state.lastActivityAt = Date.now();
    }
  }

  checkIdleSessions(): string[] {
    const now = Date.now();
    const idle: string[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.state.lastActivityAt > this.idleTimeoutMs) {
        idle.push(id);
      }
    }
    return idle;
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger.log({
      sessionId,
      eventType: "session:idle",
      component: "session",
      payload: { closedAt: Date.now() },
    });

    this.sessions.delete(sessionId);
  }

  private deriveSessionId(
    adapterId: string,
    channelId: string,
    senderId: string,
  ): string {
    const input = `${adapterId}:${channelId}:${senderId}`;
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.dirCreated) {
      await mkdir(this.sessionsDirectory, { recursive: true });
      this.dirCreated = true;
    }
  }
}
