import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { StructuredLogger } from "./logger/structured-logger.js";
import { LlmClient } from "./llm/llm-client.js";
import { ToolRegistry } from "./tools/registry.js";
import { CapabilityGate } from "./tools/capability-gate.js";
import { ToolExecutor } from "./tools/executor.js";
import { SessionManager } from "./sessions/session-manager.js";
import { MessageRouter } from "./router/message-router.js";
import { join } from "node:path";
import { builtInTools } from "./tools/built-in/index.js";
import { SecretManager } from "./secrets/secret-manager.js";
import { seedFromConfig } from "./secrets/seed.js";
import { fileURLToPath } from "node:url";
import type {
  BetterClawsConfig,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "./types.js";
import { DashboardServer } from "./dashboard/dashboard-server.js";
import { createAdapter } from "./adapters/adapter-factory.js";

// ── CLI Adapter ───────────────────────────────────────────────────────────────

class CliAdapter implements ChannelAdapter {
  readonly id = "cli";
  readonly name = "CLI";
  private callback: ((msg: InboundMessage) => void) | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;

  async start(): Promise<void> {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "you> ",
    });

    this.rl.prompt();

    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }

      const msg: InboundMessage = {
        id: randomUUID(),
        adapterId: "cli",
        channelId: "cli:local",
        senderId: "local-user",
        text,
        timestamp: Date.now(),
      };

      this.callback?.(msg);
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  onMessage(callback: (msg: InboundMessage) => void): void {
    this.callback = callback;
  }

  async send(_channelId: string, message: OutboundMessage): Promise<void> {
    process.stdout.write(`\nbot> ${message.text}\n\n`);
    this.rl?.prompt();
  }
}

// ── App Factory ───────────────────────────────────────────────────────────────

export async function createApp(config: BetterClawsConfig, options?: { dashboard?: boolean }): Promise<{
  router: MessageRouter;
  dashboard: DashboardServer | null;
  stop: () => Promise<void>;
}> {
  const logger = new StructuredLogger({
    directory: config.logging.directory,
    redactSensitive: config.logging.redactSensitive,
  });

  const secretManager = new SecretManager({ logger });
  seedFromConfig(secretManager, config);

  const llmClient = new LlmClient({
    baseUrl: config.llm.baseUrl,
    secretManager,
    model: config.llm.model,
    maxTokens: config.llm.maxTokens,
    temperature: config.llm.temperature,
    logger,
  });

  const toolRegistry = new ToolRegistry({
    builtInTools,
    pluginDirectory: "tools",
    logger,
  });

  await toolRegistry.loadTools();

  const capabilityGate = new CapabilityGate({
    defaultPolicy: config.security.defaultCapabilityPolicy,
    logger,
  });

  const executor = new ToolExecutor({
    scratchBaseDir: "data/scratch",
    defaultTimeout: config.security.sandboxTimeout,
    stripEnvironment: config.security.stripEnvironment,
    logger,
  });

  const sessionManager = new SessionManager({
    sessionsDirectory: "data/sessions",
    idleTimeoutMs: 30 * 60 * 1000, // 30 minutes
    logger,
  });

  const router = new MessageRouter({
    sessionManager,
    llmClient,
    toolRegistry,
    capabilityGate,
    executor,
    secretManager,
    logger,
  });

  // ── Config-driven adapters ───────────────────────────────────────────────
  for (const [name, adapterConfig] of Object.entries(config.adapters)) {
    if (adapterConfig.enabled) {
      const adapter = createAdapter(name, adapterConfig, logger);
      router.registerAdapter(adapter);
    }
  }

  // ── Dashboard ────────────────────────────────────────────────────────────
  const dashboardEnabled = options?.dashboard ?? config.dashboard?.enabled ?? false;
  let dashboard: DashboardServer | null = null;

  if (dashboardEnabled) {
    const dashCfg = config.dashboard ?? { enabled: true, host: "127.0.0.1", port: 18701 };
    const srcDir = fileURLToPath(new URL(".", import.meta.url));
    const staticDir = join(srcDir, "dashboard", "public");

    dashboard = new DashboardServer({
      host: dashCfg.host,
      port: dashCfg.port,
      staticDir,
      logger,
      context: {
        sessionManager,
        logger,
        config,
        logsDirectory: config.logging.directory,
        memoryDirectory: "data/memory",
      },
    });

    await dashboard.start();
  }

  return {
    router,
    dashboard,
    stop: async () => {
      await dashboard?.stop();
      await router.stop();
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configFlagIndex = process.argv.indexOf("--config");
  const configPath = configFlagIndex !== -1 ? process.argv[configFlagIndex + 1] : undefined;
  const config = await loadConfig(configPath);
  const dashboardFlag = process.argv.includes("--dashboard");

  console.log(`betterClaws v0.1.0`);
  console.log(`Config: ${configPath ?? "config/betterclaws.json"}`);
  console.log(`LLM: ${config.llm.model} @ ${config.llm.baseUrl}`);

  const { router, dashboard, stop } = await createApp(config, { dashboard: dashboardFlag });

  if (dashboard) {
    const dashCfg = config.dashboard ?? { host: "127.0.0.1", port: 18701 };
    console.log(`Dashboard: http://${dashCfg.host}:${dashCfg.port}`);
  }

  console.log(`Type a message to chat. Ctrl+C to quit.\n`);

  const cliAdapter = new CliAdapter();
  router.registerAdapter(cliAdapter);
  await router.start();

  const shutdown = async () => {
    console.log("\nShutting down...");
    await stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
