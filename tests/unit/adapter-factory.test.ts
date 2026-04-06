import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAdapter } from "../../src/adapters/adapter-factory.js";
import { ConfigError } from "../../src/config.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { AdapterConfig } from "../../src/types.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

function createMockLogger(): StructuredLogger {
  return {
    log() {},
    async flush() {},
    async close() {},
  } as unknown as StructuredLogger;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createAdapter", () => {
  const logger = createMockLogger();

  describe("known adapters — happy path", () => {
    it("creates TelegramAdapter with valid config", () => {
      const config: AdapterConfig = { enabled: true, token: "tg-token-123" };
      const adapter = createAdapter("telegram", config, logger);

      assert.equal(adapter.id, "telegram");
      assert.equal(adapter.name, "Telegram");
      assert.ok(adapter, "adapter should be created");
    });

    it("creates DiscordAdapter with valid config", () => {
      const config: AdapterConfig = { enabled: true, token: "discord-token-456" };
      const adapter = createAdapter("discord", config, logger);

      assert.equal(adapter.id, "discord");
      assert.equal(adapter.name, "Discord");
    });

    it("creates SlackAdapter with valid config", () => {
      const config: AdapterConfig = {
        enabled: true,
        token: "xoxb-slack-token",
        secret: "xapp-slack-secret",
      };
      const adapter = createAdapter("slack", config, logger);

      assert.equal(adapter.id, "slack");
      assert.equal(adapter.name, "Slack");
    });

    it("creates WebhookAdapter with valid config", () => {
      const config: AdapterConfig = {
        enabled: true,
        secret: "webhook-secret-xyz",
        port: 3000,
      };
      const adapter = createAdapter("webhook", config, logger);

      assert.equal(adapter.id, "webhook");
      assert.equal(adapter.name, "Webhook");
    });

    it("creates SignalAdapter with valid config", () => {
      const config: AdapterConfig = {
        enabled: true,
        apiUrl: "http://signal-cli:7583",
        number: "+1234567890",
      };
      const adapter = createAdapter("signal", config, logger);

      assert.equal(adapter.id, "signal");
      assert.equal(adapter.name, "Signal");
    });
  });

  describe("missing required fields — telegram", () => {
    it("throws ConfigError when token is missing", () => {
      const config: AdapterConfig = { enabled: true };

      assert.throws(
        () => createAdapter("telegram", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          assert.match(err.message, /token/);
          return true;
        },
      );
    });

    it("throws ConfigError when token is empty string", () => {
      const config: AdapterConfig = { enabled: true, token: "" };

      assert.throws(
        () => createAdapter("telegram", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          return true;
        },
      );
    });
  });

  describe("missing required fields — discord", () => {
    it("throws ConfigError when token is missing", () => {
      const config: AdapterConfig = { enabled: true };

      assert.throws(
        () => createAdapter("discord", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          assert.match(err.message, /token/);
          return true;
        },
      );
    });

    it("throws ConfigError when token is empty string", () => {
      const config: AdapterConfig = { enabled: true, token: "" };

      assert.throws(
        () => createAdapter("discord", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          return true;
        },
      );
    });
  });

  describe("missing required fields — slack", () => {
    it("throws ConfigError when token is missing", () => {
      const config: AdapterConfig = { enabled: true, secret: "slack-secret" };

      assert.throws(
        () => createAdapter("slack", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          assert.match(err.message, /token/);
          return true;
        },
      );
    });

    it("throws ConfigError when secret is missing", () => {
      const config: AdapterConfig = { enabled: true, token: "xoxb-token" };

      assert.throws(
        () => createAdapter("slack", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          assert.match(err.message, /secret/);
          return true;
        },
      );
    });

    it("throws ConfigError when both token and secret are missing", () => {
      const config: AdapterConfig = { enabled: true };

      assert.throws(
        () => createAdapter("slack", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          return true;
        },
      );
    });

    it("throws ConfigError when token is empty", () => {
      const config: AdapterConfig = { enabled: true, token: "", secret: "secret" };

      assert.throws(
        () => createAdapter("slack", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          return true;
        },
      );
    });

    it("throws ConfigError when secret is empty", () => {
      const config: AdapterConfig = { enabled: true, token: "token", secret: "" };

      assert.throws(
        () => createAdapter("slack", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          return true;
        },
      );
    });
  });

  describe("missing required fields — webhook", () => {
    it("throws ConfigError when secret is missing", () => {
      const config: AdapterConfig = { enabled: true, port: 3000 };

      assert.throws(
        () => createAdapter("webhook", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          assert.match(err.message, /secret/);
          return true;
        },
      );
    });

    it("throws ConfigError when port is missing", () => {
      const config: AdapterConfig = { enabled: true, secret: "webhook-secret" };

      assert.throws(
        () => createAdapter("webhook", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          assert.match(err.message, /port/);
          return true;
        },
      );
    });

    it("throws ConfigError when both secret and port are missing", () => {
      const config: AdapterConfig = { enabled: true };

      assert.throws(
        () => createAdapter("webhook", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          return true;
        },
      );
    });

    it("throws ConfigError when port is 0", () => {
      const config: AdapterConfig = { enabled: true, secret: "secret", port: 0 };

      assert.throws(
        () => createAdapter("webhook", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          return true;
        },
      );
    });

    it("throws ConfigError when secret is empty", () => {
      const config: AdapterConfig = { enabled: true, secret: "", port: 3000 };

      assert.throws(
        () => createAdapter("webhook", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          return true;
        },
      );
    });

    it("succeeds with optional host and path", () => {
      const config: AdapterConfig = {
        enabled: true,
        secret: "secret",
        port: 3000,
        host: "127.0.0.1",
        path: "/webhook",
      };
      const adapter = createAdapter("webhook", config, logger);

      assert.equal(adapter.id, "webhook");
      assert.equal(adapter.name, "Webhook");
    });
  });

  describe("missing required fields — signal", () => {
    it("throws ConfigError when apiUrl is missing", () => {
      const config: AdapterConfig = { enabled: true, number: "+1234567890" };

      assert.throws(
        () => createAdapter("signal", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          assert.match(err.message, /apiUrl/);
          return true;
        },
      );
    });

    it("throws ConfigError when number is missing", () => {
      const config: AdapterConfig = { enabled: true, apiUrl: "http://signal-cli:7583" };

      assert.throws(
        () => createAdapter("signal", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          assert.match(err.message, /number/);
          return true;
        },
      );
    });

    it("throws ConfigError when both apiUrl and number are missing", () => {
      const config: AdapterConfig = { enabled: true };

      assert.throws(
        () => createAdapter("signal", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          return true;
        },
      );
    });

    it("throws ConfigError when apiUrl is empty", () => {
      const config: AdapterConfig = { enabled: true, apiUrl: "", number: "+123" };

      assert.throws(
        () => createAdapter("signal", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          return true;
        },
      );
    });

    it("throws ConfigError when number is empty", () => {
      const config: AdapterConfig = { enabled: true, apiUrl: "http://localhost", number: "" };

      assert.throws(
        () => createAdapter("signal", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "MISSING_ADAPTER_CONFIG");
          return true;
        },
      );
    });
  });

  describe("unknown adapter", () => {
    it("throws ConfigError with code UNKNOWN_ADAPTER", () => {
      const config: AdapterConfig = { enabled: true };

      assert.throws(
        () => createAdapter("foobar", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "UNKNOWN_ADAPTER");
          assert.match(err.message, /foobar/);
          return true;
        },
      );
    });

    it("throws ConfigError for case-sensitive name mismatch", () => {
      const config: AdapterConfig = { enabled: true, token: "token" };

      assert.throws(
        () => createAdapter("Telegram", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "UNKNOWN_ADAPTER");
          return true;
        },
      );
    });

    it("throws ConfigError for empty adapter name", () => {
      const config: AdapterConfig = { enabled: true };

      assert.throws(
        () => createAdapter("", config, logger),
        (err: unknown) => {
          if (!(err instanceof ConfigError)) return false;
          assert.equal(err.code, "UNKNOWN_ADAPTER");
          return true;
        },
      );
    });
  });

  describe("interface compliance", () => {
    it("returns object implementing ChannelAdapter interface", () => {
      const config: AdapterConfig = { enabled: true, token: "token" };
      const adapter = createAdapter("telegram", config, logger);

      assert.ok(typeof adapter.id === "string");
      assert.ok(typeof adapter.name === "string");
      assert.ok(typeof adapter.start === "function");
      assert.ok(typeof adapter.stop === "function");
      assert.ok(typeof adapter.onMessage === "function");
      assert.ok(typeof adapter.send === "function");
    });

    it("all adapters have unique id and name", () => {
      const adapters: Array<{ name: string; config: AdapterConfig }> = [
        { name: "telegram", config: { enabled: true, token: "t1" } },
        { name: "discord", config: { enabled: true, token: "t2" } },
        { name: "slack", config: { enabled: true, token: "t3", secret: "s1" } },
        { name: "webhook", config: { enabled: true, secret: "s2", port: 3000 } },
        { name: "signal", config: { enabled: true, apiUrl: "http://a", number: "n1" } },
      ];

      const ids = new Set<string>();
      const names = new Set<string>();

      for (const spec of adapters) {
        const adapter = createAdapter(spec.name, spec.config, logger);
        assert.ok(!ids.has(adapter.id), `duplicate id: ${adapter.id}`);
        assert.ok(!names.has(adapter.name), `duplicate name: ${adapter.name}`);
        ids.add(adapter.id);
        names.add(adapter.name);
      }

      assert.equal(ids.size, 5, "should have 5 unique adapter ids");
      assert.equal(names.size, 5, "should have 5 unique adapter names");
    });
  });

  describe("edge cases", () => {
    it("accepts null secret when checking other required fields", () => {
      const config: AdapterConfig = {
        enabled: true,
        token: "token",
        secret: undefined,
      };

      const adapter = createAdapter("telegram", config, logger);
      assert.equal(adapter.id, "telegram");
    });

    it("requires fields to have truthy values", () => {
      const config: AdapterConfig = {
        enabled: true,
        token: undefined,
      };

      assert.throws(
        () => createAdapter("telegram", config, logger),
        ConfigError,
      );
    });

    it("passes logger to adapter", () => {
      const config: AdapterConfig = { enabled: true, token: "token" };
      const adapter = createAdapter("telegram", config, logger);

      assert.ok(adapter, "adapter should be created with logger");
    });
  });
});
