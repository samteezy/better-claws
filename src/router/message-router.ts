import {
  BetterClawsError,
  type ChannelAdapter,
  type ChatMessage,
  type InboundMessage,
  type OutboundMessage,
  type ToolCall,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { LlmClient } from "../llm/llm-client.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { CapabilityGate } from "../tools/capability-gate.js";
import type { ToolExecutor } from "../tools/executor.js";

export class RouterError extends BetterClawsError {
  constructor(message: string, code: string = "ROUTER_ERROR") {
    super(message, "router", code);
    this.name = "RouterError";
  }
}

const MAX_TOOL_ITERATIONS = 10;

const SYSTEM_PROMPT = `You are betterClaws, a personal AI assistant. You can use tools when they are available. Be helpful, concise, and accurate. If you are unsure about something, say so.`;

export interface MessageRouterOptions {
  readonly sessionManager: SessionManager;
  readonly llmClient: LlmClient;
  readonly toolRegistry: ToolRegistry;
  readonly capabilityGate: CapabilityGate;
  readonly executor: ToolExecutor;
  readonly logger: StructuredLogger;
}

export class MessageRouter {
  private readonly sessionManager: SessionManager;
  private readonly llmClient: LlmClient;
  private readonly toolRegistry: ToolRegistry;
  private readonly capabilityGate: CapabilityGate;
  private readonly executor: ToolExecutor;
  private readonly logger: StructuredLogger;
  private readonly adapters = new Map<string, ChannelAdapter>();

  constructor(options: MessageRouterOptions) {
    this.sessionManager = options.sessionManager;
    this.llmClient = options.llmClient;
    this.toolRegistry = options.toolRegistry;
    this.capabilityGate = options.capabilityGate;
    this.executor = options.executor;
    this.logger = options.logger;
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

      await this.sessionManager.appendToLog(session.id, {
        type: "inbound",
        message,
      });

      const history = await this.sessionManager.getHistory(session.id);

      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
      ];

      const tools = this.toolRegistry.getDescriptors();
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
            content: JSON.stringify(toolResult.output ?? toolResult.error),
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

    const descriptor = this.toolRegistry.getDescriptor(toolName);
    if (!descriptor) {
      return {
        output: null,
        error: `Unknown tool: ${toolName}`,
      };
    }

    const grants = this.sessionManager.getGrants(sessionId);
    const decision = this.capabilityGate.check(descriptor, grants);

    if (!decision.allowed) {
      return {
        output: null,
        error: `Tool "${toolName}" denied: ${decision.reason}`,
      };
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

    const result = await this.executor.execute(handler, params, {
      sessionId,
      capabilities: [...descriptor.capabilities],
      scratchDir: "",
      timeout: 30000,
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
