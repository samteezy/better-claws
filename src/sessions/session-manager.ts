import { appendFile, mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  BetterClawsError,
  type Capability,
  type ChatMessage,
  type GrantScope,
  type SessionLogEntry,
  type SessionState,
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

    // Parse all entries, then find the last compaction point.
    // Everything before (and including) the last compaction is replaced by its summary.
    const parsed: SessionLogEntry[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as SessionLogEntry);
      } catch {
        // skip malformed lines
      }
    }

    let lastCompactionIdx = -1;
    let compactionSummary = "";
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i]!;
      if (entry.type === "compaction") {
        lastCompactionIdx = i;
        compactionSummary = entry.summary;
      }
    }

    const messages: ChatMessage[] = [];

    if (lastCompactionIdx !== -1) {
      messages.push({
        role: "user",
        content: `[Conversation summary: ${compactionSummary}]`,
      });
    }

    const startIdx = lastCompactionIdx + 1;
    for (let i = startIdx; i < parsed.length; i++) {
      const entry = parsed[i]!;
      switch (entry.type) {
        case "inbound":
          messages.push({ role: "user", content: entry.message.text });
          break;
        case "outbound":
          messages.push({ role: "assistant", content: entry.message.text });
          break;
        case "toolResult":
          messages.push({
            role: "tool",
            content: JSON.stringify(entry.result.output),
            tool_call_id: entry.toolName,
          });
          break;
        case "toolCall":
        case "compaction":
          // toolCall is captured inline in the messages array by the router;
          // compaction entries are handled above via the summary scan.
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

  list(): Session[] {
    return Array.from(this.sessions.values());
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

    const now = Date.now();
    const archivePath = join(
      this.sessionsDirectory,
      `${sessionId}.${now}.jsonl`,
    );

    try {
      await rename(session.logPath, archivePath);
    } catch {
      // File may not exist yet (no messages exchanged) — that's fine
    }

    this.logger.log({
      sessionId,
      eventType: "session:close",
      component: "session",
      payload: { closedAt: now, archivePath },
    });

    this.sessions.delete(sessionId);
  }

  async destroy(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await unlink(session.logPath);
    } catch {
      // File may not exist yet (no messages exchanged) — that's fine
    }

    this.logger.log({
      sessionId,
      eventType: "session:destroy",
      component: "session",
      payload: { destroyedAt: Date.now() },
    });

    this.sessions.delete(sessionId);
  }

  async listArchived(): Promise<
    readonly { sessionId: string; archivedAt: number; filename: string }[]
  > {
    await this.ensureDirectory();

    let entries: string[];
    try {
      entries = await readdir(this.sessionsDirectory);
    } catch {
      return [];
    }

    const archivePattern = /^([0-9a-f]{16})\.(\d+)\.jsonl$/;
    const results: { sessionId: string; archivedAt: number; filename: string }[] = [];

    for (const filename of entries) {
      const match = archivePattern.exec(filename);
      if (!match) continue;
      results.push({
        sessionId: match[1]!,
        archivedAt: parseInt(match[2]!, 10),
        filename,
      });
    }

    // Most recent first
    results.sort((a, b) => b.archivedAt - a.archivedAt);
    return results;
  }

  async recover(): Promise<number> {
    await this.ensureDirectory();

    let entries: string[];
    try {
      entries = await readdir(this.sessionsDirectory);
    } catch {
      return 0;
    }

    // Active session files: exactly "{16 hex chars}.jsonl"
    // Archived files: "{16 hex chars}.{timestamp}.jsonl" — skip these
    const activeFilePattern = /^([0-9a-f]{16})\.jsonl$/;
    let recoveredCount = 0;

    for (const filename of entries) {
      const match = activeFilePattern.exec(filename);
      if (!match) continue;

      const id = match[1]!;
      if (this.sessions.has(id)) continue;

      const logPath = join(this.sessionsDirectory, filename);

      let content: string;
      try {
        content = await readFile(logPath, "utf-8");
      } catch {
        this.logger.log({
          sessionId: id,
          eventType: "session:recover",
          component: "session",
          payload: { success: false, reason: "unreadable_file" },
        });
        continue;
      }

      const firstInbound = this.extractFirstInbound(content);
      if (!firstInbound) {
        this.logger.log({
          sessionId: id,
          eventType: "session:recover",
          component: "session",
          payload: { success: false, reason: "no_inbound_entry" },
        });
        continue;
      }

      const timestamps = this.extractTimestampBounds(content);

      const session: Session = {
        id,
        state: {
          id,
          adapterId: firstInbound.adapterId,
          channelId: firstInbound.channelId,
          senderId: firstInbound.senderId,
          createdAt: timestamps.first,
          lastActivityAt: timestamps.last,
          capabilityGrants: new Map(),
        },
        logPath,
      };

      this.sessions.set(id, session);
      recoveredCount++;

      this.logger.log({
        sessionId: id,
        eventType: "session:recover",
        component: "session",
        payload: {
          success: true,
          adapterId: firstInbound.adapterId,
          channelId: firstInbound.channelId,
          senderId: firstInbound.senderId,
        },
      });
    }

    return recoveredCount;
  }

  private extractFirstInbound(
    content: string,
  ): { adapterId: string; channelId: string; senderId: string } | null {
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (
          entry["type"] === "inbound" &&
          typeof entry["message"] === "object" &&
          entry["message"] !== null
        ) {
          const msg = entry["message"] as Record<string, unknown>;
          if (
            typeof msg["adapterId"] === "string" &&
            typeof msg["channelId"] === "string" &&
            typeof msg["senderId"] === "string"
          ) {
            return {
              adapterId: msg["adapterId"],
              channelId: msg["channelId"],
              senderId: msg["senderId"],
            };
          }
        }
      } catch {
        // Malformed line — continue
      }
    }
    return null;
  }

  private extractTimestampBounds(
    content: string,
  ): { first: number; last: number } {
    const now = Date.now();
    let first = now;
    let last = 0;
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry["type"] === "inbound" || entry["type"] === "outbound") {
          const msg = entry["message"] as Record<string, unknown> | undefined;
          const ts = msg?.["timestamp"];
          if (typeof ts === "number") {
            if (ts < first) first = ts;
            if (ts > last) last = ts;
          }
        }
      } catch {
        // skip
      }
    }

    if (last === 0) {
      first = now;
      last = now;
    }

    return { first, last };
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
