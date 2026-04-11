import {
  BetterClawsError,
  isCapability,
  isStreamableAdapter,
  type BetterClawsConfig,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage,
  type StreamEvent,
  type ToolCall,
} from "../types.js";
import { StreamableResponse } from "./streamable-response.js";
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

export interface SlashCommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly args?: string;
}

export const SLASH_COMMANDS: readonly SlashCommandDescriptor[] = [
  { name: "/new", description: "Archive the current session and start fresh" },
  { name: "/reset", description: "Wipe the current session entirely" },
  { name: "/fork", description: "Fork the current (or a specific) session", args: "[sessionId]" },
  { name: "/sessions", description: "List all sessions for your account" },
  { name: "/schedule", description: "Manage scheduled tasks", args: "<subcommand>" },
  { name: "/compact", description: "Compact the current session history" },
];

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
  readonly scheduler?: import("../scheduler/scheduler.js").Scheduler;
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
  private readonly scheduler?: import("../scheduler/scheduler.js").Scheduler;
  private readonly adapters = new Map<string, ChannelAdapter>();

  static getSlashCommands(): readonly SlashCommandDescriptor[] {
    return SLASH_COMMANDS;
  }

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
    this.scheduler = options.scheduler;
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
    adapter.onMessage((msg) => {
      const streamable = this.handleMessageStream(msg);
      if (isStreamableAdapter(adapter)) {
        void adapter.sendStream(msg.channelId, streamable).catch((err) => {
          this.logger.log({
            sessionId: null,
            eventType: "message:outbound",
            component: "router",
            payload: {
              error: err instanceof Error ? err.message : String(err),
              adapterId: adapter.id,
              channelId: msg.channelId,
            },
          });
        });
      } else {
        void streamable.text.then((text) => {
          void adapter.send(msg.channelId, { channelId: msg.channelId, text });
        }).catch((err) => {
          const errorText = err instanceof Error
            ? `Sorry, something went wrong: ${err.message}`
            : "Sorry, an unexpected error occurred.";
          void adapter.send(msg.channelId, { channelId: msg.channelId, text: errorText });
        });
      }
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
    const streamable = this.handleMessageStream(message);
    try {
      const text = await streamable.text;
      return { channelId: message.channelId, text };
    } catch (err) {
      const errorText =
        err instanceof Error
          ? `Sorry, something went wrong: ${err.message}`
          : "Sorry, an unexpected error occurred.";
      return { channelId: message.channelId, text: errorText };
    }
  }

  handleMessageStream(message: InboundMessage): StreamableResponse {
    const self = this;

    async function* generate(): AsyncGenerator<StreamEvent> {
      self.logger.log({
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

      const session = await self.sessionManager.getOrCreate(
        message.adapterId,
        message.channelId,
        message.senderId,
      );

      const cmd = message.text.trim();

      if (cmd === "/new") {
        await self.sessionManager.close(session.id);
        yield { type: "text-delta", delta: "Session archived. Starting fresh." };
        yield { type: "done", text: "Session archived. Starting fresh.", usage: { promptTokens: 0, completionTokens: 0 } };
        return;
      }

      if (cmd === "/reset") {
        await self.sessionManager.destroy(session.id);
        yield { type: "text-delta", delta: "Session wiped. Starting fresh." };
        yield { type: "done", text: "Session wiped. Starting fresh.", usage: { promptTokens: 0, completionTokens: 0 } };
        return;
      }

      if (cmd === "/fork" || cmd.startsWith("/fork ")) {
        const arg = cmd.slice("/fork".length).trim();
        const sourceId = arg || session.id;

        // Validate source exists
        const sourceContent = await self.sessionManager.readRawLog(sourceId);
        if (sourceContent === null) {
          const text = `Session "${sourceId}" not found.`;
          yield { type: "text-delta", delta: text };
          yield { type: "done", text, usage: { promptTokens: 0, completionTokens: 0 } };
          return;
        }

        // Close current session, then fork source into this channel
        await self.sessionManager.close(session.id);
        const forked = await self.sessionManager.fork(
          sourceId,
          message.adapterId,
          message.channelId,
          message.senderId,
        );

        const text = `Forked session ${sourceId.slice(0, 8)}… into ${forked.id.slice(0, 8)}…. History preserved, capabilities reset.`;
        yield { type: "text-delta", delta: text };
        yield { type: "done", text, usage: { promptTokens: 0, completionTokens: 0 } };
        return;
      }

      if (cmd === "/sessions") {
        const items = await self.sessionManager.listForSender(message.senderId);

        let text: string;
        if (items.length === 0) {
          text = "No sessions found.";
        } else {
          const lines = items.map((item) => {
            const id = item.sessionId.slice(0, 8);
            const status = item.archived ? "archived" : "active";
            const date = new Date(item.createdAt).toISOString().slice(0, 10);
            const preview = item.preview ? ` — ${item.preview}` : "";
            return `${id}  ${item.adapterId.padEnd(10)} ${status.padEnd(9)} ${date}${preview}`;
          });
          text = `Sessions:\n${lines.join("\n")}`;
        }

        yield { type: "text-delta", delta: text };
        yield { type: "done", text, usage: { promptTokens: 0, completionTokens: 0 } };
        return;
      }

      if (cmd === "/schedule" || cmd.startsWith("/schedule ")) {
        const text = await self.handleScheduleCommand(cmd);
        yield { type: "text-delta", delta: text };
        yield { type: "done", text, usage: { promptTokens: 0, completionTokens: 0 } };
        return;
      }

      await self.sessionManager.appendToLog(session.id, {
        type: "inbound",
        message,
      });

      if (cmd === "/compact") {
        let text: string;
        if (!self.compactor) {
          text = "Compaction is not configured.";
        } else {
          const result = await self.compactor.compact(session.id);
          text = result.compressedTurnCount === 0
            ? "Nothing to compact yet."
            : `Compaction complete. Summarised ${result.compressedTurnCount} turns (${result.summaryLength} chars).`;
        }
        await self.sessionManager.appendToLog(session.id, {
          type: "outbound",
          message: { channelId: message.channelId, text },
        });
        yield { type: "text-delta", delta: text };
        yield { type: "done", text, usage: { promptTokens: 0, completionTokens: 0 } };
        return;
      }

      let history = await self.sessionManager.getHistory(session.id);

      // Auto-compaction
      if (self.compactor && self.config.compaction?.enabled) {
        const compCfg = self.config.compaction;
        const { estimatedTokens } = self.promptBuilder.build({
          history,
          tools: self.toolRegistry.getDescriptors(),
        });
        if (estimatedTokens > compCfg.tokenBudget - compCfg.reserveTokens) {
          try {
            await self.compactor.compact(session.id);
            history = await self.sessionManager.getHistory(session.id);
          } catch (err) {
            self.logger.log({
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

      const tools = self.toolRegistry.getDescriptors();
      const buildResult = self.promptBuilder.build({
        history,
        tools,
        currentDateTime: self.getCurrentDateTime(),
        adapterPrompt: self.getAdapterPrompt(message.adapterId),
      });
      const messages = buildResult.messages;

      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let fullText = "";
      let fullReasoning = "";
      let iterations = 0;

      // Streaming LLM + tool call loop
      while (iterations <= MAX_TOOL_ITERATIONS) {
        let iterationText = "";
        let iterationReasoning = "";
        const toolAccumulators = new Map<number, { id: string; name: string; args: string }>();

        for await (const chunk of self.llmClient.chatStream(
          messages,
          tools.length > 0 ? tools : undefined,
        )) {
          // Accumulate reasoning deltas
          if (chunk.reasoningDelta) {
            iterationReasoning += chunk.reasoningDelta;
            yield { type: "reasoning-delta" as const, delta: chunk.reasoningDelta };
          }

          // Accumulate text deltas
          if (chunk.delta) {
            iterationText += chunk.delta;
            yield { type: "text-delta", delta: chunk.delta };
          }

          // Accumulate tool call deltas
          if (chunk.toolCallDeltas) {
            for (const delta of chunk.toolCallDeltas) {
              const existing = toolAccumulators.get(delta.index);
              if (!existing) {
                toolAccumulators.set(delta.index, {
                  id: delta.id ?? "",
                  name: delta.function?.name ?? "",
                  args: delta.function?.arguments ?? "",
                });
              } else {
                if (delta.id) existing.id = delta.id;
                if (delta.function?.name) existing.name += delta.function.name;
                if (delta.function?.arguments !== undefined) {
                  existing.args += delta.function.arguments;
                }
              }
            }
          }
        }

        fullText += iterationText;
        fullReasoning += iterationReasoning;

        // Build completed tool calls
        const completedToolCalls: ToolCall[] = [...toolAccumulators.values()]
          .filter((tc) => tc.id && tc.name)
          .map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.args },
          }));

        if (completedToolCalls.length === 0 || iterations >= MAX_TOOL_ITERATIONS) {
          // Log the final outbound message
          const outbound: OutboundMessage = { channelId: message.channelId, text: fullText };
          await self.sessionManager.appendToLog(session.id, { type: "outbound", message: outbound });
          self.logger.log({
            sessionId: session.id,
            eventType: "message:outbound",
            component: "router",
            payload: { textLength: fullText.length },
          });

          yield {
            type: "done",
            text: fullText,
            ...(fullReasoning ? { reasoning: fullReasoning } : {}),
            usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
          };
          return;
        }

        // Tool call loop iteration
        iterations++;

        // Add assistant message with tool calls to conversation
        messages.push({
          role: "assistant",
          content: iterationText,
          tool_calls: completedToolCalls,
        });

        // Execute each tool call
        for (const toolCall of completedToolCalls) {
          yield { type: "tool-start", toolCall };

          const toolResult = await self.processToolCall(toolCall, session.id);

          yield {
            type: "tool-result",
            toolName: toolCall.function.name,
            output: toolResult.output,
            error: toolResult.error,
          };

          messages.push({
            role: "tool",
            content: sanitizeOutput(
              JSON.stringify(toolResult.output ?? toolResult.error),
            ),
            tool_call_id: toolCall.id,
          });
        }

        // Reset text and reasoning for the next iteration — tool result follow-up may produce new text
        fullText = "";
        fullReasoning = "";
      }
    }

    return new StreamableResponse(generate());
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

  private async handleScheduleCommand(cmd: string): Promise<string> {
    if (!this.scheduler) {
      return "Scheduling is not configured.";
    }

    const args = cmd.slice("/schedule".length).trim();

    // /schedule enable all
    if (args === "enable all") {
      await this.scheduler.setAllEnabled(true);
      return "All schedules enabled.";
    }

    // /schedule disable all
    if (args === "disable all") {
      await this.scheduler.setAllEnabled(false);
      return "All schedules disabled.";
    }

    // /schedule enable <id>
    if (args.startsWith("enable ")) {
      const id = args.slice("enable ".length).trim();
      const schedule = this.scheduler.getSchedule(id);
      if (!schedule) return `Schedule "${id}" not found.`;
      await this.scheduler.setEnabled(id, true);
      return `Schedule #${id} "${schedule.name}" enabled.`;
    }

    // /schedule disable <id>
    if (args.startsWith("disable ")) {
      const id = args.slice("disable ".length).trim();
      const schedule = this.scheduler.getSchedule(id);
      if (!schedule) return `Schedule "${id}" not found.`;
      await this.scheduler.setEnabled(id, false);
      return `Schedule #${id} "${schedule.name}" disabled.`;
    }

    // /schedule remove <id>
    if (args.startsWith("remove ")) {
      const id = args.slice("remove ".length).trim();
      const schedule = this.scheduler.getSchedule(id);
      if (!schedule) return `Schedule "${id}" not found.`;
      await this.scheduler.removeSchedule(id);
      return `Schedule #${id} "${schedule.name}" removed.`;
    }

    // /schedule (list all)
    const all = this.scheduler.getAll();
    if (all.length === 0) {
      return "No scheduled tasks.\n\nUse the schedule-add tool to create one.";
    }

    const lines: string[] = [];
    let enabledCount = 0;

    for (const s of all) {
      const id = s.id ?? "?";
      const status = s.enabled !== false ? "✓ enabled" : "✗ disabled";
      if (s.enabled !== false) enabledCount++;

      let nextStr = "";
      if (s.enabled !== false && s.id) {
        const next = this.scheduler.getNextFireTime(s.id);
        if (next) {
          nextStr = `   next: ${next.toISOString().slice(0, 16).replace("T", " ")}`;
        }
      }

      const name = s.name.length > 20 ? s.name.slice(0, 19) + "…" : s.name.padEnd(20);
      lines.push(` #${id.padEnd(3)}  ${name}  ${s.cron.padEnd(13)}  ${status}${nextStr}`);
    }

    const disabledCount = all.length - enabledCount;
    return [
      "Scheduled Tasks",
      "───────────────",
      ...lines,
      "───────────────",
      `${all.length} task${all.length === 1 ? "" : "s"} (${enabledCount} enabled, ${disabledCount} disabled)`,
      "",
      "Use: /schedule enable|disable|remove <id|all>",
    ].join("\n");
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
      const error = `Tool "${toolName}" is disabled`;
      this.logger.log({ sessionId, eventType: "tool:error", component: "router", payload: { tool: toolName, error } });
      return { output: null, error };
    }
    if (policy === "confirm") {
      const error = `Tool "${toolName}" requires user confirmation (not yet supported in this adapter)`;
      this.logger.log({ sessionId, eventType: "tool:error", component: "router", payload: { tool: toolName, error } });
      return { output: null, error };
    }

    const descriptor = this.toolRegistry.getDescriptor(toolName);
    if (!descriptor) {
      const error = `Unknown tool: ${toolName}`;
      this.logger.log({ sessionId, eventType: "tool:error", component: "router", payload: { tool: toolName, error } });
      return { output: null, error };
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
        const error = `Tool "${toolName}" denied: ${decision.reason}`;
        this.logger.log({ sessionId, eventType: "tool:error", component: "router", payload: { tool: toolName, error } });
        return { output: null, error };
      }
    }

    const handler = this.toolRegistry.getHandler(toolName);
    if (!handler) {
      const error = `No handler found for tool: ${toolName}`;
      this.logger.log({ sessionId, eventType: "tool:error", component: "router", payload: { tool: toolName, error } });
      return { output: null, error };
    }

    let params: Record<string, unknown>;
    try {
      params = JSON.parse(toolCall.function.arguments) as Record<
        string,
        unknown
      >;
    } catch {
      const error = `Invalid JSON arguments for tool "${toolName}"`;
      this.logger.log({ sessionId, eventType: "tool:error", component: "router", payload: { tool: toolName, error } });
      return { output: null, error };
    }

    // Fix 5: validate arguments against the tool's parameter schema
    const validation = validateSchema(params, descriptor.parameters);
    if (!validation.valid) {
      const error = `Invalid arguments for tool "${toolName}": ${validation.errors.join("; ")}`;
      this.logger.log({ sessionId, eventType: "tool:error", component: "router", payload: { tool: toolName, error } });
      return { output: null, error };
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
      scheduler: this.scheduler,
    });

    if (!result.success) {
      this.logger.log({
        sessionId,
        eventType: "tool:error",
        component: "router",
        payload: { tool: toolName, error: result.error ?? "unknown error", durationMs: result.durationMs },
      });
    }

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
