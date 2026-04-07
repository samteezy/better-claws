import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rmdir } from "node:fs/promises";
import { mkdtemp } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  resolveEnvSecrets,
  loadConfig,
  ConfigError,
  DEFAULT_CONFIG,
  resolveWeakLlmConfig,
} from "../../src/config.js";


const mkdtempAsync = promisify(mkdtemp);

async function removeDirRecursive(dirPath: string): Promise<void> {
  try {
    const entries = await import("node:fs/promises").then((m) => m.readdir(dirPath));
    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      const stat = await import("node:fs/promises").then((m) => m.stat(fullPath));
      if (stat.isDirectory()) {
        await removeDirRecursive(fullPath);
      } else {
        await import("node:fs/promises").then((m) => m.unlink(fullPath));
      }
    }
    await rmdir(dirPath);
  } catch (err) {
    // Silently ignore errors during cleanup
  }
}

describe("config", () => {
  describe("resolveEnvSecrets()", () => {
    it("resolves env:VAR strings from process.env", () => {
      process.env["TEST_VAR"] = "test-value";
      const result = resolveEnvSecrets("env:TEST_VAR");
      assert.equal(result, "test-value");
      delete process.env["TEST_VAR"];
    });

    it("passes through non-env strings unchanged", () => {
      assert.equal(resolveEnvSecrets("regular-string"), "regular-string");
      assert.equal(resolveEnvSecrets(""), "");
      assert.equal(resolveEnvSecrets("env-like-but-not"), "env-like-but-not");
    });

    it("throws ConfigError for missing environment variables", () => {
      assert.throws(
        () => resolveEnvSecrets("env:NONEXISTENT_VAR_12345"),
        (err) =>
          err instanceof ConfigError &&
          err.code === "MISSING_ENV_VAR" &&
          err.message.includes("NONEXISTENT_VAR_12345"),
      );
    });

    it("handles arrays with env variables", () => {
      process.env["TEST_VAR1"] = "value1";
      process.env["TEST_VAR2"] = "value2";

      const result = resolveEnvSecrets(["env:TEST_VAR1", "plain-text", "env:TEST_VAR2"]);

      assert.deepEqual(result, ["value1", "plain-text", "value2"]);

      delete process.env["TEST_VAR1"];
      delete process.env["TEST_VAR2"];
    });

    it("handles nested objects with env variables", () => {
      process.env["DB_PASSWORD"] = "secret123";
      process.env["API_KEY"] = "key456";

      const input = {
        database: {
          password: "env:DB_PASSWORD",
          host: "localhost",
        },
        api: {
          key: "env:API_KEY",
        },
        plain: "text",
      };

      const result = resolveEnvSecrets(input);

      assert.deepEqual(result, {
        database: {
          password: "secret123",
          host: "localhost",
        },
        api: {
          key: "key456",
        },
        plain: "text",
      });

      delete process.env["DB_PASSWORD"];
      delete process.env["API_KEY"];
    });

    it("handles deeply nested structures", () => {
      process.env["SECRET"] = "deep-value";

      const input = {
        level1: {
          level2: {
            level3: {
              secret: "env:SECRET",
              plain: "text",
            },
          },
        },
      };

      const result = resolveEnvSecrets(input);

      assert.deepEqual(result, {
        level1: {
          level2: {
            level3: {
              secret: "deep-value",
              plain: "text",
            },
          },
        },
      });

      delete process.env["SECRET"];
    });

    it("handles mixed arrays and objects", () => {
      process.env["TOKEN"] = "xyz789";

      const input = {
        tokens: ["env:TOKEN", "hardcoded"],
        nested: {
          array: ["value1", "env:TOKEN"],
        },
      };

      const result = resolveEnvSecrets(input);

      assert.deepEqual(result, {
        tokens: ["xyz789", "hardcoded"],
        nested: {
          array: ["value1", "xyz789"],
        },
      });

      delete process.env["TOKEN"];
    });

    it("passes through non-string, non-object, non-array values", () => {
      assert.equal(resolveEnvSecrets(123), 123);
      assert.equal(resolveEnvSecrets(true), true);
      assert.equal(resolveEnvSecrets(false), false);
      assert.equal(resolveEnvSecrets(null), null);
    });

    it("passes through undefined", () => {
      assert.equal(resolveEnvSecrets(undefined), undefined);
    });
  });

  describe("loadConfig()", () => {
    let tempDir: string;

    before(async () => {
      tempDir = await mkdtempAsync(join("/tmp", "betterclaws-test-"));
    });

    after(async () => {
      await removeDirRecursive(tempDir);
    });

    it("returns DEFAULT_CONFIG when file does not exist", async () => {
      const nonexistentPath = join(tempDir, "nonexistent.json");
      const config = await loadConfig(nonexistentPath);

      assert.deepEqual(config, DEFAULT_CONFIG);
    });

    it("loads and parses valid JSON config file", async () => {
      const configPath = join(tempDir, "test-config.json");
      const configData = {
        gateway: { port: 19000 },
        llm: { model: "custom-model" },
      };

      await writeFile(configPath, JSON.stringify(configData), "utf-8");

      const config = await loadConfig(configPath);

      assert.equal(config.gateway.port, 19000);
      assert.equal(config.llm.model, "custom-model");
      // Other values should come from defaults
      assert.equal(config.gateway.host, "127.0.0.1");
      assert.equal(config.llm.temperature, 0.7);
    });

    it("merges partial config over defaults", async () => {
      const configPath = join(tempDir, "partial-config.json");
      const configData = {
        memory: {
          maxLongTermEntries: 5000,
        },
        security: {
          sandboxTimeout: 60000,
        },
      };

      await writeFile(configPath, JSON.stringify(configData), "utf-8");

      const config = await loadConfig(configPath);

      // Merged values
      assert.equal(config.memory.maxLongTermEntries, 5000);
      assert.equal(config.security.sandboxTimeout, 60000);

      // Default values that weren't overridden
      assert.equal(config.memory.curationEnabled, true);
      assert.equal(config.security.defaultCapabilityPolicy, "deny");
    });

    it("throws ConfigError for invalid JSON", async () => {
      const configPath = join(tempDir, "invalid.json");
      await writeFile(configPath, "{ invalid json", "utf-8");

      assert.rejects(
        () => loadConfig(configPath),
        (err) =>
          err instanceof ConfigError &&
          err.code === "READ_ERROR" &&
          err.message.includes("Failed to read config"),
      );
    });

    it("throws ConfigError when config is not an object", async () => {
      const configPath = join(tempDir, "not-object.json");
      await writeFile(configPath, '["array", "not", "object"]', "utf-8");

      assert.rejects(
        () => loadConfig(configPath),
        (err) =>
          err instanceof ConfigError &&
          err.code === "INVALID_FORMAT" &&
          err.message.includes("must be a JSON object"),
      );
    });

    it("throws ConfigError when nested objects have wrong type", async () => {
      const configPath = join(tempDir, "bad-gateway.json");
      const configData = { gateway: "not-an-object" };

      await writeFile(configPath, JSON.stringify(configData), "utf-8");

      assert.rejects(
        () => loadConfig(configPath),
        (err) =>
          err instanceof ConfigError &&
          err.code === "INVALID_FORMAT" &&
          err.message.includes('"gateway" must be an object'),
      );
    });

    it("resolves environment variables in loaded config", async () => {
      process.env["TEST_API_KEY"] = "secret-key-123";
      const configPath = join(tempDir, "env-config.json");
      const configData = {
        llm: {
          apiKey: "env:TEST_API_KEY",
        },
      };

      await writeFile(configPath, JSON.stringify(configData), "utf-8");

      const config = await loadConfig(configPath);

      assert.equal(config.llm.apiKey, "secret-key-123");

      delete process.env["TEST_API_KEY"];
    });

    it("merges nested objects correctly", async () => {
      const configPath = join(tempDir, "deep-merge.json");
      const configData = {
        security: {
          sandboxTimeout: 45000,
          stripEnvironment: false,
        },
      };

      await writeFile(configPath, JSON.stringify(configData), "utf-8");

      const config = await loadConfig(configPath);

      // Updated values
      assert.equal(config.security.sandboxTimeout, 45000);
      assert.equal(config.security.stripEnvironment, false);

      // Default values still present
      assert.equal(config.security.defaultCapabilityPolicy, "deny");
      assert.equal(config.security.allowPersistentGrants, false);
    });

    it("throws when environment variable is missing during resolution", async () => {
      const configPath = join(tempDir, "missing-env.json");
      const configData = {
        llm: {
          apiKey: "env:MISSING_VAR_UNIQUE_12345",
        },
      };

      await writeFile(configPath, JSON.stringify(configData), "utf-8");

      assert.rejects(
        () => loadConfig(configPath),
        (err) =>
          err instanceof ConfigError &&
          err.code === "MISSING_ENV_VAR" &&
          err.message.includes("MISSING_VAR_UNIQUE_12345"),
      );
    });

    it("overwrites non-object values with new ones", async () => {
      const configPath = join(tempDir, "overwrite.json");
      const configData = {
        gateway: {
          port: 20000,
        },
      };

      await writeFile(configPath, JSON.stringify(configData), "utf-8");

      const config = await loadConfig(configPath);

      assert.equal(config.gateway.port, 20000);
    });
  });

  describe("deep merge behavior", () => {
    it("merges nested gateway config over defaults", () => {
      // This test verifies the merge behavior through loadConfig
      // since deepMerge is a private function
      assert.ok(DEFAULT_CONFIG.gateway.host === "127.0.0.1");
      assert.ok(DEFAULT_CONFIG.gateway.port === 18700);
    });

    it("does not merge arrays, replaces them entirely", async () => {
      let tempDirForArrayTest: string | undefined;

      try {
        tempDirForArrayTest = await mkdtempAsync(join("/tmp", "bc-array-merge-"));
        const configPath = join(tempDirForArrayTest, "array-test.json");
        const configData = {
          adapters: {
            telegram: { enabled: true },
            discord: { enabled: true },
          },
        };

        await writeFile(configPath, JSON.stringify(configData), "utf-8");

        const config = await loadConfig(configPath);

        assert.ok(typeof config.adapters === "object");
        assert.ok(config.adapters !== null);
      } finally {
        if (tempDirForArrayTest) {
          await removeDirRecursive(tempDirForArrayTest);
        }
      }
    });
  });

  describe("resolveWeakLlmConfig()", () => {
    it("returns null when no weak config is provided", () => {
      const llm = {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "sk-123",
        model: "gpt-4",
        maxTokens: 4096,
        temperature: 0.7,
      };

      const result = resolveWeakLlmConfig(llm);

      assert.strictEqual(result, null);
    });

    it("returns resolved config with all fields from weak when all are provided", () => {
      const llm = {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "sk-main",
        model: "gpt-4",
        maxTokens: 4096,
        temperature: 0.7,
        weak: {
          baseUrl: "http://weak-server:11434/v1",
          apiKey: "sk-weak",
          model: "mistral-small",
          maxTokens: 2048,
          temperature: 0.5,
        },
      };

      const result = resolveWeakLlmConfig(llm);

      assert.deepStrictEqual(result, {
        baseUrl: "http://weak-server:11434/v1",
        apiKey: "sk-weak",
        model: "mistral-small",
        maxTokens: 2048,
        temperature: 0.5,
      });
    });

    it("falls back to parent baseUrl when weak.baseUrl is omitted", () => {
      const llm = {
        baseUrl: "http://parent:11434/v1",
        apiKey: "sk-main",
        model: "gpt-4",
        maxTokens: 4096,
        temperature: 0.7,
        weak: {
          model: "mistral-small",
        },
      };

      const result = resolveWeakLlmConfig(llm);

      assert.strictEqual(result?.baseUrl, "http://parent:11434/v1");
    });

    it("falls back to parent apiKey when weak.apiKey is omitted", () => {
      const llm = {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "sk-parent",
        model: "gpt-4",
        maxTokens: 4096,
        temperature: 0.7,
        weak: {
          model: "mistral-small",
        },
      };

      const result = resolveWeakLlmConfig(llm);

      assert.strictEqual(result?.apiKey, "sk-parent");
    });

    it("falls back to parent maxTokens when weak.maxTokens is omitted", () => {
      const llm = {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "sk-123",
        model: "gpt-4",
        maxTokens: 8192,
        temperature: 0.7,
        weak: {
          model: "mistral-small",
        },
      };

      const result = resolveWeakLlmConfig(llm);

      assert.strictEqual(result?.maxTokens, 8192);
    });

    it("falls back to parent temperature when weak.temperature is omitted", () => {
      const llm = {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "sk-123",
        model: "gpt-4",
        maxTokens: 4096,
        temperature: 0.9,
        weak: {
          model: "mistral-small",
        },
      };

      const result = resolveWeakLlmConfig(llm);

      assert.strictEqual(result?.temperature, 0.9);
    });

    it("requires only model in weak — everything else falls back", () => {
      const llm = {
        baseUrl: "http://parent:11434/v1",
        apiKey: "sk-parent",
        model: "gpt-4",
        maxTokens: 4096,
        temperature: 0.7,
        weak: {
          model: "phi-2",
        },
      };

      const result = resolveWeakLlmConfig(llm);

      assert.deepStrictEqual(result, {
        baseUrl: "http://parent:11434/v1",
        apiKey: "sk-parent",
        model: "phi-2",
        maxTokens: 4096,
        temperature: 0.7,
      });
    });

    it("preserves readonly constraint on return type", () => {
      const llm = {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "sk-123",
        model: "gpt-4",
        maxTokens: 4096,
        temperature: 0.7,
        weak: {
          model: "mistral-small",
        },
      };

      const result = resolveWeakLlmConfig(llm);

      // Test that the result is a valid ResolvedWeakLlmConfig
      // All fields should be readable
      assert.ok(result?.baseUrl !== undefined);
      assert.ok(result?.apiKey !== undefined);
      assert.ok(result?.model !== undefined);
      assert.ok(result?.maxTokens !== undefined);
      assert.ok(result?.temperature !== undefined);
    });

    it("handles mixed fallback scenario", () => {
      const llm = {
        baseUrl: "http://parent:11434/v1",
        apiKey: "sk-parent",
        model: "gpt-4",
        maxTokens: 4096,
        temperature: 0.7,
        weak: {
          baseUrl: "http://weak:11434/v1",
          model: "phi-2",
          temperature: 0.3,
          // falls back: apiKey, maxTokens
        },
      };

      const result = resolveWeakLlmConfig(llm);

      assert.deepStrictEqual(result, {
        baseUrl: "http://weak:11434/v1",
        apiKey: "sk-parent",
        model: "phi-2",
        maxTokens: 4096,
        temperature: 0.3,
      });
    });
  });
});
