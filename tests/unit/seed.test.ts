import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { seedFromConfig } from "../../src/secrets/seed.js";
import type { SecretManager } from "../../src/secrets/secret-manager.js";
import type { BetterClawsConfig } from "../../src/types.js";

function createMockSecretManager() {
  const registered: Array<{
    key: string;
    value: string;
    source: string;
  }> = [];
  return {
    registered,
    register(key: string, value: string, source: string): void {
      registered.push({ key, value, source });
    },
    // Other methods not needed for seed tests
  } as unknown as SecretManager & { registered: typeof registered };
}

function createMinimalConfig(overrides?: Partial<BetterClawsConfig>): BetterClawsConfig {
  return {
    gateway: { host: "localhost", port: 3000 },
    llm: { baseUrl: "http://localhost", apiKey: "", model: "gpt-4", maxTokens: 4096, temperature: 0.7 },
    adapters: {},
    security: { defaultCapabilityPolicy: "deny", sandboxTimeout: 5000, stripEnvironment: true, allowPersistentGrants: false },
    memory: { maxLongTermEntries: 1000, confidenceDecayRate: 0.01, staleThreshold: 86400000, curationIntervalMinutes: 60, curationEnabled: true },
    logging: { directory: "./logs", redactSensitive: true, retentionDays: 7 },
    ...overrides,
  };
}

describe("seedFromConfig()", () => {
  let manager: ReturnType<typeof createMockSecretManager>;

  beforeEach(() => {
    manager = createMockSecretManager();
  });

  describe("LLM API key", () => {
    it("seeds llm:apiKey from config.llm.apiKey", () => {
      const config = createMinimalConfig({
        llm: {
          baseUrl: "http://localhost",
          apiKey: "sk-12345",
          model: "gpt-4",
          maxTokens: 4096,
          temperature: 0.7,
        },
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 1);
      assert.deepStrictEqual(manager.registered[0], {
        key: "llm:apiKey",
        value: "sk-12345",
        source: "env",
      });
    });

    it("skips llm:apiKey when empty string", () => {
      const config = createMinimalConfig({
        llm: {
          baseUrl: "http://localhost",
          apiKey: "",
          model: "gpt-4",
          maxTokens: 4096,
          temperature: 0.7,
        },
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 0);
    });

    it("registers llm:apiKey with source as 'env'", () => {
      const config = createMinimalConfig({
        llm: {
          baseUrl: "http://localhost",
          apiKey: "test-key",
          model: "gpt-4",
          maxTokens: 4096,
          temperature: 0.7,
        },
      });

      seedFromConfig(manager, config);

      assert(manager.registered[0]);
      assert.strictEqual(manager.registered[0].source, "env");
    });
  });

  describe("Adapter tokens", () => {
    it("seeds adapter tokens from config.adapters", () => {
      const config = createMinimalConfig({
        adapters: {
          telegram: {
            enabled: true,
            token: "tg-token-123",
          },
          discord: {
            enabled: true,
            token: "discord-token-456",
          },
        },
      });

      seedFromConfig(manager, config);

      const tokenRegistrations = manager.registered.filter((r) =>
        r.key.includes("token"),
      );
      assert.strictEqual(tokenRegistrations.length, 2);

      assert(manager.registered.some(
        (r) => r.key === "adapter:telegram:token" && r.value === "tg-token-123",
      ));
      assert(manager.registered.some(
        (r) => r.key === "adapter:discord:token" && r.value === "discord-token-456",
      ));
    });

    it("registers adapter tokens with source as 'env'", () => {
      const config = createMinimalConfig({
        adapters: {
          telegram: {
            enabled: true,
            token: "test-token",
          },
        },
      });

      seedFromConfig(manager, config);

      const tokenReg = manager.registered.find((r) => r.key === "adapter:telegram:token");
      assert(tokenReg);
      assert.strictEqual(tokenReg.source, "env");
    });

    it("skips adapter tokens when undefined or empty", () => {
      const config = createMinimalConfig({
        adapters: {
          telegram: {
            enabled: true,
            token: "",
          },
          discord: {
            enabled: false,
            // no token
          },
          slack: {
            enabled: true,
            // undefined token
          },
        },
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 0);
    });
  });

  describe("Adapter secrets", () => {
    it("seeds adapter secrets from config.adapters", () => {
      const config = createMinimalConfig({
        adapters: {
          webhook: {
            enabled: true,
            secret: "webhook-secret-xyz",
          },
          slack: {
            enabled: true,
            secret: "slack-signing-secret",
          },
        },
      });

      seedFromConfig(manager, config);

      const secretRegistrations = manager.registered.filter((r) =>
        r.key.includes("secret"),
      );
      assert.strictEqual(secretRegistrations.length, 2);

      assert(manager.registered.some(
        (r) => r.key === "adapter:webhook:secret" && r.value === "webhook-secret-xyz",
      ));
      assert(manager.registered.some(
        (r) => r.key === "adapter:slack:secret" && r.value === "slack-signing-secret",
      ));
    });

    it("registers adapter secrets with source as 'env'", () => {
      const config = createMinimalConfig({
        adapters: {
          webhook: {
            enabled: true,
            secret: "test-secret",
          },
        },
      });

      seedFromConfig(manager, config);

      const secretReg = manager.registered.find(
        (r) => r.key === "adapter:webhook:secret",
      );
      assert(secretReg);
      assert.strictEqual(secretReg.source, "env");
    });

    it("skips adapter secrets when undefined or empty", () => {
      const config = createMinimalConfig({
        adapters: {
          webhook: {
            enabled: true,
            secret: "",
          },
          slack: {
            enabled: true,
            // undefined secret
          },
        },
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 0);
    });

    it("can register both token and secret for same adapter", () => {
      const config = createMinimalConfig({
        adapters: {
          telegram: {
            enabled: true,
            token: "tg-token",
            secret: "tg-secret",
          },
        },
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 2);
      assert(manager.registered.some((r) => r.key === "adapter:telegram:token"));
      assert(manager.registered.some((r) => r.key === "adapter:telegram:secret"));
    });
  });

  describe("Custom secrets from config.secrets", () => {
    it("seeds custom secrets from config.secrets section", () => {
      const config = createMinimalConfig({
        secrets: {
          "database:password": "postgres-pass-123",
          "api:key": "custom-api-key",
          "signing:key": "ed25519-private-key",
        },
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 3);
      assert(manager.registered.some(
        (r) => r.key === "database:password" && r.value === "postgres-pass-123",
      ));
      assert(manager.registered.some(
        (r) => r.key === "api:key" && r.value === "custom-api-key",
      ));
      assert(manager.registered.some(
        (r) => r.key === "signing:key" && r.value === "ed25519-private-key",
      ));
    });

    it("registers custom secrets with source as 'config'", () => {
      const config = createMinimalConfig({
        secrets: {
          "test:key": "test-value",
        },
      });

      seedFromConfig(manager, config);

      const reg = manager.registered.find((r) => r.key === "test:key");
      assert(reg);
      assert.strictEqual(reg.source, "config");
    });

    it("skips undefined values in config.secrets", () => {
      const configObj: { present?: string; missing?: undefined } = {
        present: "value",
        missing: undefined,
      };
      const config = createMinimalConfig({
        secrets: configObj as Record<string, string>,
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 1);
      assert(manager.registered[0]);
      assert.strictEqual(manager.registered[0].key, "present");
    });

    it("skips empty string values in config.secrets", () => {
      const config = createMinimalConfig({
        secrets: {
          "has-value": "value",
          "empty": "",
        },
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 1);
      assert(manager.registered[0]);
      assert.strictEqual(manager.registered[0].key, "has-value");
    });

    it("does nothing when config.secrets is undefined", () => {
      const baseConfig = createMinimalConfig();
      // Create a new config without secrets property
      const config: BetterClawsConfig = {
        gateway: baseConfig.gateway,
        llm: baseConfig.llm,
        adapters: baseConfig.adapters,
        security: baseConfig.security,
        memory: baseConfig.memory,
        logging: baseConfig.logging,
      };

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 0);
    });

    it("does nothing when config.secrets is empty object", () => {
      const config = createMinimalConfig({
        secrets: {},
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 0);
    });
  });

  describe("integration: multiple sources", () => {
    it("seeds from all sources together", () => {
      const config = createMinimalConfig({
        llm: {
          baseUrl: "http://localhost",
          apiKey: "llm-key",
          model: "gpt-4",
          maxTokens: 4096,
          temperature: 0.7,
        },
        adapters: {
          telegram: {
            enabled: true,
            token: "tg-token",
            secret: "tg-secret",
          },
          discord: {
            enabled: true,
            token: "discord-token",
          },
        },
        secrets: {
          "custom:secret1": "value1",
          "custom:secret2": "value2",
        },
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 6);
      const envEntries = manager.registered.filter((r) => r.source === "env");
      const configEntries = manager.registered.filter((r) => r.source === "config");
      assert.strictEqual(
        envEntries.length,
        4,
      ); // llm + 2 adapter + 1 discord token
      assert.strictEqual(
        configEntries.length,
        2,
      ); // custom secrets
    });

    it("preserves insertion order across sources", () => {
      const config = createMinimalConfig({
        llm: {
          baseUrl: "http://localhost",
          apiKey: "llm-key",
          model: "gpt-4",
          maxTokens: 4096,
          temperature: 0.7,
        },
        adapters: {
          telegram: {
            enabled: true,
            token: "tg-token",
          },
        },
        secrets: {
          "custom": "value",
        },
      });

      seedFromConfig(manager, config);

      // LLM key should be registered first
      assert(manager.registered[0]);
      assert.strictEqual(manager.registered[0].key, "llm:apiKey");
      // Then adapter secrets/tokens
      assert(manager.registered.some((r) => r.key === "adapter:telegram:token"));
      // Then custom secrets
      assert(manager.registered.some((r) => r.key === "custom"));
    });
  });

  describe("edge cases", () => {
    it("handles config with no adapters", () => {
      const config = createMinimalConfig({
        adapters: {},
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 0);
    });

    it("handles adapters with neither token nor secret", () => {
      const config = createMinimalConfig({
        adapters: {
          webhook: {
            enabled: false,
          },
          slack: {
            enabled: true,
          },
        },
      });

      seedFromConfig(manager, config);

      assert.strictEqual(manager.registered.length, 0);
    });

    it("handles secret values with special characters", () => {
      const complexValue =
        'p@$$w0rd!@#$%^&*()_+-=[]{}|;\':"<>?,./~`';
      const config = createMinimalConfig({
        secrets: {
          "complex": complexValue,
        },
      });

      seedFromConfig(manager, config);

      assert(manager.registered[0]);
      assert.strictEqual(manager.registered[0].value, complexValue);
    });

    it("handles secret values that are very long", () => {
      const longValue = "x".repeat(10000);
      const config = createMinimalConfig({
        secrets: {
          "long": longValue,
        },
      });

      seedFromConfig(manager, config);

      assert(manager.registered[0]);
      assert.strictEqual(manager.registered[0].value, longValue);
    });

    it("does not modify the config object", () => {
      const config = createMinimalConfig({
        llm: {
          baseUrl: "http://localhost",
          apiKey: "secret-key",
          model: "gpt-4",
          maxTokens: 4096,
          temperature: 0.7,
        },
        secrets: {
          "key": "value",
        },
      });

      const configBefore = JSON.stringify(config);
      seedFromConfig(manager, config);
      const configAfter = JSON.stringify(config);

      assert.strictEqual(configBefore, configAfter);
    });

    it("can be called multiple times without duplication issues", () => {
      const config = createMinimalConfig({
        llm: {
          baseUrl: "http://localhost",
          apiKey: "key",
          model: "gpt-4",
          maxTokens: 4096,
          temperature: 0.7,
        },
      });

      seedFromConfig(manager, config);
      const firstCount = manager.registered.length;

      seedFromConfig(manager, config);
      const secondCount = manager.registered.length;

      // Both calls register the same secret (manager just records, doesn't dedupe)
      assert.strictEqual(firstCount, 1);
      assert.strictEqual(secondCount, 2);
    });
  });
});
