import { randomUUID } from "node:crypto";
import {
  createErrorClass,
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
import type { Session, SessionManager } from "../sessions/session-manager.js";
import type { SessionCompactor } from "../sessions/compactor.js";
import type { LlmClient } from "../llm/llm-client.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { CapabilityGate } from "../tools/capability-gate.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { SecretManager } from "../secrets/secret-manager.js";
import type { BuildResult, PromptBuilder } from "../prompt/prompt-builder.js";
import { ConfirmationBroker } from "./confirmation-broker.js";

export const RouterError = createErrorClass("RouterError", "router", "ROUTER_ERROR");

const MAX_TOOL_ITERATIONS = 10;

/** Capabilities that must never be auto-granted — require explicit user grant. */
const NEVER_AUTO_GRANT = new Set([
  "fs:write",
  "exec:shell",
  "exec:subprocess",
  "net:outbound",
]);

export const SYSTEM_PROMPT = `You are betterClaws, a personal AI assistant. You can use tools when they are available. Be helpful, concise, and accurate. If you are unsure about something, say so.

When a tool call is denied by the user, do NOT retry the same tool. Acknowledge the denial and continue without that tool. Suggest alternatives if appropriate, but never re-invoke a denied tool unless the user explicitly asks you to try again.`;

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
  { name: "/stop", description: "Stop the current in-progress response" },
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
  readonly confirmationBroker?: ConfirmationBroker;
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
  private readonly confirmationBroker: ConfirmationBroker;
  private readonly scheduler?: import("../scheduler/scheduler.js").Scheduler;
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly activeResponses = new Map<string, AbortController>();
  private readonly channelQueues = new Map<string, {
    activeCount: number;
    pending: InboundMessage[];
  }>();

  static getSlashCommands(): readonly SlashCommandDescriptor[] {
    return SLASH_COMMANDS;
  }

  stopSession(sessionId: string): boolean {
    const controller = this.activeResponses.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
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
    this.confirmationBroker = options.confirmationBroker
      ?? new ConfirmationBroker(this.logger, this.config.security.confirmationTimeoutMs ?? 120_000);
    this.scheduler = options.scheduler;
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
    adapter.onMessage((msg) => {
      const key = `${msg.adapterId}:${msg.channelId}:${msg.senderId}`;

      // Intercept confirmation replies before they enter the queue or LLM context.
      // /stop must pass through to the normal handler so it fires the abort signal,
      // which the broker's signal listener will resolve as deny.
      if (msg.text.trim() !== "/stop" && this.confirmationBroker.resolve(key, msg.text)) return;

      let queue = this.channelQueues.get(key);
      if (!queue) {
        queue = { activeCount: 0, pending: [] };
        this.channelQueues.set(key, queue);
      }

      if (queue.activeCount > 0) {
        if (msg.text.trim() === "/stop") {
          const discarded = queue.pending.length;
          queue.pending.length = 0;
          this.logger.log({
            sessionId: null,
            eventType: "message:queue",
            component: "router",
            payload: { action: "stop_bypass", key, discardedCount: discarded },
          });
          this.processAdapterMessage(adapter, msg, queue);
        } else {
          queue.pending.push(msg);
          this.logger.log({
            sessionId: null,
            eventType: "message:queue",
            component: "router",
            payload: { action: "queued", key, pendingCount: queue.pending.length },
          });
        }
        return;
      }

      this.processAdapterMessage(adapter, msg, queue);
    });
  }

  private processAdapterMessage(
    adapter: ChannelAdapter,
    msg: InboundMessage,
    queue: { activeCount: number; pending: InboundMessage[] },
  ): void {
    queue.activeCount++;
    const streamable = this.handleMessageStream(msg);

    const queueKey = `${msg.adapterId}:${msg.channelId}:${msg.senderId}`;
    const onDone = (): void => {
      queue.activeCount--;
      if (queue.activeCount === 0 && queue.pending.length > 0) {
        const count = queue.pending.length;
        const first = queue.pending[0]!;
        const merged: InboundMessage = {
          id: randomUUID(),
          adapterId: first.adapterId,
          channelId: first.channelId,
          senderId: first.senderId,
          text: queue.pending.map((m) => m.text).join("\n"),
          timestamp: Date.now(),
        };
        queue.pending.length = 0;
        this.logger.log({
          sessionId: null,
          eventType: "message:queue",
          component: "router",
          payload: { action: "drain_merged", key: queueKey, mergedCount: count },
        });
        this.processAdapterMessage(adapter, merged, queue);
      } else if (queue.activeCount === 0 && queue.pending.length === 0) {
        this.channelQueues.delete(queueKey);
      }
    };

    void streamable.text.then(() => onDone(), () => onDone());

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
      void Promise.all([streamable.text, streamable.warnings]).then(([text, warnings]) => {
        const fullText = warnings.length > 0
          ? warnings.map((w) => `\u26A0 ${w}`).join("\n") + "\n\n" + text
          : text;
        void adapter.send(msg.channelId, { channelId: msg.channelId, text: fullText });
      }).catch((err) => {
        const errorText = err instanceof Error
          ? `Sorry, something went wrong: ${err.message}`
          : "Sorry, an unexpected error occurred.";
        void adapter.send(msg.channelId, { channelId: msg.channelId, text: errorText });
      });
    }
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

      // Handle slash commands
      const slashResult = self.handleSlashCommand(cmd, session, message);
      if (slashResult) {
        yield* slashResult;
        return;
      }

      await self.sessionManager.appendToLog(session.id, {
        type: "inbound",
        message,
      });

      if (cmd === "/compact") {
        yield* self.handleCompactCommand(session, message);
        return;
      }

      // Register an AbortController so /stop can cancel this response
      const abortController = new AbortController();
      const signal = abortController.signal;
      self.activeResponses.set(session.id, abortController);

      try {
        const history = await self.sessionManager.getHistory(session.id);
        const tools = self.toolRegistry.getDescriptors();

        // Build prompt (single build), then auto-compact if needed
        let buildResult = self.promptBuilder.build({
          history,
          tools,
          currentDateTime: self.getCurrentDateTime(),
          adapterPrompt: self.getAdapterPrompt(message.adapterId),
        });
        buildResult = await self.autoCompactIfNeeded(session.id, buildResult);

        // Context budget warnings
        const budget = self.promptBuilder.budget;
        if (buildResult.truncatedCount === history.length && history.length > 0) {
          yield {
            type: "warning",
            message: "Context limit reached — conversation history was dropped. Consider increasing your token budget or using /compact.",
          };
        } else if (buildResult.estimatedTokens >= budget * 0.8) {
          const pct = Math.round((buildResult.estimatedTokens / budget) * 100);
          yield {
            type: "warning",
            message: `Context usage is at ${pct}% of the configured limit (${budget} tokens). Older messages may be trimmed soon.`,
          };
        }

        yield* self.runToolLoop(
          buildResult,
          tools,
          signal,
          session,
          message,
        );
      } finally {
        self.activeResponses.delete(session.id);
      }
    }

    return new StreamableResponse(generate());
  }

  // ── Extracted helpers for handleMessageStream ────────────────────────────────

  private handleSlashCommand(
    cmd: string,
    session: Session,
    message: InboundMessage,
  ): AsyncGenerator<StreamEvent> | null {
    if (cmd === "/stop") return this.handleStopCommand(session);
    if (cmd === "/new") return this.handleNewCommand(session);
    if (cmd === "/reset") return this.handleResetCommand(session);
    if (cmd === "/fork" || cmd.startsWith("/fork ")) return this.handleForkCommand(cmd, session, message);
    if (cmd === "/sessions") return this.handleSessionsCommand(session, message);
    if (cmd === "/schedule" || cmd.startsWith("/schedule ")) return this.handleScheduleSlashCommand(cmd);
    return null;
  }

  private async *handleStopCommand(session: Session): AsyncGenerator<StreamEvent> {
    const stopped = this.stopSession(session.id);
    const text = stopped ? "Stopped." : "Nothing to stop.";
    this.logger.log({
      sessionId: session.id,
      eventType: "session:stop",
      component: "router",
      payload: { stopped },
    });
    yield { type: "text-delta", delta: text };
    yield { type: "done", text, usage: { promptTokens: 0, completionTokens: 0 } };
  }

  private async *handleNewCommand(session: Session): AsyncGenerator<StreamEvent> {
    await this.sessionManager.close(session.id);
    yield { type: "reset" };
    yield { type: "text-delta", delta: "Session archived. Starting fresh." };
    yield { type: "done", text: "Session archived. Starting fresh.", usage: { promptTokens: 0, completionTokens: 0 } };
  }

  private async *handleResetCommand(session: Session): AsyncGenerator<StreamEvent> {
    await this.sessionManager.destroy(session.id);
    yield { type: "reset" };
    yield { type: "text-delta", delta: "Session wiped. Starting fresh." };
    yield { type: "done", text: "Session wiped. Starting fresh.", usage: { promptTokens: 0, completionTokens: 0 } };
  }

  private async *handleForkCommand(
    cmd: string,
    session: Session,
    message: InboundMessage,
  ): AsyncGenerator<StreamEvent> {
    const arg = cmd.slice("/fork".length).trim();
    const sourceId = arg || session.id;

    const sourceContent = await this.sessionManager.readRawLog(sourceId);
    if (sourceContent === null) {
      const text = `Session "${sourceId}" not found.`;
      yield { type: "text-delta", delta: text };
      yield { type: "done", text, usage: { promptTokens: 0, completionTokens: 0 } };
      return;
    }

    await this.sessionManager.close(session.id);
    const forked = await this.sessionManager.fork(
      sourceId,
      message.adapterId,
      message.channelId,
      message.senderId,
    );

    const text = `Forked session ${sourceId.slice(0, 8)}… into ${forked.id.slice(0, 8)}…. History preserved, capabilities reset.`;
    yield { type: "text-delta", delta: text };
    yield { type: "done", text, usage: { promptTokens: 0, completionTokens: 0 } };
  }

  private async *handleSessionsCommand(
    _session: Session,
    message: InboundMessage,
  ): AsyncGenerator<StreamEvent> {
    const items = await this.sessionManager.listForSender(message.senderId);

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
  }

  private async *handleScheduleSlashCommand(cmd: string): AsyncGenerator<StreamEvent> {
    const text = await this.handleScheduleCommand(cmd);
    yield { type: "text-delta", delta: text };
    yield { type: "done", text, usage: { promptTokens: 0, completionTokens: 0 } };
  }

  private async *handleCompactCommand(
    session: Session,
    message: InboundMessage,
  ): AsyncGenerator<StreamEvent> {
    let text: string;
    if (!this.compactor) {
      text = "Compaction is not configured.";
    } else {
      const result = await this.compactor.compact(session.id);
      text = result.compressedTurnCount === 0
        ? "Nothing to compact yet."
        : `Compaction complete. Summarised ${result.compressedTurnCount} turns (${result.summaryLength} chars).`;
    }
    await this.sessionManager.appendToLog(session.id, {
      type: "outbound",
      message: { channelId: message.channelId, text, timestamp: Date.now() },
    });
    yield { type: "text-delta", delta: text };
    yield { type: "done", text, usage: { promptTokens: 0, completionTokens: 0 } };
  }

  private async autoCompactIfNeeded(
    sessionId: string,
    buildResult: BuildResult,
  ): Promise<BuildResult> {
    if (!this.compactor || !this.config.compaction?.enabled) return buildResult;

    const compCfg = this.config.compaction;
    if (buildResult.estimatedTokens <= compCfg.tokenBudget - compCfg.reserveTokens) {
      return buildResult;
    }

    try {
      await this.compactor.compact(sessionId);
      const refreshedHistory = await this.sessionManager.getHistory(sessionId);
      return this.promptBuilder.build({
        history: refreshedHistory,
        tools: this.toolRegistry.getDescriptors(),
        currentDateTime: this.getCurrentDateTime(),
      });
    } catch (err) {
      this.logger.log({
        sessionId,
        eventType: "session:compaction",
        component: "router",
        payload: {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return buildResult;
    }
  }

  private async *runToolLoop(
    buildResult: BuildResult,
    tools: readonly import("../types.js").ToolDescriptor[],
    signal: AbortSignal,
    session: Session,
    message: InboundMessage,
  ): AsyncGenerator<StreamEvent> {
    const messages = buildResult.messages;
    const budget = this.promptBuilder.budget;

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let fullText = "";
    let fullReasoning = "";
    let iterations = 0;

    try {
      while (iterations <= MAX_TOOL_ITERATIONS) {
        if (signal.aborted) break;

        let iterationText = "";
        let iterationReasoning = "";
        const toolAccumulators = new Map<number, { id: string; name: string; args: string }>();

        for await (const chunk of this.llmClient.chatStream(
          messages,
          tools.length > 0 ? tools : undefined,
          { signal },
        )) {
          if (signal.aborted) break;

          if (chunk.reasoningDelta) {
            iterationReasoning += chunk.reasoningDelta;
            yield { type: "reasoning-delta" as const, delta: chunk.reasoningDelta };
          }

          if (chunk.delta) {
            iterationText += chunk.delta;
            yield { type: "text-delta", delta: chunk.delta };
          }

          if (chunk.usage) {
            totalPromptTokens = chunk.usage.promptTokens;
            totalCompletionTokens = chunk.usage.completionTokens;
          }

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

        if (signal.aborted) break;

        fullText += iterationText;
        fullReasoning += iterationReasoning;

        const completedToolCalls: ToolCall[] = [...toolAccumulators.values()]
          .filter((tc) => tc.id && tc.name)
          .map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.args },
          }));

        if (completedToolCalls.length === 0 || iterations >= MAX_TOOL_ITERATIONS) {
          const outbound: OutboundMessage = { channelId: message.channelId, text: fullText, timestamp: Date.now() };
          await this.sessionManager.appendToLog(session.id, { type: "outbound", message: outbound });
          this.logger.log({
            sessionId: session.id,
            eventType: "message:outbound",
            component: "router",
            payload: { textLength: fullText.length },
          });

          const actualTotal = totalPromptTokens + totalCompletionTokens;
          yield {
            type: "done",
            text: fullText,
            ...(fullReasoning ? { reasoning: fullReasoning } : {}),
            usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
            context: {
              estimatedTokens: buildResult.estimatedTokens,
              ...(actualTotal > 0 ? { actualTokens: totalPromptTokens } : {}),
              budget,
            },
          };
          return;
        }

        iterations++;

        messages.push({
          role: "assistant",
          content: iterationText,
          tool_calls: completedToolCalls,
        });

        for (const toolCall of completedToolCalls) {
          if (signal.aborted) break;

          yield { type: "tool-start", toolCall };

          const toolResult = await this.processToolCall(
            toolCall,
            session.id,
            { adapterId: message.adapterId, channelId: message.channelId, senderId: message.senderId },
            signal,
          );

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

        fullText = "";
        fullReasoning = "";
      }
    } catch (err) {
      if (!signal.aborted) throw err;
    }

    // If aborted by /stop, yield partial result
    if (signal.aborted) {
      this.logger.log({
        sessionId: session.id,
        eventType: "session:stop",
        component: "router",
        payload: { textLength: fullText.length, iterations },
      });
      yield {
        type: "done",
        text: fullText,
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
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
    confirmationCtx: { adapterId: string; channelId: string; senderId: string },
    signal?: AbortSignal,
  ): Promise<{ output: unknown; error?: string }> {
    const toolName = toolCall.function.name;

    this.logger.log({
      sessionId,
      eventType: "tool:invoke",
      component: "router",
      payload: { tool: toolName },
    });

    // Check tool policy before proceeding
    let policy = this.toolRegistry.getPolicy(toolName);

    // Session-level overrides (e.g. user granted "yes always" earlier)
    const override = this.sessionManager.getToolPolicyOverride(sessionId, toolName);
    if (override) policy = override;

    if (policy === "disabled") {
      const error = `Tool "${toolName}" is disabled`;
      this.logger.log({ sessionId, eventType: "tool:error", component: "router", payload: { tool: toolName, error } });
      return { output: null, error };
    }
    if (policy === "confirm") {
      const adapter = this.adapters.get(confirmationCtx.adapterId);
      if (!adapter) {
        const error = `Tool "${toolName}" requires confirmation but adapter not found`;
        this.logger.log({ sessionId, eventType: "tool:error", component: "router", payload: { tool: toolName, error } });
        return { output: null, error };
      }

      const result = await this.confirmationBroker.requestAndWait(
        adapter,
        confirmationCtx.channelId,
        confirmationCtx.senderId,
        confirmationCtx.adapterId,
        toolName,
        toolCall,
        signal,
      );

      if (result.verdict === "deny") {
        return { output: null, error: `User denied execution of tool "${toolName}". Do not retry this action.` };
      }

      if (result.verdict === "allow-session") {
        this.sessionManager.setToolPolicyOverride(sessionId, toolName, "auto");
      }
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
      signal,
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
