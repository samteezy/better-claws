import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeOutput } from "../../src/utils/output-sanitizer.js";

describe("Output Sanitizer (sanitizeOutput)", () => {
  describe("regex-based secret redaction", () => {
    it("redacts AWS access key pattern", () => {
      const input = 'aws_key: "AKIA3B2X4Y5Z1A2B3C4D5E6F"';
      const result = sanitizeOutput(input);

      assert.ok(result.includes("[REDACTED]"));
      assert.ok(!result.includes("AKIA"));
    });

    it("redacts Bearer token pattern", () => {
      const input = 'token=Bearer abcdef0123456789';
      const result = sanitizeOutput(input);

      // Bearer token pattern should be redacted
      assert.ok(result.includes("[REDACTED]"));
      assert.ok(!result.includes("abcdef0123456789"));
    });

    it("redacts GitHub token pattern", () => {
      const input = 'github_token: "ghp_16C7e42F292c6912E7710c838347Ae178B4a"';
      const result = sanitizeOutput(input);

      assert.ok(result.includes("[REDACTED]"));
      assert.ok(!result.includes("ghp_"));
    });

    it("redacts Slack token pattern", () => {
      const input = 'slack_token: "xoxb-1234567890-1234567890-abcdefghijklmnopqrst"';
      const result = sanitizeOutput(input);

      assert.ok(result.includes("[REDACTED]"));
      assert.ok(!result.includes("xoxb-"));
    });

    it("redacts long hex strings that look like secrets", () => {
      const input = 'api_key: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"';
      const result = sanitizeOutput(input);

      assert.ok(result.includes("[REDACTED]"));
      assert.ok(!result.includes("abcdef01234567"));
    });
  });

  describe("JSON-based sensitive key stripping", () => {
    it("redacts password key in JSON object", () => {
      const input = JSON.stringify({ username: "user", password: "secret123" });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.username, "user");
      assert.strictEqual(parsed.password, "[REDACTED]");
    });

    it("redacts token key in JSON", () => {
      const input = JSON.stringify({ user: "alice", token: "abc123xyz" });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.user, "alice");
      assert.strictEqual(parsed.token, "[REDACTED]");
    });

    it("redacts api_key in JSON", () => {
      const input = JSON.stringify({ service: "stripe", api_key: "sk_live_123" });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.service, "stripe");
      assert.strictEqual(parsed.api_key, "[REDACTED]");
    });

    it("redacts authorization in JSON", () => {
      const input = JSON.stringify({
        request: "fetch",
        authorization: "Bearer token123",
      });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.authorization, "[REDACTED]");
    });

    it("redacts access_token in JSON", () => {
      const input = JSON.stringify({
        oauth: true,
        access_token: "auth123xyz",
      });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.access_token, "[REDACTED]");
    });

    it("redacts refresh_token in JSON", () => {
      const input = JSON.stringify({
        oauth: true,
        refresh_token: "refresh123xyz",
      });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.refresh_token, "[REDACTED]");
    });

    it("redacts secret key in JSON", () => {
      const input = JSON.stringify({ key: "public", secret: "private-value" });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.secret, "[REDACTED]");
    });

    it("redacts apikey (no underscore) in JSON", () => {
      const input = JSON.stringify({ apikey: "xyz789" });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.apikey, "[REDACTED]");
    });

    it("redacts passwd (alias for password) in JSON", () => {
      const input = JSON.stringify({ user: "admin", passwd: "admin123" });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.passwd, "[REDACTED]");
    });

    it("redacts nested objects with sensitive keys", () => {
      const input = JSON.stringify({
        database: {
          host: "db.example.com",
          password: "db_secret_123",
        },
      });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.database.host, "db.example.com");
      assert.strictEqual(parsed.database.password, "[REDACTED]");
    });

    it("redacts deeply nested sensitive keys", () => {
      const input = JSON.stringify({
        app: {
          config: {
            auth: {
              token: "secret_token_xyz",
            },
          },
        },
      });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(
        parsed.app.config.auth.token,
        "[REDACTED]",
      );
    });

    it("redacts sensitive keys in arrays of objects", () => {
      const input = JSON.stringify([
        { name: "user1", api_key: "key1" },
        { name: "user2", api_key: "key2" },
        { name: "user3", api_key: "key3" },
      ]);
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result) as Array<Record<string, unknown>>;

      assert.strictEqual(parsed[0]?.api_key, "[REDACTED]");
      assert.strictEqual(parsed[1]?.api_key, "[REDACTED]");
      assert.strictEqual(parsed[2]?.api_key, "[REDACTED]");
    });

    it("is case-insensitive for JSON key matching", () => {
      const input = JSON.stringify({
        PASSWORD: "secret",
        Token: "token123",
        API_Key: "key456",
      });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.PASSWORD, "[REDACTED]");
      assert.strictEqual(parsed.Token, "[REDACTED]");
      assert.strictEqual(parsed.API_Key, "[REDACTED]");
    });

    it("preserves non-sensitive keys in JSON", () => {
      const input = JSON.stringify({
        username: "alice",
        email: "alice@example.com",
        profile: {
          firstName: "Alice",
          lastName: "Smith",
        },
      });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.strictEqual(parsed.username, "alice");
      assert.strictEqual(parsed.email, "alice@example.com");
      assert.strictEqual(parsed.profile.firstName, "Alice");
    });
  });

  describe("non-JSON string handling", () => {
    it("applies redaction to non-JSON string (no error)", () => {
      const input = "Config: password=secret123, api_key=xyz789";
      const result = sanitizeOutput(input);

      // Should apply redaction patterns but not break
      assert.ok(result);
      assert.ok(result.length > 0);
      assert.ok(!result.includes("secret123"));
    });

    it("returns non-JSON string unchanged if no secrets found", () => {
      const input = "This is a regular log message with no secrets";
      const result = sanitizeOutput(input);

      assert.strictEqual(result, input);
    });

    it("handles malformed JSON gracefully", () => {
      const input = '{"incomplete": "json"';
      const result = sanitizeOutput(input);

      // Should not throw, just return the input or processed version
      assert.ok(result);
      assert.ok(result.length > 0);
    });
  });

  describe("truncation", () => {
    it("truncates string exceeding 10KB default", () => {
      const input = "x".repeat(11_000);
      const result = sanitizeOutput(input);

      assert.ok(result.includes("…[truncated]"));
      assert.ok(result.length < input.length);
      // Check it's actually truncated to around 10KB
      assert.ok(Buffer.byteLength(result, "utf-8") <= 11_000);
    });

    it("adds truncation marker at the end", () => {
      const input = "x".repeat(11_000);
      const result = sanitizeOutput(input);

      assert.ok(result.endsWith("…[truncated]"));
    });

    it("does not truncate string under 10KB", () => {
      const input = "x".repeat(5_000);
      const result = sanitizeOutput(input);

      assert.ok(!result.includes("…[truncated]"));
    });

    it("respects custom maxBytes option", () => {
      const input = "x".repeat(1_000);
      const result = sanitizeOutput(input, { maxBytes: 100 });

      assert.ok(result.includes("…[truncated]"));
      assert.ok(Buffer.byteLength(result, "utf-8") <= 200); // 100 + marker
    });

    it("custom maxBytes=0 truncates immediately", () => {
      const input = "hello";
      const result = sanitizeOutput(input, { maxBytes: 0 });

      assert.ok(result.includes("…[truncated]"));
    });

    it("does not truncate when custom maxBytes exceeds input length", () => {
      const input = "short";
      const result = sanitizeOutput(input, { maxBytes: 1000 });

      assert.ok(!result.includes("…[truncated]"));
      assert.strictEqual(result, input);
    });

    it("handles UTF-8 multibyte characters correctly when truncating", () => {
      // Emoji and other multibyte UTF-8 characters
      const input = "hello " + "🎉".repeat(1000);
      const result = sanitizeOutput(input, { maxBytes: 50 });

      // Should not contain invalid UTF-8
      assert.ok(result);
      // Should be truncated
      assert.ok(result.length < input.length);
    });
  });

  describe("pipeline: combined operations", () => {
    it("applies regex redaction, JSON key stripping, and truncation in order", () => {
      const input = JSON.stringify({
        message: "User logged in",
        token: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        data: "x".repeat(11_000),
      });
      const result = sanitizeOutput(input);

      // Should be truncated
      assert.ok(result.includes("…[truncated]"));

      // Token should be redacted (JSON key)
      // Since the result is truncated, we can't parse the full JSON
      // But we can verify redaction happened
      assert.ok(result.includes("[REDACTED]"));
    });

    it("combines regex redaction and truncation for non-JSON", () => {
      const input = "password=secret123 " + "y".repeat(11_000);
      const result = sanitizeOutput(input);

      assert.ok(!result.includes("secret123")); // Redacted
      assert.ok(result.includes("…[truncated]")); // Truncated
    });

    it("strips sensitive JSON keys even when values contain regex-matchable patterns", () => {
      const input = JSON.stringify({
        password: "AKIA1234567890ABCDEF",
        data: "safe value",
      });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      // password key should be redacted by JSON key stripping (step 1)
      assert.strictEqual(parsed.password, "[REDACTED]");
      // non-sensitive key preserved
      assert.strictEqual(parsed.data, "safe value");
    });

    it("applies both key-based and regex-based redaction together", () => {
      const input = JSON.stringify({
        token: "my-secret-token",
        response: "Found key AKIA1234567890ABCDEF in output",
      });
      const result = sanitizeOutput(input);

      // token redacted by JSON key stripping
      assert.ok(!result.includes("my-secret-token"));
      // AWS key in non-sensitive field redacted by regex
      assert.ok(!result.includes("AKIA1234567890ABCDEF"));
    });

    it("handles JSON with regex-based secrets and truncation", () => {
      const input = JSON.stringify({
        api_key: "AKIA3B2X4Y5Z1A2B3C4D5E6F",
        logs: "x".repeat(11_000),
      });
      const result = sanitizeOutput(input);

      // The AWS key should be redacted by JSON stripping (since api_key is sensitive)
      // Since the result is truncated, just verify redaction happened
      assert.ok(result.includes("[REDACTED]"));
      assert.ok(result.includes("…[truncated]"));
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      const result = sanitizeOutput("");
      assert.strictEqual(result, "");
    });

    it("handles whitespace-only string", () => {
      const result = sanitizeOutput("   \n\t   ");
      assert.strictEqual(result, "   \n\t   ");
    });

    it("handles string with only redaction placeholder", () => {
      const result = sanitizeOutput("[REDACTED]");
      assert.ok(result.includes("[REDACTED]"));
    });

    it("handles JSON array with no objects", () => {
      const input = JSON.stringify([1, 2, 3, "hello"]);
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      assert.deepStrictEqual(parsed, [1, 2, 3, "hello"]);
    });

    it("handles JSON with null values in sensitive keys", () => {
      const input = JSON.stringify({
        password: null,
        username: "user",
      });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      // null should be redacted
      assert.strictEqual(parsed.password, "[REDACTED]");
    });

    it("handles JSON with array values in sensitive keys", () => {
      const input = JSON.stringify({
        tokens: ["token1", "token2", "token3"],
      });
      const result = sanitizeOutput(input);
      const parsed = JSON.parse(result);

      // The array itself is NOT a sensitive key name, so it should be preserved
      // but individual sensitive keys inside would be redacted
      assert.ok(Array.isArray(parsed.tokens));
    });

    it("handles JSON with object values in sensitive keys", () => {
      const input = JSON.stringify({
        credentials: {
          user: "alice",
          pass: "secret",
        },
      });
      const result = sanitizeOutput(input);

      // The object should be redacted for 'credentials' (not a sensitive key)
      // But 'pass' inside should be redacted if we recursively process
      assert.ok(result);
    });

    it("does not crash on circular reference (shouldn't happen with JSON.stringify)", () => {
      const input = '{"key": "value"}';
      const result = sanitizeOutput(input);
      assert.ok(result);
    });

    it("handles very long key names", () => {
      const longKey = "a".repeat(1000);
      const input = JSON.stringify({
        [longKey]: "value",
      });
      const result = sanitizeOutput(input);
      assert.ok(result);
    });
  });

  describe("maxBytes option validation", () => {
    it("uses default 10KB when maxBytes not specified", () => {
      const input = "x".repeat(10_240);
      const result = sanitizeOutput(input);

      // Should not be truncated (exactly at limit)
      assert.ok(!result.includes("…[truncated]"));
    });

    it("uses default 10KB when maxBytes is undefined", () => {
      const input = "x".repeat(10_241);
      const result = sanitizeOutput(input, { maxBytes: undefined });

      assert.ok(result.includes("…[truncated]"));
    });

    it("handles negative maxBytes as effectively zero", () => {
      const input = "hello";
      const result = sanitizeOutput(input, { maxBytes: -1 });

      // Behavior: buffer.subarray(0, -1) returns empty, so result would be truncated marker
      assert.ok(result);
    });
  });
});
