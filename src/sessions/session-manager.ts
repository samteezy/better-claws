import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
import { WorkingMemory } from "../memory/working-memory.js";
import { workingMemoryRegistry } from "../tools/built-in/memory-update.js";

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
  readonly workingMemoryBudgetChars: number;
}

export interface SessionListItem {
  readonly sessionId: string;
  readonly adapterId: string;
  readonly channelId: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly archived: boolean;
  readonly preview: string;
}

export class SessionManager {
  private readonly sessionsDirectory: string;
  private readonly idleTimeoutMs: number;
  private readonly logger: StructuredLogger;
  private readonly workingMemoryBudgetChars: number;
  private readonly sessions = new Map<string, Session>();
  private dirCreated = false;

  constructor(options: SessionManagerOptions) {
    this.sessionsDirectory = options.sessionsDirectory;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.logger = options.logger;
    this.workingMemoryBudgetChars = options.workingMemoryBudgetChars;
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

    if (!workingMemoryRegistry.has(id)) {
      workingMemoryRegistry.set(
        id,
        new WorkingMemory(id, {
          maxSizeChars: this.workingMemoryBudgetChars,
          logger: this.logger,
        }),
      );
    }

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
        case "fork":
          // toolCall is captured inline in the messages array by the router;
          // compaction entries are handled above via the summary scan.
          // fork entries are provenance metadata — not part of the conversation.
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
    workingMemoryRegistry.delete(sessionId);
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
    workingMemoryRegistry.delete(sessionId);
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
      workingMemoryRegistry.set(
        id,
        new WorkingMemory(id, {
          maxSizeChars: this.workingMemoryBudgetChars,
          logger: this.logger,
        }),
      );
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

  async fork(
    sourceSessionId: string,
    adapterId: string,
    channelId: string,
    senderId: string,
  ): Promise<Session> {
    await this.ensureDirectory();

    // 1. Read source JSONL content — check active sessions, then archived files
    const sourceContent = await this.readRawLog(sourceSessionId);
    if (sourceContent === null) {
      throw new SessionError(
        `Source session "${sourceSessionId}" not found`,
        "NOT_FOUND",
      );
    }

    // 2. Derive new session ID and handle collision with existing active session
    const newId = this.deriveSessionId(adapterId, channelId, senderId);
    if (this.sessions.has(newId)) {
      await this.close(newId);
    }

    // 3. Build new JSONL: source content + fork provenance entry
    const sourceLines = sourceContent.trim().split("\n").filter(Boolean);
    const forkEntry: SessionLogEntry = {
      type: "fork",
      sourceSessionId,
      forkTimestamp: Date.now(),
      sourceLineCount: sourceLines.length,
    };

    const newContent = sourceContent.trimEnd() + "\n" + JSON.stringify(forkEntry) + "\n";
    const logPath = join(this.sessionsDirectory, `${newId}.jsonl`);
    await writeFile(logPath, newContent, "utf-8");

    // 4. Create in-memory session with fresh state
    const now = Date.now();
    const session: Session = {
      id: newId,
      state: {
        id: newId,
        adapterId,
        channelId,
        senderId,
        createdAt: now,
        lastActivityAt: now,
        capabilityGrants: new Map(),
      },
      logPath,
    };

    this.sessions.set(newId, session);

    const sourceMemory = workingMemoryRegistry.get(sourceSessionId);
    const wmOptions = {
      maxSizeChars: this.workingMemoryBudgetChars,
      logger: this.logger,
    };
    workingMemoryRegistry.set(
      newId,
      sourceMemory
        ? sourceMemory.clone(newId, wmOptions)
        : new WorkingMemory(newId, wmOptions),
    );

    this.logger.log({
      sessionId: newId,
      eventType: "session:fork",
      component: "session",
      payload: { sourceSessionId, adapterId, channelId, senderId },
    });

    return session;
  }

  async listForSender(senderId: string): Promise<readonly SessionListItem[]> {
    await this.ensureDirectory();

    const items: SessionListItem[] = [];

    // Active sessions
    for (const session of this.sessions.values()) {
      if (session.state.senderId === senderId) {
        let preview = "";
        try {
          const content = await readFile(session.logPath, "utf-8");
          preview = this.extractFirstMessageText(content);
        } catch {
          // No log file yet
        }

        items.push({
          sessionId: session.id,
          adapterId: session.state.adapterId,
          channelId: session.state.channelId,
          createdAt: session.state.createdAt,
          lastActivityAt: session.state.lastActivityAt,
          archived: false,
          preview,
        });
      }
    }

    // Archived sessions
    const archived = await this.listArchived();
    for (const entry of archived) {
      // Skip if we already have this session ID from active list
      if (items.some((i) => i.sessionId === entry.sessionId)) continue;

      const filePath = join(this.sessionsDirectory, entry.filename);
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      const firstInbound = this.extractFirstInbound(content);
      if (!firstInbound || firstInbound.senderId !== senderId) continue;

      const timestamps = this.extractTimestampBounds(content);
      const preview = this.extractFirstMessageText(content);

      items.push({
        sessionId: entry.sessionId,
        adapterId: firstInbound.adapterId,
        channelId: firstInbound.channelId,
        createdAt: timestamps.first,
        lastActivityAt: timestamps.last,
        archived: true,
        preview,
      });
    }

    this.logger.log({
      sessionId: null,
      eventType: "session:list",
      component: "session",
      payload: { senderId, resultCount: items.length },
    });

    return items;
  }

  private static readonly SESSION_ID_PATTERN = /^[0-9a-f]{16}$/;

  async readRawLog(sessionId: string): Promise<string | null> {
    if (!SessionManager.SESSION_ID_PATTERN.test(sessionId)) return null;

    // Check active session first
    const active = this.sessions.get(sessionId);
    if (active) {
      try {
        return await readFile(active.logPath, "utf-8");
      } catch {
        return null;
      }
    }

    // Check for active file on disk (not in memory — e.g. pre-recovery)
    await this.ensureDirectory();
    const activePath = join(this.sessionsDirectory, `${sessionId}.jsonl`);
    try {
      return await readFile(activePath, "utf-8");
    } catch {
      // Not an active file — check archives
    }

    // Check archived files — find most recent archive for this session ID
    const archived = await this.listArchived();
    const match = archived.find((a) => a.sessionId === sessionId);
    if (match) {
      const archivePath = join(this.sessionsDirectory, match.filename);
      try {
        return await readFile(archivePath, "utf-8");
      } catch {
        return null;
      }
    }

    return null;
  }

  private extractFirstMessageText(content: string): string {
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry["type"] === "inbound") {
          const msg = entry["message"] as Record<string, unknown> | undefined;
          const text = msg?.["text"];
          if (typeof text === "string") {
            return text.length > 80 ? text.slice(0, 77) + "..." : text;
          }
        }
      } catch {
        // skip
      }
    }
    return "";
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
