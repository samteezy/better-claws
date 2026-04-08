import {
  BetterClawsError,
  isCapability,
  type BetterClawsConfig,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage,
  type ToolCall,
} from "../types.js";
import { validateSchema } from "../utils/schema-validator.js";
import { sanitizeOutput } from "../utils/output-sanitizer.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { SessionCompactor } from "../sessions/compactor.js";
import type { LlmClient } from "../llm/llm-client.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { CapabilityGate } from "../tools/capability-gate.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { SecretManager } from "../secrets/secret-manager.js";
import type { PromptBuilder } from "../prompt/prompt-builder.js";

export class RouterError extends BetterClawsError {
  constructor(message: string, code: string = "ROUTER_ERROR") {
    super(message, "router", code);
    this.name = "RouterError";
  }
}

const MAX_TOOL_ITERATIONS = 10;

/** Capabilities that must never be auto-granted — require explicit user grant. */
const NEVER_AUTO_GRANT = new Set([
  "fs:write",
  "exec:shell",
  "exec:subprocess",
  "net:outbound",
]);

export const SYSTEM_PROMPT = `You are betterClaws, a personal AI assistant. You can use tools when they are available. Be helpful, concise, and accurate. If you are unsure about something, say so.`;

export interface MessageRouterOptions {
  readonly sessionManager: SessionManager;
  readonly llmClient: LlmClient;
  readonly toolRegistry: ToolRegistry;
  readonly capabilityGate: CapabilityGate;
  readonly executor: ToolExecutor;
  readonly secretManager: SecretManager;
  readonly logger: StructuredLogger;
  readonly config: BetterClawsConfig;
  readonly compactor?: SessionCompactor;
  readonly promptBuilder: PromptBuilder;
}

export class MessageRouter {
  private readonly sessionManager: SessionManager;
  private readonly llmClient: LlmClient;
  private readonly toolRegistry: ToolRegistry;
  private readonly capabilityGate: CapabilityGate;
  private readonly executor: ToolExecutor;
  private readonly secretManager: SecretManager;
  private readonly logger: StructuredLogger;
  private readonly config: BetterClawsConfig;
  private readonly compactor: SessionCompactor | undefined;
  private readonly promptBuilder: PromptBuilder;
  private readonly adapters = new Map<string, ChannelAdapter>();

  constructor(options: MessageRouterOptions) {
    this.sessionManager = options.sessionManager;
    this.llmClient = options.llmClient;
    this.toolRegistry = options.toolRegistry;
    this.capabilityGate = options.capabilityGate;
    this.executor = options.executor;
    this.secretManager = options.secretManager;
    this.logger = options.logger;
    this.config = options.config;
    this.compactor = options.compactor;
    this.promptBuilder = options.promptBuilder;
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
    adapter.onMessage((msg) => {
      void this.handleMessage(msg).then((response) => {
        void adapter.send(msg.channelId, response);
      });
    });
  }

  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start();
    }
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
    await this.logger.close();
  }

  async handleMessage(message: InboundMessage): Promise<OutboundMessage> {
    this.logger.log({
      sessionId: null,
      eventType: "message:inbound",
      component: "router",
      payload: {
        adapterId: message.adapterId,
        channelId: message.channelId,
        senderId: message.senderId,
        textLength: message.text.length,
      },
    });

    try {
      const session = await this.sessionManager.getOrCreate(
        message.adapterId,
        message.channelId,
        message.senderId,
      );

      // Check for reset commands before logging to the session
      const cmd = message.text.trim();

      if (cmd === "/new") {
        await this.sessionManager.close(session.id);
        return {
          channelId: message.channelId,
          text: "Session archived. Starting fresh.",
        };
      }

      if (cmd === "/reset") {
        await this.sessionManager.destroy(session.id);
        return {
          channelId: message.channelId,
          text: "Session wiped. Starting fresh.",
        };
      }

      await this.sessionManager.appendToLog(session.id, {
        type: "inbound",
        message,
      });

      if (cmd === "/compact") {
        if (!this.compactor) {
          return {
            channelId: message.channelId,
            text: "Compaction is not configured.",
          };
        }
        const result = await this.compactor.compact(session.id);
        if (result.compressedTurnCount === 0) {
          const reply: OutboundMessage = {
            channelId: message.channelId,
            text: "Nothing to compact yet.",
          };
          await this.sessionManager.appendToLog(session.id, { type: "outbound", message: reply });
          return reply;
        }
        const reply: OutboundMessage = {
          channelId: message.channelId,
          text: `Compaction complete. Summarised ${result.compressedTurnCount} turns (${result.summaryLength} chars).`,
        };
        await this.sessionManager.appendToLog(session.id, { type: "outbound", message: reply });
        return reply;
      }

      let history = await this.sessionManager.getHistory(session.id);

      // Auto-compaction: if token usage is approaching the budget, compact first
      if (
        this.compactor &&
        this.config.compaction?.enabled
      ) {
        const compCfg = this.config.compaction;
        const { estimatedTokens } = this.promptBuilder.build({
          history,
          tools: this.toolRegistry.getDescriptors(),
        });
        if (estimatedTokens > compCfg.tokenBudget - compCfg.reserveTokens) {
          try {
            await this.compactor.compact(session.id);
            history = await this.sessionManager.getHistory(session.id);
          } catch (err) {
            this.logger.log({
              sessionId: session.id,
              eventType: "session:compaction",
              component: "router",
              payload: {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              },
            });
          }
        }
      }

      const tools = this.toolRegistry.getDescriptors();
      const buildResult = this.promptBuilder.build({
        history,
        tools,
        currentDateTime: this.getCurrentDateTime(),
        adapterPrompt: this.getAdapterPrompt(message.adapterId),
      });
      const messages = buildResult.messages;
      let response = await this.llmClient.chat(
        messages,
        tools.length > 0 ? tools : undefined,
      );

      // Tool call loop
      let iterations = 0;
      while (
        response.message.tool_calls &&
        response.message.tool_calls.length > 0 &&
        iterations < MAX_TOOL_ITERATIONS
      ) {
        iterations++;

        // Add assistant message with tool calls to conversation
        messages.push(response.message);

        for (const toolCall of response.message.tool_calls) {
          const toolResult = await this.processToolCall(
            toolCall,
            session.id,
          );

          messages.push({
            role: "tool",
            content: sanitizeOutput(
              JSON.stringify(toolResult.output ?? toolResult.error),
            ),
            tool_call_id: toolCall.id,
          });
        }

        // Call LLM again with tool results
        response = await this.llmClient.chat(
          messages,
          tools.length > 0 ? tools : undefined,
        );
      }

      const outbound: OutboundMessage = {
        channelId: message.channelId,
        text: response.message.content,
      };

      await this.sessionManager.appendToLog(session.id, {
        type: "outbound",
        message: outbound,
      });

      this.logger.log({
        sessionId: session.id,
        eventType: "message:outbound",
        component: "router",
        payload: { textLength: outbound.text.length },
      });

      return outbound;
    } catch (err) {
      const errorText =
        err instanceof Error
          ? `Sorry, something went wrong: ${err.message}`
          : "Sorry, an unexpected error occurred.";

      return {
        channelId: message.channelId,
        text: errorText,
      };
    }
  }

  private getCurrentDateTime(): string {
    const tz = this.config.systemContext?.timezone ?? "UTC";
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
    return `${parts["year"]}-${parts["month"]}-${parts["day"]} ${parts["hour"]}:${parts["minute"]}:${parts["second"]} (${tz})`;
  }

  private getAdapterPrompt(adapterId: string): string | undefined {
    const adapterConfig = this.config.adapters[adapterId];
    return adapterConfig?.systemPrompt;
  }

  private async processToolCall(
    toolCall: ToolCall,
    sessionId: string,
  ): Promise<{ output: unknown; error?: string }> {
    const toolName = toolCall.function.name;

    this.logger.log({
      sessionId,
      eventType: "tool:invoke",
      component: "router",
      payload: { tool: toolName },
    });

    // Check tool policy before proceeding
    const policy = this.toolRegistry.getPolicy(toolName);
    if (policy === "disabled") {
      return {
        output: null,
        error: `Tool "${toolName}" is disabled`,
      };
    }
    if (policy === "confirm") {
      return {
        output: null,
        error: `Tool "${toolName}" requires user confirmation (not yet supported in this adapter)`,
      };
    }

    const descriptor = this.toolRegistry.getDescriptor(toolName);
    if (!descriptor) {
      return {
        output: null,
        error: `Unknown tool: ${toolName}`,
      };
    }

    let grants = this.sessionManager.getGrants(sessionId);
    let decision = this.capabilityGate.check(descriptor, grants);

    // Fix 8: auto-grant missing capabilities when allowed by config
    if (!decision.allowed) {
      const autoGrant = this.config.security.autoGrantCapabilities ?? [];
      const autoGrantSet = new Set(autoGrant);
      const canAutoGrant = decision.missingCapabilities.every(
        (cap) => autoGrantSet.has(cap) && !NEVER_AUTO_GRANT.has(cap),
      );

      if (canAutoGrant) {
        for (const cap of decision.missingCapabilities) {
          if (isCapability(cap)) {
            this.sessionManager.grantCapability(sessionId, cap, "session");
            this.logger.log({
              sessionId,
              eventType: "gate:decision",
              component: "router",
              payload: { action: "auto_grant", capability: cap, tool: toolName },
            });
          }
        }
        // Re-check after granting
        grants = this.sessionManager.getGrants(sessionId);
        decision = this.capabilityGate.check(descriptor, grants);
      }

      if (!decision.allowed) {
        return {
          output: null,
          error: `Tool "${toolName}" denied: ${decision.reason}`,
        };
      }
    }

    const handler = this.toolRegistry.getHandler(toolName);
    if (!handler) {
      return {
        output: null,
        error: `No handler found for tool: ${toolName}`,
      };
    }

    let params: Record<string, unknown>;
    try {
      params = JSON.parse(toolCall.function.arguments) as Record<
        string,
        unknown
      >;
    } catch {
      return {
        output: null,
        error: `Invalid JSON arguments for tool "${toolName}"`,
      };
    }

    // Fix 5: validate arguments against the tool's parameter schema
    const validation = validateSchema(params, descriptor.parameters);
    if (!validation.valid) {
      return {
        output: null,
        error: `Invalid arguments for tool "${toolName}": ${validation.errors.join("; ")}`,
      };
    }

    const secrets = this.secretManager.projectForTool(
      descriptor.secrets ?? [],
      sessionId,
      toolName,
    );

    const result = await this.executor.execute(handler, params, {
      sessionId,
      capabilities: [...descriptor.capabilities],
      scratchDir: "",
      timeout: this.config.security.sandboxTimeout ?? 30000,
      secrets,
      allowedFsRoots: this.config.security.allowedFsRoots ?? [],
    });

    await this.sessionManager.appendToLog(sessionId, {
      type: "toolResult",
      toolName,
      result,
    });

    return {
      output: result.output,
      error: result.error,
    };
  }
}
