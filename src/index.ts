import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, resolveWeakLlmConfig, saveConfig, deriveLocalConfigPath } from "./config.js";
import { StructuredLogger } from "./logger/structured-logger.js";
import { LlmClient } from "./llm/llm-client.js";
import { ToolRegistry } from "./tools/registry.js";
import { CapabilityGate } from "./tools/capability-gate.js";
import { CompositeExecutor } from "./tools/composite-executor.js";
import { SessionManager } from "./sessions/session-manager.js";
import { SessionCompactor } from "./sessions/compactor.js";
import { MessageRouter, SYSTEM_PROMPT } from "./router/message-router.js";
import { ConfirmationBroker } from "./router/confirmation-broker.js";
import { PromptBuilder } from "./prompt/prompt-builder.js";
import { join } from "node:path";
import { builtInTools } from "./tools/built-in/index.js";
import { setLongTermStore, setRetriever } from "./tools/built-in/memory.js";
import { TfIdfRetriever } from "./memory/retrieval.js";
import { LongTermStore } from "./memory/long-term-store.js";
import { SecretManager } from "./secrets/secret-manager.js";
import { seedFromConfig } from "./secrets/seed.js";
import { toErrorMessage } from "./utils/errors.js";
import type { BetterClawsConfig } from "./types.js";
import { DashboardServer, type DashboardAdapterInfo } from "./dashboard/dashboard-server.js";
import { createAdapter } from "./adapters/adapter-factory.js";
import { CliAdapter } from "./adapters/cli/cli-adapter.js";
import { McpClient, McpToolBridge } from "./mcp/index.js";
import { SkillLoader } from "./skills/index.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { SuggestionStore } from "./suggestions/suggestion-store.js";
import { SuggestionWorker } from "./suggestions/suggestion-worker.js";
import { CurationWorker } from "./memory/curation-worker.js";
import { AgendaStore } from "./memory/agenda-store.js";
import { ReflectionJob } from "./router/reflection-job.js";
import { setAgendaStore } from "./tools/built-in/agenda.js";
import { sage, stone, bold, dim, glyphs } from "./utils/ansi.js";

// ── App Factory ───────────────────────────────────────────────────────────────

export async function createApp(config: BetterClawsConfig, options?: {
  dashboard?: boolean;
  configPath?: string;
  rawConfig?: Record<string, unknown>;
  localConfigPath?: string;
  rawLocalConfig?: Record<string, unknown>;
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
            error: toErrorMessage(err),
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
            error: toErrorMessage(err),
          },
        });
      }
    }
  }

  const capabilityGate = new CapabilityGate({
    defaultPolicy: config.security.defaultCapabilityPolicy,
    logger,
  });

  const executor = new CompositeExecutor({
    scratchBaseDir: "data/scratch",
    defaultTimeout: config.security.sandboxTimeout,
    stripEnvironment: config.security.stripEnvironment,
    maxMemoryMb: config.security.maxMemoryMb,
    useForkedExecution: config.security.useForkedExecution,
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
  const retriever = new TfIdfRetriever({ store: longTermStore });
  setRetriever(retriever);

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

  // ── Agenda & Reflection ──────────────────────────────────────────────────
  const agendaStore = new AgendaStore(join("data", "memory", "agenda.jsonl"), logger);
  await agendaStore.load();
  setAgendaStore(agendaStore);

  const reflectionLlmClient = weakLlmClient ?? llmClient;
  const reflectionJob = new ReflectionJob(
    reflectionLlmClient,
    agendaStore,
    longTermStore,
    logger,
    config.reflect ?? {},
  );

  // ── Scheduler ───────────────────────────────────────────────────────────
  const scheduler = new Scheduler({
    schedules: config.schedules ?? [],
    logger,
    configPath: options?.configPath,
    rawConfig: options?.rawConfig,
    saveConfig,
  });

  const confirmationBroker = new ConfirmationBroker(
    logger,
    config.security.confirmationTimeoutMs ?? 120_000,
  );

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
    confirmationBroker,
    scheduler,
    agendaStore,
    reflectionJob,
    retriever,
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
    const effectiveHost = adapterConfig.host ?? config.gateway.host;
    const resolvedConfig = { ...adapterConfig, host: effectiveHost };
    const info: DashboardAdapterInfo = {
      id: name,
      name: name.charAt(0).toUpperCase() + name.slice(1),
      enabled: adapterConfig.enabled,
      type: ADAPTER_TYPES[name] ?? "internal",
      connected: adapterConfig.enabled,
      host: effectiveHost,
      port: adapterConfig.port,
      path: adapterConfig.path,
      url: name === "webchat" && adapterConfig.enabled
        ? `http://${effectiveHost}:${adapterConfig.port ?? 18702}`
        : name === "webhook" && adapterConfig.enabled
          ? `http://${effectiveHost}:${adapterConfig.port}${adapterConfig.path ?? "/webhook"}`
          : undefined,
    };
    adapterInfos.push(info);

    if (adapterConfig.enabled) {
      const adapter = createAdapter(name, resolvedConfig, logger);
      router.registerAdapter(adapter);
      adapterNames.push(adapter.name);
    }
  }

  router.registerAdapter(scheduler);

  // ── Suggestions ──────────────────────────────────────────────────────────
  const suggestionsConfig = config.suggestions ?? { enabled: false, intervalMinutes: 120, maxLlmCallsPerCycle: 2 };


  const suggestionStore = new SuggestionStore({
    directory: "data/suggestions",
    logger,
  });
  await suggestionStore.load();

  // Use weak LLM if available, otherwise primary
  const suggestionLlmClient = weakLlmClient ?? llmClient;
  const suggestionWorker = new SuggestionWorker({
    store: suggestionStore,
    memoryStore: longTermStore,
    llmClient: suggestionLlmClient,
    config: suggestionsConfig,
    appConfig: config,
    logger,
    logsDirectory: config.logging.directory,
  });
  await suggestionWorker.start();

  // ── Curation ───────────────────────────────────────────────────────────
  const curationLlmClient = weakLlmClient ?? llmClient;
  const curationWorker = new CurationWorker({
    store: longTermStore,
    sessionManager,
    llmClient: curationLlmClient,
    config: config.memory,
    logger,
  });
  await curationWorker.start();

  // ── Dashboard ────────────────────────────────────────────────────────────
  const dashboardEnabled = options?.dashboard ?? config.dashboard?.enabled ?? false;
  let dashboard: DashboardServer | null = null;

  if (dashboardEnabled) {
    const dashCfg = config.dashboard ?? { enabled: true, host: undefined, port: 18701, authToken: undefined };
    const dashHost = dashCfg.host ?? config.gateway.host;
    const staticDir = join(process.cwd(), "src", "dashboard", "public");

    dashboard = new DashboardServer({
      host: dashHost,
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
        localConfigPath: options?.localConfigPath,
        rawLocalConfig: options?.rawLocalConfig ?? {},
        scheduler,
        longTermStore,
        suggestionStore,
        curationWorker,
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
      await curationWorker.stop();
      await suggestionWorker.stop();
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
  const { config, localConfigPath } = await loadConfig(configPath);
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

  const resolvedLocalConfigPath = deriveLocalConfigPath(resolvedConfigPath);
  let rawLocalConfig: Record<string, unknown> = {};
  try {
    const localRaw = await readFile(resolvedLocalConfigPath, "utf-8");
    rawLocalConfig = JSON.parse(localRaw) as Record<string, unknown>;
  } catch {
    // ENOENT is fine — dashboard will create it on first save
  }

  // ── Welcome banner ─────────────────────────────────────────────────────
  process.stdout.write("\n");
  process.stdout.write("  " + sage(bold("betterClaws")) + " " + dim("v0.1.0") + "\n");
  process.stdout.write("  " + stone(glyphs.hRule.repeat(22)) + "\n");

  const label = (key: string, value: string) =>
    "  " + stone(key.padEnd(12)) + value + "\n";

  process.stdout.write(label("Model", config.llm.model));
  if (config.llm.weak) {
    const weak = resolveWeakLlmConfig(config.llm)!;
    process.stdout.write(label("Model " + dim("(weak)"), weak.model));
  }
  process.stdout.write(label("Config", configPath ?? "config/betterclaws.json"));
  if (localConfigPath) {
    process.stdout.write(label("+ local", localConfigPath));
  }

  const { router, dashboard, adapterNames, stop } = await createApp(config, {
    dashboard: dashboardFlag || undefined,
    configPath: resolvedConfigPath,
    rawConfig,
    localConfigPath: resolvedLocalConfigPath,
    rawLocalConfig,
  });

  if (dashboard) {
    const dashCfg = config.dashboard ?? { host: undefined, port: 18701 };
    const dashHost = dashCfg.host ?? config.gateway.host;
    process.stdout.write(label("Dashboard", `http://${dashHost}:${dashCfg.port}`));
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
