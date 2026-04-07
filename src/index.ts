import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, resolveWeakLlmConfig } from "./config.js";
import { StructuredLogger } from "./logger/structured-logger.js";
import { LlmClient } from "./llm/llm-client.js";
import { ToolRegistry } from "./tools/registry.js";
import { CapabilityGate } from "./tools/capability-gate.js";
import { ToolExecutor } from "./tools/executor.js";
import { SessionManager } from "./sessions/session-manager.js";
import { SessionCompactor } from "./sessions/compactor.js";
import { MessageRouter, SYSTEM_PROMPT } from "./router/message-router.js";
import { PromptBuilder } from "./prompt/prompt-builder.js";
import { join } from "node:path";
import { builtInTools } from "./tools/built-in/index.js";
import { SecretManager } from "./secrets/secret-manager.js";
import { seedFromConfig } from "./secrets/seed.js";
import type {
  BetterClawsConfig,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "./types.js";
import { DashboardServer } from "./dashboard/dashboard-server.js";
import { createAdapter } from "./adapters/adapter-factory.js";
import { McpClient, McpToolBridge } from "./mcp/index.js";
import { SkillLoader } from "./skills/index.js";

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

export async function createApp(config: BetterClawsConfig, options?: {
  dashboard?: boolean;
  configPath?: string;
  rawConfig?: Record<string, unknown>;
}): Promise<{
  router: MessageRouter;
  dashboard: DashboardServer | null;
  adapterNames: readonly string[];
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

  const resolvedWeak = resolveWeakLlmConfig(config.llm);
  const weakLlmClient = resolvedWeak
    ? new LlmClient({
        baseUrl: resolvedWeak.baseUrl,
        secretManager,
        secretKey: "llm:weak:apiKey",
        model: resolvedWeak.model,
        maxTokens: resolvedWeak.maxTokens,
        temperature: resolvedWeak.temperature,
        logger,
      })
    : null;

  const toolRegistry = new ToolRegistry({
    builtInTools,
    pluginDirectory: "tools",
    logger,
    toolPolicies: config.tools?.toolPolicies,
  });

  await toolRegistry.loadTools();

  // ── MCP servers ──────────────────────────────────────────────────────────
  const mcpClients: McpClient[] = [];

  if (config.tools?.mcpServers) {
    for (const [name, serverConfig] of Object.entries(config.tools.mcpServers)) {
      try {
        const client = new McpClient(name, serverConfig, logger);
        await client.connect();
        mcpClients.push(client);

        const bridge = new McpToolBridge(client, name, serverConfig, logger);
        const tools = await bridge.discoverTools();
        for (const tool of tools) {
          toolRegistry.register(tool);
        }

        logger.log({
          sessionId: null,
          eventType: "config:change",
          component: "mcp",
          payload: { action: "server_ready", server: name, toolCount: tools.length },
        });
      } catch (err) {
        logger.log({
          sessionId: null,
          eventType: "config:change",
          component: "mcp",
          payload: {
            action: "server_failed",
            server: name,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  // ── Skills ───────────────────────────────────────────────────────────────
  if (config.tools?.skills) {
    const skillLoader = new SkillLoader(logger);
    for (const [name, skillConfig] of Object.entries(config.tools.skills)) {
      try {
        const tools = await skillLoader.loadSkill(name, skillConfig);
        for (const tool of tools) {
          toolRegistry.register(tool);
        }

        logger.log({
          sessionId: null,
          eventType: "config:change",
          component: "skills",
          payload: { action: "skill_loaded", skill: name, toolCount: tools.length },
        });
      } catch (err) {
        logger.log({
          sessionId: null,
          eventType: "config:change",
          component: "skills",
          payload: {
            action: "skill_failed",
            skill: name,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

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

  const compactionCfg = config.compaction;
  const compactor = compactionCfg?.enabled
    ? new SessionCompactor({ sessionManager, llmClient, weakLlmClient: weakLlmClient ?? undefined, compactionConfig: compactionCfg, logger })
    : undefined;
  const promptBuilder = compactionCfg?.enabled
    ? new PromptBuilder({ systemPrompt: SYSTEM_PROMPT, tokenBudget: compactionCfg.tokenBudget })
    : undefined;

  const router = new MessageRouter({
    sessionManager,
    llmClient,
    toolRegistry,
    capabilityGate,
    executor,
    secretManager,
    logger,
    config,
    compactor,
    promptBuilder,
  });

  // ── Config-driven adapters ───────────────────────────────────────────────
  const adapterNames: string[] = [];
  for (const [name, adapterConfig] of Object.entries(config.adapters)) {
    if (adapterConfig.enabled) {
      const adapter = createAdapter(name, adapterConfig, logger);
      router.registerAdapter(adapter);
      adapterNames.push(adapter.name);
    }
  }

  // ── Dashboard ────────────────────────────────────────────────────────────
  const dashboardEnabled = options?.dashboard ?? config.dashboard?.enabled ?? false;
  let dashboard: DashboardServer | null = null;

  if (dashboardEnabled) {
    const dashCfg = config.dashboard ?? { enabled: true, host: "127.0.0.1", port: 18701 };
    const staticDir = join(process.cwd(), "src", "dashboard", "public");

    dashboard = new DashboardServer({
      host: dashCfg.host,
      port: dashCfg.port,
      staticDir,
      logger,
      authToken: dashCfg.authToken,
      context: {
        sessionManager,
        logger,
        config,
        logsDirectory: config.logging.directory,
        memoryDirectory: "data/memory",
        configPath: options?.configPath,
        rawConfig: options?.rawConfig,
      },
    });

    await dashboard.start();
  }

  return {
    router,
    dashboard,
    adapterNames,
    stop: async () => {
      await dashboard?.stop();
      await router.stop();
      for (const client of mcpClients) {
        await client.disconnect();
      }
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configFlagIndex = process.argv.indexOf("--config");
  const configPath = configFlagIndex !== -1 ? process.argv[configFlagIndex + 1] : undefined;
  const config = await loadConfig(configPath);
  const dashboardFlag = process.argv.includes("--dashboard");

  // Load raw config for dashboard editing (before env resolution)
  const resolvedConfigPath = resolve(configPath ?? "config/betterclaws.json");
  let rawConfig: Record<string, unknown> = {};
  try {
    const raw = await readFile(resolvedConfigPath, "utf-8");
    rawConfig = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Config file may not exist — start with empty object
  }

  console.log(`betterClaws v0.1.0`);
  console.log(`Config: ${configPath ?? "config/betterclaws.json"}`);
  console.log(`LLM: ${config.llm.model} @ ${config.llm.baseUrl}`);
  if (config.llm.weak) {
    const weak = resolveWeakLlmConfig(config.llm)!;
    console.log(`LLM (weak): ${weak.model} @ ${weak.baseUrl}`);
  }

  const { router, dashboard, adapterNames, stop } = await createApp(config, {
    dashboard: dashboardFlag || undefined,
    configPath: resolvedConfigPath,
    rawConfig,
  });

  if (dashboard) {
    const dashCfg = config.dashboard ?? { host: "127.0.0.1", port: 18701 };
    console.log(`Dashboard: http://${dashCfg.host}:${dashCfg.port}`);
  }

  if (adapterNames.length > 0) {
    console.log(`Adapters: ${adapterNames.join(", ")}`);
  } else {
    console.log(`Adapters: none configured`);
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
