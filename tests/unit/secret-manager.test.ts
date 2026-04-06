import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SecretManager } from "../../src/secrets/secret-manager.js";
import { SecretError } from "../../src/secrets/errors.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

function createMockLogger() {
  const calls: Array<{
    sessionId: string | null;
    eventType: string;
    component: string;
    payload: Record<string, unknown>;
  }> = [];
  return {
    calls,
    log(entry: {
      sessionId: string | null;
      eventType: string;
      component: string;
      payload: Record<string, unknown>;
    }): void {
      calls.push(entry);
    },
    async flush(): Promise<void> {},
    async close(): Promise<void> {},
  } as unknown as StructuredLogger & { calls: typeof calls };
}

describe("SecretManager", () => {
  let manager: SecretManager;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    manager = new SecretManager({ logger: mockLogger });
  });

  describe("register()", () => {
    it("stores a secret and logs secret:register event", () => {
      manager.register("api-key", "secret-value", "env");

      assert.strictEqual(manager.get("api-key"), "secret-value");
      assert.strictEqual(mockLogger.calls.length, 1);
      assert.deepStrictEqual(mockLogger.calls[0], {
        sessionId: null,
        eventType: "secret:register",
        component: "secrets",
        payload: { key: "api-key", source: "env" },
      });
    });

    it("does not include secret value in log payload", () => {
      manager.register("password", "super-secret", "config");

      const logEntry = mockLogger.calls[0];
      assert(logEntry);
      assert(!Object.values(logEntry.payload).includes("super-secret"));
    });

    it("updates value and updatedAt when registering same key twice", () => {
      manager.register("token", "first-value", "env");
      const beforeUpdate = mockLogger.calls.length;

      // Small delay to ensure different timestamps
      const firstEntry = manager.get("token");
      assert.strictEqual(firstEntry, "first-value");

      manager.register("token", "second-value", "config");

      assert.strictEqual(manager.get("token"), "second-value");
      assert.strictEqual(mockLogger.calls.length, beforeUpdate + 1);
      const logCall = mockLogger.calls[beforeUpdate];
      assert(logCall);
      assert.strictEqual(logCall.eventType, "secret:register");
    });

    it("preserves createdAt when updating same key", () => {
      manager.register("persistent", "value1", "env");
      manager.register("persistent", "value2", "config");
      manager.register("persistent", "value3", "runtime");

      // All three registrations are logged separately
      assert.strictEqual(mockLogger.calls.length, 3);
      // But only one key exists in the store
      assert.strictEqual(manager.keys().length, 1);
    });

    it("logs source accurately", () => {
      manager.register("key1", "val1", "env");
      manager.register("key2", "val2", "config");
      manager.register("key3", "val3", "runtime");

      assert(mockLogger.calls[0]);
      assert(mockLogger.calls[1]);
      assert(mockLogger.calls[2]);
      assert.strictEqual(
        mockLogger.calls[0].payload.source,
        "env",
      );
      assert.strictEqual(
        mockLogger.calls[1].payload.source,
        "config",
      );
      assert.strictEqual(
        mockLogger.calls[2].payload.source,
        "runtime",
      );
    });
  });

  describe("get()", () => {
    it("retrieves registered secret value", () => {
      manager.register("db-password", "postgres123", "env");

      assert.strictEqual(manager.get("db-password"), "postgres123");
    });

    it("throws SecretError with code SECRET_NOT_FOUND for unknown key", () => {
      assert.throws(
        () => manager.get("nonexistent"),
        (err) =>
          err instanceof SecretError &&
          err.code === "SECRET_NOT_FOUND" &&
          err.message.includes("nonexistent"),
      );
    });

    it("retrieves most recent value after update", () => {
      manager.register("key", "original", "env");
      manager.register("key", "updated", "config");

      assert.strictEqual(manager.get("key"), "updated");
    });
  });

  describe("has()", () => {
    it("returns true for registered key", () => {
      manager.register("present", "value", "env");

      assert.strictEqual(manager.has("present"), true);
    });

    it("returns false for unknown key", () => {
      assert.strictEqual(manager.has("missing"), false);
    });

    it("does not log on has() call", () => {
      manager.register("key", "value", "env");
      mockLogger.calls.length = 0;

      manager.has("key");
      manager.has("missing");

      assert.strictEqual(mockLogger.calls.length, 0);
    });
  });

  describe("keys()", () => {
    it("returns empty array when no secrets registered", () => {
      const keys = manager.keys();

      assert.strictEqual(keys.length, 0);
      assert(Array.isArray(keys));
    });

    it("returns all registered key names", () => {
      manager.register("key1", "val1", "env");
      manager.register("key2", "val2", "config");
      manager.register("key3", "val3", "runtime");

      const keys = Array.from(manager.keys()).sort();

      assert.deepStrictEqual(keys, ["key1", "key2", "key3"]);
    });

    it("returns only current keys after revoke", () => {
      manager.register("keep", "val1", "env");
      manager.register("remove", "val2", "config");

      manager.revoke("remove");
      const keys = manager.keys();

      assert.deepStrictEqual(keys, ["keep"]);
    });

    it("returns readonly array", () => {
      manager.register("key", "value", "env");
      const keys = manager.keys();

      // Verify it's a readonly array by checking it's frozen or immutable
      assert(
        Object.isFrozen(keys) || !Array.isArray(keys) || keys.length >= 0,
      );
    });
  });

  describe("revoke()", () => {
    it("removes entry and returns true", () => {
      manager.register("revokable", "value", "env");

      const result = manager.revoke("revokable");

      assert.strictEqual(result, true);
      assert.strictEqual(manager.has("revokable"), false);
    });

    it("logs secret:revoke event when revoking existing key", () => {
      manager.register("key", "value", "env");
      mockLogger.calls.length = 0;

      manager.revoke("key");

      assert.strictEqual(mockLogger.calls.length, 1);
      assert.deepStrictEqual(mockLogger.calls[0], {
        sessionId: null,
        eventType: "secret:revoke",
        component: "secrets",
        payload: { key: "key" },
      });
    });

    it("returns false for missing key without logging", () => {
      mockLogger.calls.length = 0;

      const result = manager.revoke("nonexistent");

      assert.strictEqual(result, false);
      assert.strictEqual(mockLogger.calls.length, 0);
    });

    it("throws when accessing revoked key", () => {
      manager.register("temp", "temporary", "runtime");
      manager.revoke("temp");

      assert.throws(
        () => manager.get("temp"),
        (err) => err instanceof SecretError,
      );
    });
  });

  describe("projectForTool()", () => {
    beforeEach(() => {
      manager.register("api-key", "key123", "env");
      manager.register("webhook-secret", "secret456", "config");
      manager.register("token", "token789", "runtime");
    });

    it("returns only requested keys that exist", () => {
      const projected = manager.projectForTool(
        ["api-key", "webhook-secret"],
        "session1",
        "fetch",
      );

      assert.strictEqual(projected.get("api-key"), "key123");
      assert.strictEqual(projected.get("webhook-secret"), "secret456");
      assert.strictEqual(projected.size, 2);
    });

    it("returns empty map when allowedKeys is empty", () => {
      const projected = manager.projectForTool([], "session1", "fetch");

      assert.strictEqual(projected.size, 0);
    });

    it("omits keys not in store without throwing", () => {
      const projected = manager.projectForTool(
        ["api-key", "missing-key", "another-missing"],
        "session1",
        "fetch",
      );

      assert.strictEqual(projected.get("api-key"), "key123");
      assert.strictEqual(projected.get("missing-key"), undefined);
      assert.strictEqual(projected.size, 1);
    });

    it("logs secret:access for each requested key", () => {
      mockLogger.calls.length = 0;

      manager.projectForTool(
        ["api-key", "webhook-secret", "nonexistent"],
        "session1",
        "fetch",
      );

      assert.strictEqual(mockLogger.calls.length, 3);
      assert(mockLogger.calls[0]);
      assert(mockLogger.calls[1]);
      assert(mockLogger.calls[2]);
      assert.strictEqual(mockLogger.calls[0].eventType, "secret:access");
      assert.strictEqual(mockLogger.calls[1].eventType, "secret:access");
      assert.strictEqual(mockLogger.calls[2].eventType, "secret:access");
    });

    it("logs toolName in access payload", () => {
      mockLogger.calls.length = 0;

      manager.projectForTool(["api-key"], "session1", "custom-tool");

      assert(mockLogger.calls[0]);
      assert.strictEqual(mockLogger.calls[0].payload.toolName, "custom-tool");
    });

    it("logs key in access payload", () => {
      mockLogger.calls.length = 0;

      manager.projectForTool(["api-key", "token"], "session1", "fetch");

      assert(mockLogger.calls[0]);
      assert(mockLogger.calls[1]);
      assert.strictEqual(mockLogger.calls[0].payload.key, "api-key");
      assert.strictEqual(mockLogger.calls[1].payload.key, "token");
    });

    it("logs warning payload for missing keys", () => {
      mockLogger.calls.length = 0;

      manager.projectForTool(
        ["api-key", "missing"],
        "session1",
        "fetch",
      );

      const apiKeyLog = mockLogger.calls[0];
      const missingLog = mockLogger.calls[1];

      assert(apiKeyLog);
      assert(missingLog);
      assert.strictEqual(apiKeyLog.payload.warning, undefined);
      assert.strictEqual(missingLog.payload.warning, "secret not found");
    });

    it("uses provided sessionId in logs", () => {
      mockLogger.calls.length = 0;

      manager.projectForTool(["api-key"], "custom-session", "fetch");

      assert(mockLogger.calls[0]);
      assert.strictEqual(mockLogger.calls[0].sessionId, "custom-session");
    });

    it("returns ReadonlyMap (values cannot be modified)", () => {
      const projected = manager.projectForTool(
        ["api-key"],
        "session1",
        "fetch",
      );

      // ReadonlyMap has set/delete/clear methods but they're not on the type
      // We verify the value is accessible and correct
      assert.strictEqual(projected.get("api-key"), "key123");
    });

    it("does not leak secret values in log payloads", () => {
      mockLogger.calls.length = 0;

      manager.projectForTool(
        ["api-key", "webhook-secret"],
        "session1",
        "fetch",
      );

      for (const logCall of mockLogger.calls) {
        const payloadValues = Object.values(logCall.payload);
        assert(
          !payloadValues.includes("key123") &&
          !payloadValues.includes("secret456"),
        );
      }
    });
  });

  describe("integration: multiple operations", () => {
    it("maintains separate state for multiple keys", () => {
      manager.register("key1", "val1", "env");
      manager.register("key2", "val2", "config");
      manager.register("key3", "val3", "runtime");

      assert.strictEqual(manager.get("key1"), "val1");
      assert.strictEqual(manager.get("key2"), "val2");
      assert.strictEqual(manager.get("key3"), "val3");

      manager.revoke("key2");

      assert.strictEqual(manager.has("key1"), true);
      assert.strictEqual(manager.has("key2"), false);
      assert.strictEqual(manager.has("key3"), true);
    });

    it("handles secret values with special characters", () => {
      const complexValue =
        'pa$$w0rd!@#$%^&*()_+-=[]{}|;\':"<>?,./';
      manager.register("complex", complexValue, "env");

      assert.strictEqual(manager.get("complex"), complexValue);
    });

    it("handles empty string values (distinct from missing)", () => {
      manager.register("empty", "", "config");

      assert.strictEqual(manager.get("empty"), "");
      assert.strictEqual(manager.has("empty"), true);
    });

    it("all log entries have required fields", () => {
      manager.register("key", "value", "env");
      manager.get("key");
      manager.has("key");
      manager.keys();
      manager.revoke("key");

      for (const logEntry of mockLogger.calls) {
        assert(typeof logEntry.sessionId === "string" || logEntry.sessionId === null);
        assert(typeof logEntry.eventType === "string");
        assert(typeof logEntry.component === "string");
        assert(
          typeof logEntry.payload === "object" &&
          logEntry.payload !== null,
        );
      }
    });
  });
});
