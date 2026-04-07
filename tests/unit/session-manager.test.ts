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

    it("logs session:close event", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      await sessionManager.close(session.id);

      const closeLog = logger.logs.find((l) => l.eventType === "session:close");
      assert.ok(closeLog, "should log session:close event");
      assert.equal(closeLog.sessionId, session.id);
    });

    it("is idempotent (closing again does not error)", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      await sessionManager.close(session.id);
      await sessionManager.close(session.id); // Should not error

      assert.ok(true, "should not throw error on double close");
    });

    it("archives the session log file with timestamp suffix", async () => {
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
      const originalLogPath = session.logPath;

      const { existsSync } = await import("node:fs");
      const { readdir } = await import("node:fs/promises");

      // Before close, original file should exist
      assert.ok(existsSync(originalLogPath), "original log file should exist before close");

      await sessionManager.close(session.id);

      // After close, original file should not exist
      assert.ok(!existsSync(originalLogPath), "original log file should not exist after close");

      // An archived file should exist matching pattern {id}.{timestamp}.jsonl
      const files = await readdir(sessionManager["sessionsDirectory"]);
      const archivePattern = new RegExp(`^${session.id}\\.\\d+\\.jsonl$`);
      const archiveFiles = files.filter((f) => archivePattern.test(f));

      assert.equal(archiveFiles.length, 1, "should have exactly one archived file");
      assert.ok(archiveFiles[0]?.includes(session.id), "archived filename should contain session id");
    });

    it("does not throw when closing session with no log file", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      // Don't write any entries, so no log file exists
      await sessionManager.close(session.id);

      assert.ok(true, "should not throw error when log file does not exist");
    });

    it("logs archivePath in payload", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const inboundEntry: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "Test",
          timestamp: Date.now(),
        },
      };

      await sessionManager.appendToLog(session.id, inboundEntry);
      await sessionManager.close(session.id);

      const closeLog = logger.logs.find((l) => l.eventType === "session:close");
      assert.ok(closeLog, "should have close log entry");
      assert.ok(
        typeof closeLog.payload.archivePath === "string",
        "payload should contain archivePath string",
      );
      assert.ok(
        closeLog.payload.archivePath.includes(session.id),
        "archivePath should contain session id",
      );
    });
  });

  describe("destroy()", () => {
    it("removes session from active map", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      await sessionManager.destroy(session.id);

      const retrieved = sessionManager.get(session.id);
      assert.equal(retrieved, undefined, "session should be removed");
    });

    it("logs session:destroy event", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      await sessionManager.destroy(session.id);

      const destroyLog = logger.logs.find((l) => l.eventType === "session:destroy");
      assert.ok(destroyLog, "should log session:destroy event");
      assert.equal(destroyLog.sessionId, session.id);
      assert.ok(typeof destroyLog.payload.destroyedAt === "number", "payload should contain destroyedAt timestamp");
    });

    it("is idempotent (destroying again does not error)", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      await sessionManager.destroy(session.id);
      await sessionManager.destroy(session.id); // Should not error

      assert.ok(true, "should not throw error on double destroy");
    });

    it("deletes the session log file (no archive)", async () => {
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
      const logPath = session.logPath;

      const { existsSync } = await import("node:fs");
      const { readdir } = await import("node:fs/promises");

      // Before destroy, log file should exist
      assert.ok(existsSync(logPath), "log file should exist before destroy");

      await sessionManager.destroy(session.id);

      // After destroy, log file should be deleted (not archived)
      assert.ok(!existsSync(logPath), "log file should be deleted after destroy");

      // No archived files should exist (unlike close())
      const files = await readdir(sessionManager["sessionsDirectory"]);
      const archivePattern = new RegExp(`^${session.id}\\.\\d+\\.jsonl$`);
      const archiveFiles = files.filter((f) => archivePattern.test(f));

      assert.equal(archiveFiles.length, 0, "should not create any archived files");
    });

    it("does not throw when destroying session with no log file", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      // Don't write any entries, so no log file exists
      await sessionManager.destroy(session.id);

      assert.ok(true, "should not throw error when log file does not exist");
    });

    it("destroys on unknown session ID is a no-op", async () => {
      // Calling destroy on a non-existent session should not throw
      await sessionManager.destroy("nonexistent-session-id");

      assert.ok(true, "should not throw when destroying nonexistent session");
    });

    it("does not archive file like close() does", async () => {
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

      const { readdir } = await import("node:fs/promises");

      await sessionManager.destroy(session.id);

      // Verify file was deleted, not renamed
      const files = await readdir(sessionManager["sessionsDirectory"]);

      // Should have no files at all (destroy deletes, close archives)
      assert.equal(
        files.length,
        0,
        `directory should be empty after destroy, but contains: ${files.join(", ")}`,
      );
    });
  });

  describe("recover()", () => {
    it("recovers session from valid .jsonl file with inbound entry", async () => {
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

      // Create a fresh SessionManager pointing to the same directory
      const recoveredManager = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      const count = await recoveredManager.recover();

      assert.equal(count, 1, "should recover 1 session");
      const recovered = recoveredManager.get(session.id);
      assert.ok(recovered, "recovered session should exist");
      assert.equal(recovered.state.adapterId, "telegram");
      assert.equal(recovered.state.channelId, "chat-123");
      assert.equal(recovered.state.senderId, "user-456");
    });

    it("extracted session has correct createdAt from first message timestamp", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const firstTimestamp = Date.now() - 5000;
      const inboundEntry1: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "First message",
          timestamp: firstTimestamp,
        },
      };

      const inboundEntry2: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-2",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "Second message",
          timestamp: Date.now(),
        },
      };

      await sessionManager.appendToLog(session.id, inboundEntry1);
      await sessionManager.appendToLog(session.id, inboundEntry2);

      const recoveredManager = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      await recoveredManager.recover();
      const recovered = recoveredManager.get(session.id);

      assert.ok(recovered, "should have recovered session");
      assert.equal(recovered.state.createdAt, firstTimestamp, "createdAt should match first timestamp");
    });

    it("extracted session has correct lastActivityAt from latest message timestamp", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const baseTime = 1700000000000;
      const firstTimestamp = baseTime;
      const lastTimestamp = baseTime + 5000;

      const inboundEntry1: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "First message",
          timestamp: firstTimestamp,
        },
      };

      const inboundEntry2: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-2",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "Second message with latest timestamp",
          timestamp: lastTimestamp,
        },
      };

      // Manually write entries to simulate recovery scenario
      const { appendFile } = await import("node:fs/promises");
      await appendFile(session.logPath, JSON.stringify(inboundEntry1) + "\n", "utf-8");
      await appendFile(session.logPath, JSON.stringify(inboundEntry2) + "\n", "utf-8");

      const recoveredManager = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      await recoveredManager.recover();
      const recovered = recoveredManager.get(session.id);

      assert.ok(recovered, "should have recovered session");
      // Verify that both timestamps come from the file (they should be the old baseTime values)
      assert.equal(recovered.state.createdAt, firstTimestamp, "createdAt should match first timestamp");
      assert.equal(recovered.state.lastActivityAt, lastTimestamp, "lastActivityAt should match last timestamp");
    });

    it("skips archived files matching {id}.{timestamp}.jsonl pattern", async () => {
      const session1 = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");
      const session2 = await sessionManager.getOrCreate("discord", "chat-456", "user-789");

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

      await sessionManager.appendToLog(session1.id, inboundEntry);
      await sessionManager.close(session1.id); // Archives the file

      const inboundEntry2: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-2",
          adapterId: "discord",
          channelId: "chat-456",
          senderId: "user-789",
          text: "Hi",
          timestamp: Date.now(),
        },
      };

      await sessionManager.appendToLog(session2.id, inboundEntry2);

      // Create a fresh manager to test recovery
      const recoveredManager = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      const count = await recoveredManager.recover();

      // Should only recover session2, not the archived session1
      assert.equal(count, 1, "should only recover non-archived sessions");
      assert.ok(recoveredManager.get(session2.id), "should recover session2");
      assert.ok(!recoveredManager.get(session1.id), "should not recover archived session1");
    });

    it("skips files with no inbound entries", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const { appendFile } = await import("node:fs/promises");
      // Manually append only an outbound entry (no inbound)
      const outboundEntry = JSON.stringify({
        type: "outbound",
        message: {
          channelId: "chat-123",
          text: "Response without prior inbound",
        },
      });
      await appendFile(session.logPath, outboundEntry + "\n", "utf-8");

      const recoveredManager = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      const count = await recoveredManager.recover();

      assert.equal(count, 0, "should not recover session without inbound entry");
    });

    it("logs session:recover with success:false for files without inbound entries", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const { appendFile } = await import("node:fs/promises");
      const outboundEntry = JSON.stringify({
        type: "outbound",
        message: {
          channelId: "chat-123",
          text: "Response",
        },
      });
      await appendFile(session.logPath, outboundEntry + "\n", "utf-8");

      const mockLoggerForRecovery = new MockLogger();
      const recoveredManagerWithMockLogger2 = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: mockLoggerForRecovery as unknown as StructuredLogger,
      });

      await recoveredManagerWithMockLogger2.recover();

      const failLog = mockLoggerForRecovery.logs.find(
        (l) => l.eventType === "session:recover" && l.sessionId === session.id,
      );

      assert.ok(failLog, "should log session:recover event");
      assert.equal(failLog.payload.success, false, "should have success:false");
      assert.equal(failLog.payload.reason, "no_inbound_entry");
    });

    it("skips files that contain only malformed JSON lines", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const { writeFile } = await import("node:fs/promises");
      await writeFile(session.logPath, "not valid json\ninvalid{line}\n", "utf-8");

      const malformedRecoveryManager = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      const count = await malformedRecoveryManager.recover();

      assert.equal(count, 0, "should not recover session with only malformed lines");
    });

    it("skips empty files", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const { writeFile } = await import("node:fs/promises");
      await writeFile(session.logPath, "", "utf-8");

      const recoveredManager = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      const count = await recoveredManager.recover();

      assert.equal(count, 0, "should not recover empty file");
    });

    it("returns 0 when sessions directory is empty", async () => {
      const emptyManager = new SessionManager({
        sessionsDirectory: join(tempDir, "empty-sessions"),
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      const count = await emptyManager.recover();

      assert.equal(count, 0, "should return 0 for empty directory");
    });

    it("returns 0 when sessions directory does not exist", async () => {
      const nonexistentManager = new SessionManager({
        sessionsDirectory: join(tempDir, "nonexistent"),
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      const count = await nonexistentManager.recover();

      assert.equal(count, 0, "should return 0 for nonexistent directory");
    });

    it("does not overwrite sessions already in memory", async () => {
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

      // The session is already in sessionManager
      const originalState = session.state;

      await sessionManager.recover();

      // Session should still be the same object with original state
      assert.strictEqual(sessionManager.get(session.id), session, "session object should not be replaced");
      assert.strictEqual(sessionManager.get(session.id)?.state, originalState, "state should not be replaced");
    });

    it("allows list() to include recovered sessions", async () => {
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

      const recoveredManager = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      await recoveredManager.recover();
      const list = recoveredManager.list();

      assert.equal(list.length, 1, "list should contain recovered session");
      assert.equal(list[0]?.id, session.id);
    });

    it("allows getHistory() to work for recovered sessions", async () => {
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

      const recoveredManager = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      await recoveredManager.recover();
      const history = await recoveredManager.getHistory(session.id);

      assert.equal(history.length, 2, "should have 2 messages");
      assert.equal(history[0]?.role, "user");
      assert.equal(history[0]?.content, "Hello from user");
      assert.equal(history[1]?.role, "assistant");
      assert.equal(history[1]?.content, "Hello from assistant");
    });

    it("logs session:recover with success:true for each recovered session", async () => {
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

      const mockLoggerForRecovery = new MockLogger();
      const recoveredManager = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: mockLoggerForRecovery as unknown as StructuredLogger,
      });

      await recoveredManager.recover();

      const successLog = mockLoggerForRecovery.logs.find(
        (l) => l.eventType === "session:recover" && l.payload.success === true,
      );

      assert.ok(successLog, "should log session:recover with success:true");
      assert.equal(successLog.sessionId, session.id);
      assert.equal(successLog.payload.adapterId, "telegram");
      assert.equal(successLog.payload.channelId, "chat-123");
      assert.equal(successLog.payload.senderId, "user-456");
    });

    it("recovers multiple sessions from directory", async () => {
      const session1 = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");
      const session2 = await sessionManager.getOrCreate("discord", "chat-456", "user-789");

      const inboundEntry1: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "Message 1",
          timestamp: Date.now(),
        },
      };

      const inboundEntry2: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-2",
          adapterId: "discord",
          channelId: "chat-456",
          senderId: "user-789",
          text: "Message 2",
          timestamp: Date.now(),
        },
      };

      await sessionManager.appendToLog(session1.id, inboundEntry1);
      await sessionManager.appendToLog(session2.id, inboundEntry2);

      const recoveredManager = new SessionManager({
        sessionsDirectory: sessionManager["sessionsDirectory"],
        idleTimeoutMs: 5000,
        logger: logger as unknown as StructuredLogger,
      });

      const count = await recoveredManager.recover();

      assert.equal(count, 2, "should recover 2 sessions");
      assert.ok(recoveredManager.get(session1.id), "should recover session1");
      assert.ok(recoveredManager.get(session2.id), "should recover session2");
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

  describe("getHistory() — compaction entries", () => {
    it("prepends synthetic user summary message when compaction entry is present", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const compactionEntry = {
        type: "compaction" as const,
        summary: "User asked about Python, assistant explained loops",
        compressedTurnCount: 4,
        createdAt: Date.now(),
      };

      const inboundEntry: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "What about recursion?",
          timestamp: Date.now(),
        },
      };

      const { appendFile } = await import("node:fs/promises");
      await appendFile(session.logPath, JSON.stringify(compactionEntry) + "\n", "utf-8");
      await sessionManager.appendToLog(session.id, inboundEntry);

      const history = await sessionManager.getHistory(session.id);

      assert.ok(history.length >= 2, "should have compaction summary + inbound message");
      assert.equal(history[0]?.role, "user");
      assert.ok(
        history[0]?.content.includes("[Conversation summary:"),
        "first message should be summary",
      );
      assert.ok(
        history[0]?.content.includes("User asked about Python"),
        "summary should contain original text",
      );
      assert.equal(history[1]?.content, "What about recursion?");
    });

    it("uses only the last compaction entry when multiple compaction entries exist", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const { appendFile } = await import("node:fs/promises");
      await appendFile(
        session.logPath,
        JSON.stringify({
          type: "compaction",
          summary: "First summary",
          compressedTurnCount: 2,
          createdAt: Date.now(),
        }) + "\n",
        "utf-8",
      );

      await appendFile(
        session.logPath,
        JSON.stringify({
          type: "compaction",
          summary: "Second summary",
          compressedTurnCount: 3,
          createdAt: Date.now() + 1000,
        }) + "\n",
        "utf-8",
      );

      const history = await sessionManager.getHistory(session.id);

      assert.equal(history.length, 1, "should have one summary message");
      assert.ok(history[0]?.content.includes("Second summary"));
    });

    it("formats summary message as [Conversation summary: <text>]", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const summaryText = "Important facts from conversation";
      const compactionEntry = {
        type: "compaction" as const,
        summary: summaryText,
        compressedTurnCount: 5,
        createdAt: Date.now(),
      };

      const { appendFile } = await import("node:fs/promises");
      await appendFile(session.logPath, JSON.stringify(compactionEntry) + "\n", "utf-8");

      const history = await sessionManager.getHistory(session.id);

      assert.ok(history.length >= 1);
      assert.equal(
        history[0]?.content,
        `[Conversation summary: ${summaryText}]`,
        "format should match exactly",
      );
    });

    it("includes post-compaction messages after summary", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const { appendFile } = await import("node:fs/promises");
      await appendFile(
        session.logPath,
        JSON.stringify({
          type: "compaction",
          summary: "Summarised history",
          compressedTurnCount: 4,
          createdAt: Date.now(),
        }) + "\n",
        "utf-8",
      );

      const userMsg: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "User message",
          timestamp: Date.now(),
        },
      };

      const assistantMsg: SessionLogEntry = {
        type: "outbound",
        message: {
          channelId: "chat-123",
          text: "Assistant message",
        },
      };

      await sessionManager.appendToLog(session.id, userMsg);
      await sessionManager.appendToLog(session.id, assistantMsg);

      const history = await sessionManager.getHistory(session.id);

      assert.equal(history.length, 3);
      assert.ok(history[0]?.content.includes("[Conversation summary:"));
      assert.equal(history[1]?.role, "user");
      assert.equal(history[1]?.content, "User message");
      assert.equal(history[2]?.role, "assistant");
      assert.equal(history[2]?.content, "Assistant message");
    });

    it("returns only summary message when log has only compaction entry with no post-compaction messages", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const { appendFile } = await import("node:fs/promises");
      await appendFile(
        session.logPath,
        JSON.stringify({
          type: "compaction",
          summary: "Entire conversation summary",
          compressedTurnCount: 10,
          createdAt: Date.now(),
        }) + "\n",
        "utf-8",
      );

      const history = await sessionManager.getHistory(session.id);

      assert.equal(history.length, 1);
      assert.ok(history[0]?.content.includes("[Conversation summary:"));
      assert.ok(history[0]?.content.includes("Entire conversation summary"));
    });

    it("returns messages as before when log has no compaction entries", async () => {
      const session = await sessionManager.getOrCreate("telegram", "chat-123", "user-456");

      const userEntry: SessionLogEntry = {
        type: "inbound",
        message: {
          id: "msg-1",
          adapterId: "telegram",
          channelId: "chat-123",
          senderId: "user-456",
          text: "User message",
          timestamp: Date.now(),
        },
      };

      const assistantEntry: SessionLogEntry = {
        type: "outbound",
        message: {
          channelId: "chat-123",
          text: "Assistant message",
        },
      };

      await sessionManager.appendToLog(session.id, userEntry);
      await sessionManager.appendToLog(session.id, assistantEntry);

      const history = await sessionManager.getHistory(session.id);

      assert.equal(history.length, 2);
      assert.equal(history[0]?.role, "user");
      assert.equal(history[0]?.content, "User message");
      assert.equal(history[1]?.role, "assistant");
      assert.equal(history[1]?.content, "Assistant message");
      // Should not have synthetic summary message
      assert.ok(!history.some((m) => m.content.includes("[Conversation summary:")));
    });
  });
});
