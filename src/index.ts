import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, resolveWeakLlmConfig, saveConfig } from "./config.js";
import { StructuredLogger } from "./logger/structured-logger.js";
import { LlmClient } from "./llm/llm-client.js";
import { ToolRegistry } from "./tools/registry.js";
import { CapabilityGate } from "./tools/capability-gate.js";
import { ToolExecutor } from "./tools/executor.js";
import { SessionManager } from "./sessions/session-manager.js";
import { SessionCompactor } from "./sessions/compactor.js";
import { MessageRouter, SYSTEM_PROMPT, SLASH_COMMANDS } from "./router/message-router.js";
import { PromptBuilder } from "./prompt/prompt-builder.js";
import { join } from "node:path";
import { builtInTools } from "./tools/built-in/index.js";
import { SecretManager } from "./secrets/secret-manager.js";
import { seedFromConfig } from "./secrets/seed.js";
import type {
  BetterClawsConfig,
  InboundMessage,
  OutboundMessage,
  StreamableChannelAdapter,
  StreamableResponse,
} from "./types.js";
import { DashboardServer } from "./dashboard/dashboard-server.js";
import { createAdapter } from "./adapters/adapter-factory.js";
import { McpClient, McpToolBridge } from "./mcp/index.js";
import { SkillLoader } from "./skills/index.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { sage, clay, lavender, rose, stone, bold, dim } from "./utils/ansi.js";
import { renderMarkdown, StreamingMarkdownWriter } from "./utils/terminal-markdown.js";

// ── CLI Adapter ───────────────────────────────────────────────────────────────

const PROMPT_PLAIN = "you \u203A ";
const PROMPT_COLOR = clay(bold("you")) + clay(" \u203A ") ;
const BOT_PREFIX = sage(bold("bot")) + sage(" \u203A ");

class CliAdapter implements StreamableChannelAdapter {
  readonly id = "cli";
  readonly name = "CLI";
  private callback: ((msg: InboundMessage) => void) | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;

  /** Display the colored prompt. Readline gets the plain version for cursor math. */
  private showPrompt(): void {
    this.rl?.setPrompt(PROMPT_PLAIN);
    this.rl?.prompt();
    process.stdout.write("\r" + PROMPT_COLOR);
  }

  private hintVisible = false;

  private clearHint(): void {
    if (!this.hintVisible) return;
    // Move down one line, clear it, move back up
    process.stdout.write("\x1b[1B\x1b[2K\x1b[1A");
    this.hintVisible = false;
  }

  private showHint(): void {
    const line = (this.rl as unknown as { line: string }).line ?? "";
    this.clearHint();
    if (!line.startsWith("/") || line.includes(" ") || line.length === 0) return;

    const q = line.toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
    if (matches.length === 0) return;

    // Save cursor, move down, write hints, restore cursor
    const hint = matches
      .slice(0, 4)
      .map((c) => stone(`  ${c.name}`) + (c.args ? stone(dim(` ${c.args}`)) : "") + stone(dim(` — ${c.description}`)))
      .join("\n");
    process.stdout.write("\x1b[s\n" + hint + "\x1b[u");
    this.hintVisible = true;
  }

  async start(): Promise<void> {
    const commandNames = SLASH_COMMANDS.map((c) => c.name);

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: PROMPT_PLAIN,
      completer: (line: string): [string[], string] => {
        if (!line.startsWith("/")) return [[], line];
        const hits = commandNames.filter((n) => n.startsWith(line));
        return [hits, line];
      },
    });

    // Show command hints as user types
    if (process.stdin.isTTY) {
      process.stdin.on("data", () => {
        setImmediate(() => this.showHint());
      });
    }

    this.showPrompt();

    this.rl.on("line", (line) => {
      this.clearHint();
      const text = line.trim();
      if (!text) {
        this.showPrompt();
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
    const rendered = renderMarkdown(message.text);
    process.stdout.write("\n" + BOT_PREFIX + rendered + "\n\n");
    this.showPrompt();
  }

  async sendStream(_channelId: string, response: StreamableResponse): Promise<void> {
    let wrotePrefix = false;
    const md = new StreamingMarkdownWriter((text) => {
      if (!wrotePrefix) {
        process.stdout.write("\n" + BOT_PREFIX);
        wrotePrefix = true;
      }
      process.stdout.write(text);
    });

    for await (const event of response.stream) {
      switch (event.type) {
        case "text-delta":
          md.push(event.delta);
          break;

        case "tool-start":
          md.flush();
          process.stdout.write("\n" + lavender(dim("  \u27E1 " + event.toolCall.function.name + "...")) + "\n");
          wrotePrefix = false;
          break;

        case "tool-result":
          if (event.error) {
            process.stdout.write(rose("  \u2717 " + event.toolName + " failed") + "\n");
          } else {
            process.stdout.write(lavender(dim("  \u2713 " + event.toolName)) + "\n");
          }
          wrotePrefix = false;
          break;

        case "error":
          md.flush();
          process.stdout.write("\n" + rose(bold("  error ")) + rose(event.message) + "\n");
          break;

        case "done": {
          const total = event.usage.promptTokens + event.usage.completionTokens;
          if (total > 0) {
            process.stdout.write(stone(dim("  " + total + " tokens")) + "\n");
          }
          break;
        }

        case "reasoning-delta":
          // Not displayed in CLI
          break;
      }
    }

    md.flush();
    process.stdout.write("\n\n");
    this.showPrompt();
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

  // Track tool sources for dashboard display
  const toolSources = new Map<string, "built-in" | "plugin" | "mcp" | "skill">();
  for (const tool of builtInTools) {
    toolSources.set(tool.descriptor.name, "built-in");
  }
  // Plugin tools are loaded by toolRegistry.loadTools() — any tool not in builtInTools is a plugin
  for (const desc of toolRegistry.getDescriptors()) {
    if (!toolSources.has(desc.name)) toolSources.set(desc.name, "plugin");
  }

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
          toolSources.set(tool.descriptor.name, "mcp");
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
          toolSources.set(tool.descriptor.name, "skill");
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

  const recoveredCount = await sessionManager.recover();
  if (recoveredCount > 0) {
    logger.log({
      sessionId: null,
      eventType: "session:recover",
      component: "session",
      payload: { action: "startup_recovery", count: recoveredCount },
    });
  }

  const compactionCfg = config.compaction;
  const compactor = compactionCfg?.enabled
    ? new SessionCompactor({ sessionManager, llmClient, weakLlmClient: weakLlmClient ?? undefined, compactionConfig: compactionCfg, logger })
    : undefined;
  const promptBuilder = new PromptBuilder({
    systemPrompt: SYSTEM_PROMPT,
    tokenBudget: compactionCfg?.tokenBudget ?? config.llm.maxTokens,
    persona: config.systemContext?.persona,
    userContext: config.systemContext?.userContext,
  });

  // ── Scheduler ───────────────────────────────────────────────────────────
  const scheduler = new Scheduler({
    schedules: config.schedules ?? [],
    logger,
    configPath: options?.configPath,
    rawConfig: options?.rawConfig,
    saveConfig,
  });

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
    scheduler,
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

  router.registerAdapter(scheduler);

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
        toolDescriptors: toolRegistry.getDescriptors().map(d => ({
          name: d.name,
          description: d.description,
          capabilities: d.capabilities as unknown as readonly string[],
          source: toolSources.get(d.name) ?? "built-in",
        })),
        configPath: options?.configPath,
        rawConfig: options?.rawConfig,
        scheduler,
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
      await scheduler.stop();
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

  // ── Welcome banner ─────────────────────────────────────────────────────
  process.stdout.write("\n");
  process.stdout.write("  " + sage(bold("betterClaws")) + " " + dim("v0.1.0") + "\n");
  process.stdout.write("  " + stone("\u2500".repeat(22)) + "\n");

  const label = (key: string, value: string) =>
    "  " + stone(key.padEnd(12)) + value + "\n";

  process.stdout.write(label("Model", config.llm.model));
  if (config.llm.weak) {
    const weak = resolveWeakLlmConfig(config.llm)!;
    process.stdout.write(label("Model " + dim("(weak)"), weak.model));
  }
  process.stdout.write(label("Config", configPath ?? "config/betterclaws.json"));

  const { router, dashboard, adapterNames, stop } = await createApp(config, {
    dashboard: dashboardFlag || undefined,
    configPath: resolvedConfigPath,
    rawConfig,
  });

  if (dashboard) {
    const dashCfg = config.dashboard ?? { host: "127.0.0.1", port: 18701 };
    process.stdout.write(label("Dashboard", `http://${dashCfg.host}:${dashCfg.port}`));
  }

  process.stdout.write(label("Adapters", adapterNames.length > 0 ? adapterNames.join(", ") : dim("none")));
  process.stdout.write("\n  " + stone("Type a message to chat. Ctrl+C to quit.") + "\n\n");

  const cliAdapter = new CliAdapter();
  router.registerAdapter(cliAdapter);
  await router.start();

  const shutdown = async () => {
    process.stdout.write("\n" + stone(dim("Shutting down...")) + "\n");
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
