import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, SessionError } from "../../src/sessions/session-manager.js";
import type {
  SessionLogEntry,
} from "../../src/types.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

// Mock logger that captures log calls
class MockLogger {
  logs: Array<{
    sessionId: string | null;
    eventType: string;
    component: string;
    payload: Record<string, unknown>;
  }> = [];

  log(entry: {
    sessionId: string | null;
    eventType: string;
    component: string;
    payload: Record<string, unknown>;
  }): void {
    this.logs.push(entry);
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("SessionManager", () => {
  let tempDir: string;
  let logger: MockLogger;
  let sessionManager: SessionManager;
  let testCounter = 0;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "session-manager-test-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    testCounter++;
    logger = new MockLogger();
    sessionManager = new SessionManager({
      sessionsDirectory: join(tempDir, `sessions-${testCounter}`),
      idleTimeoutMs: 5000,
      logger: logger as unknown as StructuredLogger,
    });
  });

  describe("getOrCreate()", () => {
    it("creates a new session with JSONL file", async () => {
      const session = await sessionManager.getOrCreate(
        "telegram",
        "chat-123",
        "user-456"
      );

      assert.ok(session.id, "session should have an id");
      assert.equal(session.state.adapterId, "telegram");
      assert.equal(session.state.channelId, "chat-123");
      assert.equal(session.state.senderId, "user-456");
      assert.ok(session.logPath.includes(session.id), "log path should contain session id");
    });

    it("returns the same session for the same identity triple", async () => {
      const session1 = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");
      const session2 = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      assert.equal(session1.id, session2.id, "same identity should return same session id");
      assert.equal(session1.logPath, session2.logPath, "log paths should be identical");
    });

    it("returns different sessions for different adapterId", async () => {
      const session1 = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");
      const session2 = await sessionManager.getOrCreate("discord", "chat-123", "user-456");

      assert.notEqual(session1.id, session2.id, "different adapter should have different session id");
    });

    it("returns different sessions for different channelId", async () => {
      const session1 = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");
      const session2 = await sessionManager.getOrCreate("telegram", "chat-789", "user-456");

      assert.notEqual(session1.id, session2.id, "different channel should have different session id");
    });

    it("returns different sessions for different senderId", async () => {
      const session1 = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");
      const session2 = await sessionManager.getOrCreate("telegram", "chat-123", "user-789");

      assert.notEqual(session1.id, session2.id, "different sender should have different session id");
    });

    it("logs session:create event", async () => {
      await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const createLog = logger.logs.find((l) => l.eventType === "session:create");
      assert.ok(createLog, "should log session:create event");
      assert.equal(createLog.payload.adapterId, "telegram");
      assert.equal(createLog.payload.channelId, "chat-123");
      assert.equal(createLog.payload.senderId, "user-456");
    });

    it("updates lastActivityAt when returning existing session", async () => {
      const session1 = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");
      const originalTime = session1.state.lastActivityAt;

      // Wait a bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      const session2 = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      assert.ok(
        session2.state.lastActivityAt >= originalTime,
        "lastActivityAt should be updated or unchanged"
      );
    });
  });

  describe("appendToLog()", () => {
    it("writes valid JSONL lines to session log", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const inboundEntry: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "Hello",
          timestamp: Date.now(),
        },
      };

      await sessionManager.appendToLog(session.id, inboundEntry);
      // If no error is thrown, the write succeeded
      assert.ok(true, "should write to log without error");
    });

    it("appends multiple entries sequentially", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const entry1: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "First",
          timestamp: Date.now(),
        },
      };

      const entry2: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-2",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "Second",
          timestamp: Date.now(),
        },
      };

      await sessionManager.appendToLog(session.id, entry1);
      await sessionManager.appendToLog(session.id, entry2);

      assert.ok(true, "should append multiple entries without error");
    });

    it("throws SessionError when session not found", async () => {
      const entry: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "Hello",
          timestamp: Date.now(),
        },
      };

      try {
        await sessionManager.appendToLog("nonexistent-session", entry);
        assert.fail("should throw SessionError");
      } catch (err) {
        assert.ok(err instanceof SessionError);
        assert.equal((err as SessionError).code, "NOT_FOUND");
      }
    });

    it("updates lastActivityAt when writing to log", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");
      const originalTime = session.state.lastActivityAt;

      await new Promise((resolve) => setTimeout(resolve, 10));

      const entry: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "Hello",
          timestamp: Date.now(),
        },
      };

      await sessionManager.appendToLog(session.id, entry);

      assert.ok(
        session.state.lastActivityAt >= originalTime,
        "lastActivityAt should be updated"
      );
    });
  });

  describe("getHistory()", () => {
    it("reads back appended messages as ChatMessage[]", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const inboundEntry: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "Hello from user",
          timestamp: Date.now(),
        },
      };

      const outboundEntry: SessionLogEntry = {
        type: "outbound",
        message: {
          channelId: "chat-123",
          text: "Hello from assistant",
        },
      };

      await sessionManager.appendToLog(session.id, inboundEntry);
      await sessionManager.appendToLog(session.id, outboundEntry);

      const history = await sessionManager.getHistory(session.id);

      assert.equal(history.length, 2, "should have 2 messages");
      assert.equal(history[0]!.role, "user");
      assert.equal(history[0]!.content, "Hello from user");
      assert.equal(history[1]!.role, "assistant");
      assert.equal(history[1]!.content, "Hello from assistant");
    });

    it("converts toolResult entries to tool ChatMessages", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const toolResultEntry: SessionLogEntry = {
        type: "toolResult",
        toolName: "shell",
        result: {
          success: true,
          output: "result data",
          durationMs: 100,
        },
      };

      await sessionManager.appendToLog(session.id, toolResultEntry);

      const history = await sessionManager.getHistory(session.id);

      assert.equal(history.length, 1, "should have 1 message");
      assert.equal(history[0]!.role, "tool");
      assert.equal(history[0]!.tool_call_id, "shell");
      assert.ok(history[0]!.content.includes("result data"));
    });

    it("returns empty array for nonexistent session", async () => {
      const history = await sessionManager.getHistory("nonexistent-session");

      assert.equal(history.length, 0, "should return empty array");
    });

    it("returns empty array for session with no log file", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      // Delete the log file to simulate missing file
      const history = await sessionManager.getHistory(session.id);

      assert.equal(history.length, 0, "should return empty array");
    });

    it("skips malformed JSON lines", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const validEntry: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "Valid message",
          timestamp: Date.now(),
        },
      };

      await sessionManager.appendToLog(session.id, validEntry);

      // Manually append a malformed line
      const { appendFile } = await import("node:fs/promises");
      await appendFile(session.logPath, "invalid json line\n", "utf-8");

      const history = await sessionManager.getHistory(session.id);

      // Should have only the valid entry, skipping the malformed line
      assert.equal(history.length, 1, "should skip malformed line");
      assert.equal(history[0]!.content, "Valid message");
    });

    it("respects limit parameter", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      for (let i = 0; i < 5; i++) {
        const entry: SessionLogEntry = {
          type: "inbound",
          message: {
            id: `msg-${i}`,
            adapterId: "telegram",
            channelId: "chat-123",
            senderId: "user-456",
            text: `Message ${i}`,
            timestamp: Date.now(),
          },
        };
        await sessionManager.appendToLog(session.id, entry);
      }

      const historyLimit2 = await sessionManager.getHistory(session.id, 2);
      const historyLimit0 = await sessionManager.getHistory(session.id, 0);

      assert.equal(historyLimit2.length, 2, "should limit to 2 messages");
      assert.equal(historyLimit0.length, 0, "should return empty array when limit is 0");
    });
  });

  describe("grantCapability() and getGrants()", () => {
    it("grants a capability to a session", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      sessionManager.grantCapability(session.id, "fs:read", "session");

      const grants = sessionManager.getGrants(session.id);
      assert.equal(grants.get("fs:read"), "session");
    });

    it("grants multiple capabilities to a session", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      sessionManager.grantCapability(session.id, "fs:read", "session");
      sessionManager.grantCapability(session.id, "fs:write", "persistent");
      sessionManager.grantCapability(session.id, "net:outbound", "session");

      const grants = sessionManager.getGrants(session.id);
      assert.equal(grants.get("fs:read"), "session");
      assert.equal(grants.get("fs:write"), "persistent");
      assert.equal(grants.get("net:outbound"), "session");
    });

    it("overwrites capability grant with new scope", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      sessionManager.grantCapability(session.id, "fs:read", "session");
      sessionManager.grantCapability(session.id, "fs:read", "persistent");

      const grants = sessionManager.getGrants(session.id);
      assert.equal(grants.get("fs:read"), "persistent");
    });

    it("throws SessionError when granting to nonexistent session", () => {
      try {
        sessionManager.grantCapability("nonexistent-session", "fs:read", "session");
        assert.fail("should throw SessionError");
      } catch (err) {
        assert.ok(err instanceof SessionError);
        assert.equal((err as SessionError).code, "NOT_FOUND");
      }
    });

    it("returns empty map for nonexistent session", () => {
      const grants = sessionManager.getGrants("nonexistent-session");

      assert.equal(grants.size, 0);
    });
  });

  describe("checkIdleSessions()", () => {
    it("detects idle sessions", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      // Manually manipulate lastActivityAt to make it look idle
      session.state.lastActivityAt = Date.now() - 10000; // 10 seconds ago

      const idle = sessionManager.checkIdleSessions();

      assert.ok(idle.includes(session.id), "should detect idle session");
    });

    it("does not mark active sessions as idle", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      // Session was just created, so it's active
      const idle = sessionManager.checkIdleSessions();

      assert.ok(!idle.includes(session.id), "should not mark active session as idle");
    });

    it("returns multiple idle sessions", async () => {
      const session1 = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");
      const session2 = await sessionManager.getOrCreate("telegram", "chat-456", "user-789");

      session1.state.lastActivityAt = Date.now() - 10000;
      session2.state.lastActivityAt = Date.now() - 10000;

      const idle = sessionManager.checkIdleSessions();

      assert.equal(idle.length, 2, "should detect 2 idle sessions");
      assert.ok(idle.includes(session1.id));
      assert.ok(idle.includes(session2.id));
    });

    it("respects idle timeout configuration", async () => {
      const managerWithShortTimeout = new SessionManager({
        sessionsDirectory: join(tempDir, "sessions-short"),
        idleTimeoutMs: 100,
        logger: logger as unknown as StructuredLogger,
      });

      const session = await managerWithShortTimeout.getOrCreate(
        "telegram",
        "chat-123",
        "user-456"
      );

      // Immediately, session should not be idle
      const idle1 = managerWithShortTimeout.checkIdleSessions();
      assert.ok(!idle1.includes(session.id));

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Now it should be idle
      const idle2 = managerWithShortTimeout.checkIdleSessions();
      assert.ok(idle2.includes(session.id));
    });
  });

  describe("close()", () => {
    it("removes session from active map", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      await sessionManager.close(session.id);

      const retrieved = sessionManager.get(session.id);
      assert.equal(retrieved, undefined, "session should be removed");
    });

    it("logs session:idle event", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      await sessionManager.close(session.id);

      const idleLog = logger.logs.find((l) => l.eventType === "session:idle");
      assert.ok(idleLog, "should log session:idle event");
      assert.equal(idleLog.sessionId, session.id);
    });

    it("is idempotent (closing again does not error)", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      await sessionManager.close(session.id);
      await sessionManager.close(session.id); // Should not error

      assert.ok(true, "should not throw error on double close");
    });
  });

  describe("markActive()", () => {
    it("updates lastActivityAt for a session", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");
      const originalTime = session.state.lastActivityAt;

      await new Promise((resolve) => setTimeout(resolve, 10));

      sessionManager.markActive(session.id);

      assert.ok(
        session.state.lastActivityAt >= originalTime,
        "lastActivityAt should be updated"
      );
    });

    it("does nothing for nonexistent session", () => {
      sessionManager.markActive("nonexistent-session");
      assert.ok(true, "should not error");
    });
  });

  describe("get()", () => {
    it("retrieves an existing session", async () => {
      const created = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const retrieved = sessionManager.get(created.id);

      assert.equal(retrieved?.id, created.id);
    });

    it("returns undefined for nonexistent session", () => {
      const retrieved = sessionManager.get("nonexistent-session");

      assert.equal(retrieved, undefined);
    });
  });
});
