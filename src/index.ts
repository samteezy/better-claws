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
import type {
  BetterClawsConfig,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "./types.js";

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

export async function createApp(config: BetterClawsConfig): Promise<{
  router: MessageRouter;
  stop: () => Promise<void>;
}> {
  const logger = new StructuredLogger({
    directory: config.logging.directory,
    redactSensitive: config.logging.redactSensitive,
  });

  const llmClient = new LlmClient({
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
    model: config.llm.model,
    maxTokens: config.llm.maxTokens,
    temperature: config.llm.temperature,
    logger,
  });

  const toolRegistry = new ToolRegistry({
    toolsDirectory: "tools",
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
    logger,
  });

  return {
    router,
    stop: async () => {
      await router.stop();
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = await loadConfig();

  console.log(`betterClaws v0.1.0`);
  console.log(`LLM: ${config.llm.model} @ ${config.llm.baseUrl}`);
  console.log(`Type a message to chat. Ctrl+C to quit.\n`);

  const { router, stop } = await createApp(config);

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
