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
import { setLongTermStore, setRetriever } from "./tools/built-in/memory.js";
import { TfIdfRetriever } from "./memory/retrieval.js";
import { LongTermStore } from "./memory/long-term-store.js";
import { SecretManager } from "./secrets/secret-manager.js";
import { seedFromConfig } from "./secrets/seed.js";
import type {
  BetterClawsConfig,
  InboundMessage,
  OutboundMessage,
  StreamableChannelAdapter,
  StreamableResponse,
} from "./types.js";
import { DashboardServer, type DashboardAdapterInfo } from "./dashboard/dashboard-server.js";
import { createAdapter } from "./adapters/adapter-factory.js";
import { McpClient, McpToolBridge } from "./mcp/index.js";
import { SkillLoader } from "./skills/index.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { sage, clay, lavender, rose, stone, amber, bold, dim } from "./utils/ansi.js";
import { renderMarkdown, StreamingMarkdownWriter } from "./utils/terminal-markdown.js";

// ── CLI Adapter ───────────────────────────────────────────────────────────────

const PROMPT_PLAIN = "you \u203A ";
const PROMPT_COLOR = clay(bold("you")) + clay(" \u203A ") ;
const BOT_PREFIX = sage(bold("bot")) + sage(" \u203A ");

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

class CliAdapter implements StreamableChannelAdapter {
  readonly id = "cli";
  readonly name = "CLI";
  private callback: ((msg: InboundMessage) => void) | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private activeStreams = 0;
  private streamChain: Promise<void> = Promise.resolve();
  private scrollRegionActive = false;

  /** Get terminal height, falling back to 24 rows. */
  private getRows(): number {
    return process.stdout.rows ?? 24;
  }

  /**
   * Activate a scroll region that reserves the bottom 2 lines for user input.
   * Output writes go into the scrollable area above; the prompt stays fixed.
   */
  private enterScrollRegion(): void {
    if (this.scrollRegionActive || !process.stdin.isTTY) return;
    const rows = this.getRows();
    // Set scroll region to rows 1..(rows-2), leaving 2 lines for prompt + separator
    process.stdout.write(`\x1b[1;${rows - 2}r`);
    // Move cursor into the scroll region
    process.stdout.write(`\x1b[${rows - 2};1H`);
    // Draw separator and prompt on fixed bottom lines
    this.drawInputArea();
    // Move cursor back into scroll region for output
    process.stdout.write(`\x1b[${rows - 2};1H`);
    this.scrollRegionActive = true;
  }

  /** Reset scroll region to full terminal. */
  private exitScrollRegion(): void {
    if (!this.scrollRegionActive) return;
    process.stdout.write("\x1b[?25h"); // ensure cursor visible
    // Reset scroll region to full terminal
    process.stdout.write("\x1b[r");
    // Move to bottom
    const rows = this.getRows();
    process.stdout.write(`\x1b[${rows};1H`);
    // Clear the separator and old prompt lines
    process.stdout.write("\x1b[2K");
    process.stdout.write(`\x1b[${rows - 1};1H\x1b[2K`);
    this.scrollRegionActive = false;
  }

  /** Draw the fixed input area on the bottom 2 lines (separator + prompt). */
  private drawInputArea(): void {
    const rows = this.getRows();
    // Save cursor position in scroll region
    process.stdout.write("\x1b[s");
    // Move to separator line (row - 1) and draw thin divider
    process.stdout.write(`\x1b[${rows - 1};1H\x1b[2K`);
    const cols = process.stdout.columns ?? 80;
    process.stdout.write(stone(dim("\u2500".repeat(cols))));
    // Move to input line (bottom row) and draw prompt
    process.stdout.write(`\x1b[${rows};1H\x1b[2K`);
    process.stdout.write(PROMPT_COLOR);
    // Restore cursor to scroll region
    process.stdout.write("\x1b[u");
  }

  /** Refresh the prompt text on the input line (during streaming). */
  private refreshInputLine(): void {
    if (!this.scrollRegionActive) return;
    const rows = this.getRows();
    const currentLine = (this.rl as unknown as { line: string }).line ?? "";
    process.stdout.write("\x1b[s");
    process.stdout.write(`\x1b[${rows};1H\x1b[2K`);
    process.stdout.write(PROMPT_COLOR + currentLine);
    process.stdout.write("\x1b[u");
  }

  /** Display the colored prompt. Readline gets the plain version for cursor math. */
  private showPrompt(): void {
    this.rl?.setPrompt(PROMPT_PLAIN);
    this.rl?.prompt();
    process.stdout.write("\r" + PROMPT_COLOR);
  }

  /** Re-apply colored prompt after readline redraws (e.g. on backspace). */
  private recolorPrompt(): void {
    process.stdout.write("\x1b[s\x1b[0G" + PROMPT_COLOR + "\x1b[u");
  }

  private hintLines = 0;

  private clearHint(): void {
    if (this.hintLines === 0) return;
    let seq = "";
    for (let i = 0; i < this.hintLines; i++) seq += "\x1b[1B\x1b[2K";
    for (let i = 0; i < this.hintLines; i++) seq += "\x1b[1A";
    process.stdout.write(seq);
    this.hintLines = 0;
  }

  private showHint(): void {
    const line = (this.rl as unknown as { line: string }).line ?? "";
    this.clearHint();
    if (!line.startsWith("/") || line.includes(" ") || line.length === 0) return;

    const q = line.toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
    if (matches.length === 0) return;

    const hintItems = matches.slice(0, 4);
    // Save cursor, move down, write hints, restore cursor
    const hint = hintItems
      .map((c) => stone(`  ${c.name}`) + (c.args ? stone(dim(` ${c.args}`)) : "") + stone(dim(` — ${c.description}`)))
      .join("\n");
    process.stdout.write("\x1b[s\n" + hint + "\x1b[u");
    this.hintLines = hintItems.length;
  }

  /** Start an animated spinner. Returns a function that stops and clears it. */
  private startSpinner(label: string): () => void {
    let frame = 0;
    if (this.scrollRegionActive) process.stdout.write("\x1b[?25l"); // hide cursor
    const id = setInterval(() => {
      const char = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "⠋";
      process.stdout.write(`\r\x1b[2K  ${stone(char)} ${stone(dim(label))}`);
      frame++;
    }, 80);
    // Write first frame immediately
    process.stdout.write(`\r\x1b[2K  ${stone("⠋")} ${stone(dim(label))}`);
    return () => {
      clearInterval(id);
      process.stdout.write("\r\x1b[2K");
      if (this.scrollRegionActive) process.stdout.write("\x1b[?25h"); // show cursor
    };
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

    // Update scroll region on terminal resize
    if (process.stdout.isTTY) {
      process.stdout.on("resize", () => {
        if (this.scrollRegionActive) {
          const rows = this.getRows();
          process.stdout.write(`\x1b[1;${rows - 2}r`);
          this.drawInputArea();
        }
      });
    }

    // Re-apply prompt color and show command hints as user types
    if (process.stdin.isTTY) {
      process.stdin.on("data", () => {
        setImmediate(() => {
          if (this.scrollRegionActive) {
            this.refreshInputLine();
            return;
          }
          this.recolorPrompt();
          this.showHint();
        });
      });
    }

    this.showPrompt();

    this.rl.on("line", (line) => {
      this.clearHint();
      const text = line.trim();
      if (!text) {
        if (this.scrollRegionActive) {
          this.refreshInputLine();
        } else {
          this.showPrompt();
        }
        return;
      }

      // During streaming, clear the input line after submit and redraw prompt
      if (this.scrollRegionActive) {
        this.refreshInputLine();
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
    this.activeStreams++;
    const prev = this.streamChain;
    this.streamChain = prev.then(() =>
      this.doSendStream(_channelId, response).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(rose(`  stream error: ${msg}`) + "\n");
      })
    );
    await this.streamChain;
    this.activeStreams--;
  }

  private async doSendStream(_channelId: string, response: StreamableResponse): Promise<void> {
    this.enterScrollRegion();

    let wrotePrefix = false;
    const md = new StreamingMarkdownWriter((text) => {
      if (!wrotePrefix) {
        process.stdout.write("\n" + BOT_PREFIX);
        wrotePrefix = true;
      }
      process.stdout.write(text);
    });

    let stopProcessing: (() => void) | null = this.startSpinner("Processing...");
    let stopThinking: (() => void) | null = null;

    const clearSpinners = (): void => {
      if (stopProcessing) { stopProcessing(); stopProcessing = null; }
      if (stopThinking) { stopThinking(); stopThinking = null; }
    };

    try {
      for await (const event of response.stream) {
        switch (event.type) {
          case "text-delta":
            clearSpinners();
            md.push(event.delta);
            break;

          case "reasoning-delta":
            if (stopProcessing) { stopProcessing(); stopProcessing = null; }
            if (!stopThinking) {
              stopThinking = this.startSpinner("Thinking...");
            }
            break;

          case "tool-start":
            clearSpinners();
            md.flush();
            process.stdout.write("\n" + lavender(dim("  \u27E1 " + event.toolCall.function.name + "...")) + "\n");
            wrotePrefix = false;
            // Restart processing spinner while tool executes
            stopProcessing = this.startSpinner("Processing...");
            break;

          case "tool-result":
            if (stopProcessing) { stopProcessing(); stopProcessing = null; }
            if (event.error) {
              process.stdout.write(rose("  \u2717 " + event.toolName + " failed") + "\n");
            } else {
              process.stdout.write(lavender(dim("  \u2713 " + event.toolName)) + "\n");
            }
            wrotePrefix = false;
            break;

          case "warning":
            clearSpinners();
            md.flush();
            process.stdout.write("\n" + amber("  \u26A0 " + event.message) + "\n");
            wrotePrefix = false;
            break;

          case "error":
            clearSpinners();
            md.flush();
            process.stdout.write("\n" + rose(bold("  error ")) + rose(event.message) + "\n");
            break;

          case "reset":
            clearSpinners();
            md.flush();
            // Clear terminal and move cursor home
            process.stdout.write("\x1b[2J\x1b[H");
            wrotePrefix = false;
            break;

          case "done": {
            clearSpinners();
            md.flush();
            if (event.context) {
              const used = event.context.actualTokens ?? event.context.estimatedTokens;
              const usedK = (used / 1000).toFixed(1);
              const maxK = (event.context.budget / 1000).toFixed(1);
              process.stdout.write(stone(dim(`  ${usedK}k / ${maxK}k context`)) + "\n");
            }
            break;
          }
        }
      }
    } finally {
      clearSpinners();
      md.flush();
      this.exitScrollRegion();
    }

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
    workingMemoryBudgetChars: config.memory.workingMemoryBudgetChars,
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

  // ── Long-term memory store ──────────────────────────────────────────────
  const longTermStore = new LongTermStore({
    directory: "data/memory",
    config: config.memory,
    logger,
  });
  await longTermStore.load();
  setLongTermStore(longTermStore);
  setRetriever(new TfIdfRetriever({ store: longTermStore }));

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
  const adapterInfos: DashboardAdapterInfo[] = [];

  const ADAPTER_TYPES: Record<string, DashboardAdapterInfo["type"]> = {
    telegram: "polling",
    discord: "websocket",
    slack: "websocket",
    signal: "polling",
    webhook: "http-server",
    webchat: "http-server",
  };

  for (const [name, adapterConfig] of Object.entries(config.adapters)) {
    const info: DashboardAdapterInfo = {
      id: name,
      name: name.charAt(0).toUpperCase() + name.slice(1),
      enabled: adapterConfig.enabled,
      type: ADAPTER_TYPES[name] ?? "internal",
      connected: adapterConfig.enabled,
      host: adapterConfig.host,
      port: adapterConfig.port,
      path: adapterConfig.path,
      url: name === "webchat" && adapterConfig.enabled
        ? `http://${adapterConfig.host ?? "127.0.0.1"}:${adapterConfig.port ?? 18702}`
        : name === "webhook" && adapterConfig.enabled
          ? `http://${adapterConfig.host ?? "127.0.0.1"}:${adapterConfig.port}${adapterConfig.path ?? "/webhook"}`
          : undefined,
    };
    adapterInfos.push(info);

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
        adapterInfos,
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
