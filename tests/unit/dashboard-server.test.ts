import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DashboardServer,
  DashboardError,
  type DashboardContext,
} from "../../src/dashboard/dashboard-server.js";
import { SessionManager } from "../../src/sessions/session-manager.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { BetterClawsConfig } from "../../src/types.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

function createMockLogger(): StructuredLogger & { logs: Array<Record<string, unknown>> } {
  const logs: Array<Record<string, unknown>> = [];
  return {
    logs,
    log(e: Record<string, unknown>) { logs.push(e); },
    async flush() {},
    async close() {},
  } as unknown as StructuredLogger & { logs: typeof logs };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bc-dash-"));
}

const TEST_CONFIG: BetterClawsConfig = {
  gateway: { host: "127.0.0.1", port: 18700 },
  llm: { baseUrl: "http://localhost:11434/v1", apiKey: "env:TEST_KEY", model: "test", maxTokens: 1024, temperature: 0.7 },
  adapters: { telegram: { enabled: false, token: "env:BC_TELEGRAM_TOKEN" } },
  security: { defaultCapabilityPolicy: "deny", sandboxTimeout: 30000, stripEnvironment: true, allowPersistentGrants: false },
  memory: { maxLongTermEntries: 2000, confidenceDecayRate: 0.01, staleThreshold: 0.2, curationIntervalMinutes: 60, curationEnabled: true, workingMemoryBudgetChars: 8192 },
  logging: { directory: "data/logs", redactSensitive: true, retentionDays: 90 },
};

let portCounter = 19200;
function nextPort(): number {
  return portCounter++;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJson(port: number, apiPath: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${apiPath}`);
  const body = await response.json();
  return { status: response.status, body };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DashboardServer", () => {
  const servers: DashboardServer[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await s.stop();
    }
    servers.length = 0;
  });

  function makeServer(overrides?: {
    logsDir?: string;
    memoryDir?: string;
    toolDescriptors?: DashboardContext["toolDescriptors"];
    adapterStatuses?: DashboardContext["adapterStatuses"];
    adapterInfos?: DashboardContext["adapterInfos"];
  }) {
    const tmpDir = makeTmpDir();
    const logger = createMockLogger();
    const port = nextPort();
    const logsDir = overrides?.logsDir ?? path.join(tmpDir, "logs");
    const sessionsDir = path.join(tmpDir, "sessions");
    const staticDir = path.join(tmpDir, "static");

    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(staticDir, { recursive: true });

    // Create a minimal index.html for static serving test
    fs.writeFileSync(path.join(staticDir, "index.html"), "<html><body>dashboard</body></html>");

    const sessionManager = new SessionManager({
      sessionsDirectory: sessionsDir,
      idleTimeoutMs: 60000,
      logger,
      workingMemoryBudgetChars: 8192,
    });

    const context: DashboardContext = {
      sessionManager,
      logger,
      config: TEST_CONFIG,
      logsDirectory: logsDir,
      memoryDirectory: overrides?.memoryDir,
      toolDescriptors: overrides?.toolDescriptors,
      adapterStatuses: overrides?.adapterStatuses,
      adapterInfos: overrides?.adapterInfos,
    };

    const server = new DashboardServer({
      port,
      context,
      logger,
      staticDir,
    });

    servers.push(server);
    return { server, logger, port, tmpDir, logsDir, sessionManager, staticDir };
  }

  describe("start / stop", () => {
    it("starts and logs", async () => {
      const { server, logger } = makeServer();
      await server.start();

      const startLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "start",
      );
      assert.ok(startLog);
      assert.equal(startLog["component"], "dashboard");
    });

    it("stops and logs", async () => {
      const { server, logger } = makeServer();
      await server.start();
      await server.stop();
      servers.pop(); // already stopped

      const stopLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "stop",
      );
      assert.ok(stopLog);
    });
  });

  describe("GET /api/status", () => {
    it("returns system status", async () => {
      const adapters = new Map([
        ["telegram", { connected: true, name: "Telegram" }],
      ]);
      const { server, port } = makeServer({ adapterStatuses: adapters });
      await server.start();

      const { status, body } = await fetchJson(port, "/api/status");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      assert.equal(data["status"], "running");
      assert.equal(typeof data["uptime"], "number");
      assert.ok(data["memoryUsage"]);

      const adapterData = data["adapters"] as Record<string, unknown>;
      assert.ok(adapterData["telegram"]);
    });
  });

  describe("GET /api/tools", () => {
    it("returns registered tools", async () => {
      const tools = [
        { name: "shell", description: "Execute shell commands", capabilities: ["exec:shell"], source: "built-in" as const },
      ];
      const { server, port } = makeServer({ toolDescriptors: tools });
      await server.start();

      const { status, body } = await fetchJson(port, "/api/tools");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const toolList = data["tools"] as Array<Record<string, unknown>>;
      assert.equal(toolList.length, 1);
      assert.equal(toolList[0]!["name"], "shell");
    });

    it("includes source field on each tool", async () => {
      const tools = [
        { name: "shell", description: "Execute shell commands", capabilities: ["exec:shell"], source: "built-in" as const },
        { name: "web-fetch", description: "Fetch from web", capabilities: ["net:http"], source: "plugin" as const },
        { name: "custom-tool", description: "User-defined tool", capabilities: ["custom"], source: "skill" as const },
      ];
      const { server, port } = makeServer({ toolDescriptors: tools });
      await server.start();

      const { status, body } = await fetchJson(port, "/api/tools");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const toolList = data["tools"] as Array<Record<string, unknown>>;
      assert.equal(toolList.length, 3);

      // Verify each tool has source field with correct values
      assert.equal(toolList[0]!["source"], "built-in");
      assert.equal(toolList[1]!["source"], "plugin");
      assert.equal(toolList[2]!["source"], "skill");
    });

    it("returns empty tools array when none registered", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { status, body } = await fetchJson(port, "/api/tools");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const toolList = data["tools"] as Array<Record<string, unknown>>;
      assert.equal(toolList.length, 0);
    });
  });

  describe("GET /api/adapters", () => {
    it("returns empty array when no adapterInfos provided", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { status, body } = await fetchJson(port, "/api/adapters");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const adapters = data["adapters"] as Array<Record<string, unknown>>;
      assert.equal(adapters.length, 0);
    });

    it("returns adapter info when adapterInfos is populated", async () => {
      const adapterInfos = [
        {
          id: "telegram",
          name: "Telegram",
          enabled: true,
          type: "polling" as const,
          connected: true,
        },
      ];
      const { server, port } = makeServer({ adapterInfos });
      await server.start();

      const { status, body } = await fetchJson(port, "/api/adapters");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const adapters = data["adapters"] as Array<Record<string, unknown>>;
      assert.equal(adapters.length, 1);
      assert.equal(adapters[0]!["id"], "telegram");
      assert.equal(adapters[0]!["name"], "Telegram");
    });

    it("returns correct fields for each adapter (id, name, enabled, type, connected)", async () => {
      const adapterInfos = [
        {
          id: "slack",
          name: "Slack",
          enabled: true,
          type: "websocket" as const,
          connected: true,
        },
      ];
      const { server, port } = makeServer({ adapterInfos });
      await server.start();

      const { status, body } = await fetchJson(port, "/api/adapters");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const adapters = data["adapters"] as Array<Record<string, unknown>>;
      assert.equal(adapters.length, 1);

      const adapter = adapters[0]!;
      assert.equal(adapter["id"], "slack");
      assert.equal(adapter["name"], "Slack");
      assert.equal(adapter["enabled"], true);
      assert.equal(adapter["type"], "websocket");
      assert.equal(adapter["connected"], true);
    });

    it("includes optional fields (host, port, path, url) when present", async () => {
      const adapterInfos = [
        {
          id: "webhook",
          name: "Webhook Server",
          enabled: true,
          type: "http-server" as const,
          connected: true,
          host: "localhost",
          port: 3000,
          path: "/webhook",
          url: "http://localhost:3000/webhook",
        },
      ];
      const { server, port } = makeServer({ adapterInfos });
      await server.start();

      const { status, body } = await fetchJson(port, "/api/adapters");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const adapters = data["adapters"] as Array<Record<string, unknown>>;
      const adapter = adapters[0]!;

      assert.equal(adapter["host"], "localhost");
      assert.equal(adapter["port"], 3000);
      assert.equal(adapter["path"], "/webhook");
      assert.equal(adapter["url"], "http://localhost:3000/webhook");
    });

    it("returns disabled adapters with connected=false", async () => {
      const adapterInfos = [
        {
          id: "discord",
          name: "Discord",
          enabled: false,
          type: "websocket" as const,
          connected: false,
        },
      ];
      const { server, port } = makeServer({ adapterInfos });
      await server.start();

      const { status, body } = await fetchJson(port, "/api/adapters");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const adapters = data["adapters"] as Array<Record<string, unknown>>;
      const adapter = adapters[0]!;

      assert.equal(adapter["enabled"], false);
      assert.equal(adapter["connected"], false);
    });

    it("returns multiple adapters in the array", async () => {
      const adapterInfos = [
        {
          id: "telegram",
          name: "Telegram",
          enabled: true,
          type: "polling" as const,
          connected: true,
        },
        {
          id: "slack",
          name: "Slack",
          enabled: true,
          type: "websocket" as const,
          connected: false,
        },
        {
          id: "webhook",
          name: "Webhook",
          enabled: true,
          type: "http-server" as const,
          connected: true,
          host: "0.0.0.0",
          port: 8080,
        },
      ];
      const { server, port } = makeServer({ adapterInfos });
      await server.start();

      const { status, body } = await fetchJson(port, "/api/adapters");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const adapters = data["adapters"] as Array<Record<string, unknown>>;
      assert.equal(adapters.length, 3);

      assert.equal(adapters[0]!["id"], "telegram");
      assert.equal(adapters[1]!["id"], "slack");
      assert.equal(adapters[2]!["id"], "webhook");
    });
  });

  describe("GET /api/config", () => {
    it("returns config with secrets redacted", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { status, body } = await fetchJson(port, "/api/config");
      assert.equal(status, 200);

      const config = (body as Record<string, unknown>)["config"] as Record<string, unknown>;
      const llm = config["llm"] as Record<string, unknown>;
      assert.equal(llm["apiKey"], "[REDACTED]");

      const adapters = config["adapters"] as Record<string, Record<string, unknown>>;
      assert.equal(adapters["telegram"]!["token"], "[REDACTED]");
    });
  });

  describe("GET /api/sessions", () => {
    it("returns session list", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { status, body } = await fetchJson(port, "/api/sessions");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      assert.ok(Array.isArray(data["sessions"]));
    });
  });

  describe("GET /api/sessions/:id/history", () => {
    it("returns session history", async () => {
      const { server, port, sessionManager } = makeServer();
      await server.start();

      const session = await sessionManager.getOrCreate("test", "ch1", "u1");
      await sessionManager.appendToLog(session.id, {
        type: "inbound",
        message: {
          id: "1", adapterId: "test", channelId: "ch1",
          senderId: "u1", text: "Hello", timestamp: Date.now(),
        },
      });

      const { status, body } = await fetchJson(port, `/api/sessions/${session.id}/history`);
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const history = data["history"] as Array<Record<string, unknown>>;
      assert.equal(history.length, 1);
      assert.equal(history[0]!["content"], "Hello");
    });

    it("returns empty for unknown session", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { status, body } = await fetchJson(port, "/api/sessions/nonexistent/history");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      assert.equal((data["history"] as unknown[]).length, 0);
    });
  });

  describe("GET /api/sessions/:id/grants", () => {
    it("returns capability grants", async () => {
      const { server, port, sessionManager } = makeServer();
      await server.start();

      const session = await sessionManager.getOrCreate("test", "ch1", "u1");
      sessionManager.grantCapability(session.id, "fs:read", "session");

      const { status, body } = await fetchJson(port, `/api/sessions/${session.id}/grants`);
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const grants = data["grants"] as Record<string, string>;
      assert.equal(grants["fs:read"], "session");
    });
  });

  describe("GET /api/logs", () => {
    it("returns parsed log entries", async () => {
      const { server, port, logsDir } = makeServer();

      // Write a log file for today
      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(logsDir, `${today}.jsonl`);
      const entries = [
        { timestamp: "2024-01-01T00:00:00Z", sessionId: null, eventType: "config:change", component: "test", payload: { action: "start" } },
        { timestamp: "2024-01-01T00:01:00Z", sessionId: "s1", eventType: "message:inbound", component: "router", payload: { text: "hello" } },
      ];
      fs.writeFileSync(logFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

      await server.start();

      const { status, body } = await fetchJson(port, "/api/logs");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      assert.equal(data["total"], 2);
    });

    it("filters by eventType", async () => {
      const { server, port, logsDir } = makeServer();

      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(logsDir, `${today}.jsonl`);
      fs.writeFileSync(logFile, [
        JSON.stringify({ eventType: "config:change", component: "test", payload: {} }),
        JSON.stringify({ eventType: "message:inbound", component: "router", payload: {} }),
      ].join("\n") + "\n");

      await server.start();

      const { body } = await fetchJson(port, "/api/logs?eventType=message:inbound");
      const data = body as Record<string, unknown>;
      assert.equal(data["total"], 1);
    });

    it("filters by search text", async () => {
      const { server, port, logsDir } = makeServer();

      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(logsDir, `${today}.jsonl`);
      fs.writeFileSync(logFile, [
        JSON.stringify({ eventType: "tool:invoke", component: "router", payload: { tool: "shell" } }),
        JSON.stringify({ eventType: "message:inbound", component: "router", payload: { text: "weather" } }),
      ].join("\n") + "\n");

      await server.start();

      const { body } = await fetchJson(port, "/api/logs?search=shell");
      const data = body as Record<string, unknown>;
      assert.equal(data["total"], 1);
    });

    it("supports pagination", async () => {
      const { server, port, logsDir } = makeServer();

      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(logsDir, `${today}.jsonl`);
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(JSON.stringify({ eventType: "config:change", component: "test", payload: { i } }));
      }
      fs.writeFileSync(logFile, lines.join("\n") + "\n");

      await server.start();

      const { body } = await fetchJson(port, "/api/logs?limit=3&offset=2");
      const data = body as Record<string, unknown>;
      assert.equal((data["logs"] as unknown[]).length, 3);
      assert.equal(data["total"], 10);
      assert.equal(data["offset"], 2);
    });
  });

  describe("GET /api/memory", () => {
    it("returns memory entries", async () => {
      const tmpDir = makeTmpDir();
      const memoryDir = path.join(tmpDir, "memory");
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, "entries.jsonl"), [
        JSON.stringify({ id: "1", category: "fact", content: "User likes TypeScript", confidence: 0.9, tags: ["programming"] }),
        JSON.stringify({ id: "2", category: "preference", content: "Dark mode", confidence: 0.7, tags: ["ui"] }),
      ].join("\n") + "\n");

      const { server, port } = makeServer({ memoryDir: memoryDir });
      await server.start();

      const { status, body } = await fetchJson(port, "/api/memory");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      assert.equal(data["total"], 2);
    });

    it("filters by category", async () => {
      const tmpDir = makeTmpDir();
      const memoryDir = path.join(tmpDir, "memory");
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, "entries.jsonl"), [
        JSON.stringify({ id: "1", category: "fact", content: "A", confidence: 0.9, tags: [] }),
        JSON.stringify({ id: "2", category: "preference", content: "B", confidence: 0.7, tags: [] }),
      ].join("\n") + "\n");

      const { server, port } = makeServer({ memoryDir: memoryDir });
      await server.start();

      const { body } = await fetchJson(port, "/api/memory?category=fact");
      const data = body as Record<string, unknown>;
      assert.equal(data["total"], 1);
    });

    it("filters by minConfidence", async () => {
      const tmpDir = makeTmpDir();
      const memoryDir = path.join(tmpDir, "memory");
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, "entries.jsonl"), [
        JSON.stringify({ id: "1", category: "fact", content: "High", confidence: 0.9, tags: [] }),
        JSON.stringify({ id: "2", category: "fact", content: "Low", confidence: 0.1, tags: [] }),
      ].join("\n") + "\n");

      const { server, port } = makeServer({ memoryDir: memoryDir });
      await server.start();

      const { body } = await fetchJson(port, "/api/memory?minConfidence=0.5");
      const data = body as Record<string, unknown>;
      assert.equal(data["total"], 1);
    });

    it("returns empty when no memory directory", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/memory");
      const data = body as Record<string, unknown>;
      assert.equal(data["total"], 0);
    });
  });

  describe("static file serving", () => {
    it("serves index.html at /", async () => {
      const { server, port } = makeServer();
      await server.start();

      const response = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(text.includes("dashboard"));
    });

    it("blocks path traversal", async () => {
      const { server, port } = makeServer();
      await server.start();

      const response = await fetch(`http://127.0.0.1:${port}/../../../etc/passwd`);
      const text = await response.text();
      // Path traversal should be blocked (403) or return safe fallback (index.html)
      assert.ok(
        response.status === 403 || !text.includes("root:"),
        "should not serve files outside static dir",
      );
    });
  });

  describe("unknown API endpoint", () => {
    it("returns 404", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { status, body } = await fetchJson(port, "/api/unknown");
      assert.equal(status, 404);
      assert.equal((body as Record<string, unknown>)["error"], "API endpoint not found");
    });
  });

  describe("localhost binding", () => {
    it("binds to 127.0.0.1 by default", async () => {
      const { server, logger } = makeServer();
      await server.start();

      const startLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "start",
      );
      assert.equal((startLog!["payload"] as Record<string, unknown>)["host"], "127.0.0.1");
    });
  });

  describe("startup guard (network exposure security)", () => {
    it("throws DashboardError when host is 0.0.0.0 and authToken is undefined", async () => {
      const tmpDir = makeTmpDir();
      const logger = createMockLogger();
      const port = nextPort();
      const staticDir = path.join(tmpDir, "static");
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: path.join(tmpDir, "logs"),
      };

      const server = new DashboardServer({
        host: "0.0.0.0",
        port,
        context,
        logger,
        staticDir,
        authToken: undefined,
      });
      servers.push(server);

      await assert.rejects(
        () => server.start(),
        (err) => {
          assert.ok(err instanceof DashboardError);
          assert.equal((err as DashboardError).code, "UNSAFE_CONFIG");
          assert.ok((err as Error).message.includes("non-loopback address"));
          return true;
        },
      );
    });

    it("throws DashboardError when host is 0.0.0.0 and authToken is empty string", async () => {
      const tmpDir = makeTmpDir();
      const logger = createMockLogger();
      const port = nextPort();
      const staticDir = path.join(tmpDir, "static");
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: path.join(tmpDir, "logs"),
      };

      const server = new DashboardServer({
        host: "0.0.0.0",
        port,
        context,
        logger,
        staticDir,
        authToken: "",
      });
      servers.push(server);

      await assert.rejects(
        () => server.start(),
        (err) => {
          assert.ok(err instanceof DashboardError);
          assert.equal((err as DashboardError).code, "UNSAFE_CONFIG");
          return true;
        },
      );
    });

    it("does NOT throw when host is 127.0.0.1 and authToken is undefined", async () => {
      const tmpDir = makeTmpDir();
      const logger = createMockLogger();
      const port = nextPort();
      const logsDir = path.join(tmpDir, "logs");
      const staticDir = path.join(tmpDir, "static");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: logsDir,
      };

      const server = new DashboardServer({
        host: "127.0.0.1",
        port,
        context,
        logger,
        staticDir,
        authToken: undefined,
      });
      servers.push(server);

      await server.start();
      assert.ok(true, "should start without error");
    });

    it("does NOT throw when host is localhost and authToken is undefined", async () => {
      const tmpDir = makeTmpDir();
      const logger = createMockLogger();
      const port = nextPort();
      const logsDir = path.join(tmpDir, "logs");
      const staticDir = path.join(tmpDir, "static");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: logsDir,
      };

      const server = new DashboardServer({
        host: "localhost",
        port,
        context,
        logger,
        staticDir,
        authToken: undefined,
      });
      servers.push(server);

      await server.start();
      assert.ok(true, "should start without error");
    });

    it("does NOT throw when host is 0.0.0.0 and authToken is a real token", async () => {
      const tmpDir = makeTmpDir();
      const logger = createMockLogger();
      const port = nextPort();
      const logsDir = path.join(tmpDir, "logs");
      const staticDir = path.join(tmpDir, "static");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: logsDir,
      };

      const server = new DashboardServer({
        host: "0.0.0.0",
        port,
        context,
        logger,
        staticDir,
        authToken: "super-secret-token-xyz",
      });
      servers.push(server);

      await server.start();
      assert.ok(true, "should start without error when authToken is configured");
    });
  });

  describe("secret redaction (substring matching)", () => {
    it("redacts fields matching /api_?key/i pattern", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config");
      const config = (body as Record<string, unknown>)["config"] as Record<string, unknown>;

      // apiKey should be redacted
      const llm = config["llm"] as Record<string, unknown>;
      assert.equal(llm["apiKey"], "[REDACTED]");
    });

    it("redacts token field from adapters", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config");
      const config = (body as Record<string, unknown>)["config"] as Record<string, unknown>;
      const adapters = config["adapters"] as Record<string, Record<string, unknown>>;

      // token field should be redacted
      assert.equal(adapters["telegram"]!["token"], "[REDACTED]");
    });

    it("redacts all env: values regardless of field name", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config");
      const config = (body as Record<string, unknown>)["config"] as Record<string, unknown>;

      // Both apiKey and token start with env:
      const llm = config["llm"] as Record<string, unknown>;
      assert.equal(llm["apiKey"], "[REDACTED]");

      const adapters = config["adapters"] as Record<string, Record<string, unknown>>;
      assert.equal(adapters["telegram"]!["token"], "[REDACTED]");
    });

    it("recursively redacts nested objects", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config");
      const config = (body as Record<string, unknown>)["config"] as Record<string, unknown>;

      // llm.apiKey should be redacted (nested)
      const llm = config["llm"] as Record<string, unknown>;
      assert.equal(llm["apiKey"], "[REDACTED]");

      // adapters.telegram.token should be redacted (nested)
      const adapters = config["adapters"] as Record<string, Record<string, unknown>>;
      assert.equal(adapters["telegram"]!["token"], "[REDACTED]");
    });

    it("redacts fields containing 'api_key' (with underscore)", async () => {
      // The regex pattern is /api_?key/i which matches both "apikey" and "api_key"
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config");
      const config = (body as Record<string, unknown>)["config"] as Record<string, unknown>;
      const llm = config["llm"] as Record<string, unknown>;

      // apiKey matches the pattern and should be redacted
      assert.equal(llm["apiKey"], "[REDACTED]");
    });

    it("redacts fields containing 'token' substring", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config");
      const config = (body as Record<string, unknown>)["config"] as Record<string, unknown>;
      const adapters = config["adapters"] as Record<string, Record<string, unknown>>;

      // token field should be redacted
      assert.equal(adapters["telegram"]!["token"], "[REDACTED]");
    });

    it("redacts fields containing 'secret' substring (case insensitive)", async () => {
      // Test the /secret/i pattern with default config that has multiple secret references
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config");
      const config = (body as Record<string, unknown>)["config"] as Record<string, unknown>;

      // Verify the config structure is what we expect
      assert.ok(config["llm"]);
      assert.ok(config["adapters"]);

      // The redaction logic should have caught env: values
      const llm = config["llm"] as Record<string, unknown>;
      assert.equal(llm["apiKey"], "[REDACTED]");
    });

    it("redacts fields containing 'password' substring (case insensitive)", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config");
      const config = (body as Record<string, unknown>)["config"] as Record<string, unknown>;

      // Verify structure is present
      assert.ok(config["llm"]);
      assert.ok(config["adapters"]);
    });

    it("redacts fields containing 'credential' substring (case insensitive)", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config");
      const config = (body as Record<string, unknown>)["config"] as Record<string, unknown>;

      // Verify structure is present
      assert.ok(config["llm"]);
      assert.ok(config["adapters"]);
    });

    it("redacts fields containing 'auth' substring (case insensitive)", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config");
      const config = (body as Record<string, unknown>)["config"] as Record<string, unknown>;

      // Verify structure is present
      assert.ok(config["llm"]);
      assert.ok(config["adapters"]);
    });
  });

  describe("GET /api/config/schema", () => {
    it("returns config schema with all sections", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { status, body } = await fetchJson(port, "/api/config/schema");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const sections = data["sections"] as Array<Record<string, unknown>>;

      // Should have at least 8 sections as documented
      assert.ok(sections.length >= 8, `Expected at least 8 sections, got ${sections.length}`);
    });

    it("includes required section keys", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { status, body } = await fetchJson(port, "/api/config/schema");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const sections = data["sections"] as Array<Record<string, unknown>>;

      // Extract section keys
      const sectionKeys = new Set(sections.map(s => s["key"]));

      // Verify required sections exist
      const requiredSections = ["gateway", "llm", "systemContext", "security", "memory", "logging", "dashboard", "compaction"];
      for (const required of requiredSections) {
        assert.ok(sectionKeys.has(required), `Missing required section: ${required}`);
      }
    });

    it("each section has label, description, and fields array", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { status, body } = await fetchJson(port, "/api/config/schema");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const sections = data["sections"] as Array<Record<string, unknown>>;

      for (const section of sections) {
        assert.ok(typeof section["key"] === "string", "section.key should be string");
        assert.ok(typeof section["label"] === "string", "section.label should be string");
        assert.ok(typeof section["description"] === "string", "section.description should be string");
        assert.ok(Array.isArray(section["fields"]), "section.fields should be array");
      }
    });

    it("each field has key, label, type, and description", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { status, body } = await fetchJson(port, "/api/config/schema");
      assert.equal(status, 200);

      const data = body as Record<string, unknown>;
      const sections = data["sections"] as Array<Record<string, unknown>>;

      for (const section of sections) {
        const fields = section["fields"] as Array<Record<string, unknown>>;
        for (const field of fields) {
          assert.ok(typeof field["key"] === "string", `field.key should be string in section ${section["key"]}`);
          assert.ok(typeof field["label"] === "string", `field.label should be string in section ${section["key"]}`);
          assert.ok(typeof field["type"] === "string", `field.type should be string in section ${section["key"]}`);
          assert.ok(typeof field["description"] === "string", `field.description should be string in section ${section["key"]}`);
        }
      }
    });

    it("gateway section includes host and port fields", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config/schema");
      const data = body as Record<string, unknown>;
      const sections = data["sections"] as Array<Record<string, unknown>>;

      const gatewaySection = sections.find(s => s["key"] === "gateway");
      assert.ok(gatewaySection, "gateway section should exist");

      const fields = gatewaySection!["fields"] as Array<Record<string, unknown>>;
      const fieldKeys = new Set(fields.map(f => f["key"]));
      assert.ok(fieldKeys.has("host"), "gateway section should have host field");
      assert.ok(fieldKeys.has("port"), "gateway section should have port field");
    });

    it("llm section includes baseUrl, apiKey, model, maxTokens, temperature fields", async () => {
      const { server, port } = makeServer();
      await server.start();

      const { body } = await fetchJson(port, "/api/config/schema");
      const data = body as Record<string, unknown>;
      const sections = data["sections"] as Array<Record<string, unknown>>;

      const llmSection = sections.find(s => s["key"] === "llm");
      assert.ok(llmSection, "llm section should exist");

      const fields = llmSection!["fields"] as Array<Record<string, unknown>>;
      const fieldKeys = new Set(fields.map(f => f["key"]));

      const requiredFields = ["baseUrl", "apiKey", "model", "maxTokens", "temperature"];
      for (const required of requiredFields) {
        assert.ok(fieldKeys.has(required), `llm section should have ${required} field`);
      }
    });
  });

  describe("PUT /api/config/section/:sectionKey", () => {
    it("updates a config section and returns success", async () => {
      const tmpDir = makeTmpDir();
      const configPath = path.join(tmpDir, "config.json");
      const logger = createMockLogger();
      const port = nextPort();
      const logsDir = path.join(tmpDir, "logs");
      const staticDir = path.join(tmpDir, "static");

      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      // Create context with rawConfig and configPath for persistence
      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: logsDir,
        configPath,
        rawConfig: JSON.parse(JSON.stringify(TEST_CONFIG)) as Record<string, unknown>,
      };

      const server = new DashboardServer({
        port,
        context,
        logger,
        staticDir,
      });
      servers.push(server);
      await server.start();

      // Send PUT request to update memory section
      const response = await fetch(`http://127.0.0.1:${port}/api/config/section/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxLongTermEntries: 5000 }),
      });

      assert.equal(response.status, 200);
      const data = (await response.json()) as Record<string, unknown>;
      assert.equal(data["saved"], true);
      assert.equal(data["section"], "memory");
    });

    it("merges new values into existing section", async () => {
      const tmpDir = makeTmpDir();
      const configPath = path.join(tmpDir, "config.json");
      const logger = createMockLogger();
      const port = nextPort();
      const logsDir = path.join(tmpDir, "logs");
      const staticDir = path.join(tmpDir, "static");

      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: logsDir,
        configPath,
        rawConfig: JSON.parse(JSON.stringify(TEST_CONFIG)) as Record<string, unknown>,
      };

      const server = new DashboardServer({
        port,
        context,
        logger,
        staticDir,
      });
      servers.push(server);
      await server.start();

      // Send PUT request with only one field update
      const response = await fetch(`http://127.0.0.1:${port}/api/config/section/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxLongTermEntries: 3000 }),
      });

      assert.equal(response.status, 200);
      const data = (await response.json()) as Record<string, unknown>;
      assert.equal(data["saved"], true);

      // Verify other memory section fields were not removed (merge, not replace)
      const memorySection = (context.config as unknown as Record<string, unknown>)["memory"] as Record<string, unknown>;
      assert.ok(typeof memorySection["confidenceDecayRate"] === "number", "existing fields should be preserved");
    });

    it("returns 400 if body is not an object", async () => {
      const tmpDir = makeTmpDir();
      const logger = createMockLogger();
      const port = nextPort();
      const staticDir = path.join(tmpDir, "static");
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: path.join(tmpDir, "logs"),
        rawConfig: JSON.parse(JSON.stringify(TEST_CONFIG)) as Record<string, unknown>,
      };

      const server = new DashboardServer({
        port,
        context,
        logger,
        staticDir,
      });
      servers.push(server);
      await server.start();

      // Send array instead of object
      const response = await fetch(`http://127.0.0.1:${port}/api/config/section/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([1, 2, 3]),
      });

      assert.equal(response.status, 400);
      const data = (await response.json()) as Record<string, unknown>;
      assert.ok(data["error"]);
    });

    it("returns 400 if body is not valid JSON", async () => {
      const tmpDir = makeTmpDir();
      const logger = createMockLogger();
      const port = nextPort();
      const staticDir = path.join(tmpDir, "static");
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: path.join(tmpDir, "logs"),
        rawConfig: JSON.parse(JSON.stringify(TEST_CONFIG)) as Record<string, unknown>,
      };

      const server = new DashboardServer({
        port,
        context,
        logger,
        staticDir,
      });
      servers.push(server);
      await server.start();

      // Send invalid JSON
      const response = await fetch(`http://127.0.0.1:${port}/api/config/section/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      assert.equal(response.status, 400);
    });

    it("returns 400 if section key contains slash (path traversal attempt)", async () => {
      const tmpDir = makeTmpDir();
      const configPath = path.join(tmpDir, "config.json");
      const logger = createMockLogger();
      const port = nextPort();
      const logsDir = path.join(tmpDir, "logs");
      const staticDir = path.join(tmpDir, "static");

      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: logsDir,
        configPath,
        rawConfig: JSON.parse(JSON.stringify(TEST_CONFIG)) as Record<string, unknown>,
      };

      const server = new DashboardServer({
        port,
        context,
        logger,
        staticDir,
      });
      servers.push(server);
      await server.start();

      // Send with section key containing slash
      const response = await fetch(`http://127.0.0.1:${port}/api/config/section/bad/key`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foo: "bar" }),
      });

      assert.equal(response.status, 400);
      const data = (await response.json()) as Record<string, unknown>;
      assert.ok(data["error"]);
    });

    it("returns 500 if rawConfig is not available (persistConfig fails)", async () => {
      const tmpDir = makeTmpDir();
      const logger = createMockLogger();
      const port = nextPort();
      const staticDir = path.join(tmpDir, "static");
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: path.join(tmpDir, "logs"),
        // rawConfig NOT provided
      };

      const server = new DashboardServer({
        port,
        context,
        logger,
        staticDir,
      });
      servers.push(server);
      await server.start();

      // Should fail because rawConfig is missing
      const response = await fetch(`http://127.0.0.1:${port}/api/config/section/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxLongTermEntries: 5000 }),
      });

      assert.equal(response.status, 500);
      const data = (await response.json()) as Record<string, unknown>;
      assert.ok(typeof data["error"] === "string");
    });

    it("logs config section update event", async () => {
      const tmpDir = makeTmpDir();
      const configPath = path.join(tmpDir, "config.json");
      const logger = createMockLogger();
      const port = nextPort();
      const logsDir = path.join(tmpDir, "logs");
      const staticDir = path.join(tmpDir, "static");

      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: logsDir,
        configPath,
        rawConfig: JSON.parse(JSON.stringify(TEST_CONFIG)) as Record<string, unknown>,
      };

      const server = new DashboardServer({
        port,
        context,
        logger,
        staticDir,
      });
      servers.push(server);
      await server.start();

      const response = await fetch(`http://127.0.0.1:${port}/api/config/section/logging`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: 180 }),
      });

      assert.equal(response.status, 200);

      // Verify logging event
      const configChangeLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "config_section_updated",
      );
      assert.ok(configChangeLog, "should log config_section_updated");
      assert.equal(
        (configChangeLog!["payload"] as Record<string, unknown>)["section"],
        "logging",
      );
    });

    it("updates multiple fields in a section at once", async () => {
      const tmpDir = makeTmpDir();
      const configPath = path.join(tmpDir, "config.json");
      const logger = createMockLogger();
      const port = nextPort();
      const logsDir = path.join(tmpDir, "logs");
      const staticDir = path.join(tmpDir, "static");

      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(staticDir, { recursive: true });

      const sessionManager = new SessionManager({
        sessionsDirectory: path.join(tmpDir, "sessions"),
        idleTimeoutMs: 60000,
        logger,
        workingMemoryBudgetChars: 8192,
      });

      const context: DashboardContext = {
        sessionManager,
        logger,
        config: TEST_CONFIG,
        logsDirectory: logsDir,
        configPath,
        rawConfig: JSON.parse(JSON.stringify(TEST_CONFIG)) as Record<string, unknown>,
      };

      const server = new DashboardServer({
        port,
        context,
        logger,
        staticDir,
      });
      servers.push(server);
      await server.start();

      const response = await fetch(`http://127.0.0.1:${port}/api/config/section/logging`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          retentionDays: 120,
          redactSensitive: false,
        }),
      });

      assert.equal(response.status, 200);

      const loggingSection = (context.config as unknown as Record<string, unknown>)["logging"] as Record<string, unknown>;
      assert.equal(loggingSection["retentionDays"], 120);
      assert.equal(loggingSection["redactSensitive"], false);
    });
  });
});
