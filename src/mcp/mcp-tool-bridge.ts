/**
 * Converts MCP server tools into RegisteredTool entries for the ToolRegistry.
 * Each tool is namespaced as `mcp__{serverName}__{toolName}` to prevent collisions.
 */

import type { ToolDescriptor, ToolHandler, ToolResult, McpServerConfig } from "../types.js";
import type { RegisteredTool } from "../tools/registry.js";
import type { McpClient, McpToolDefinition } from "./mcp-client.js";
import type { StructuredLogger } from "../logger/structured-logger.js";

export class McpToolBridge {
  private readonly client: McpClient;
  private readonly serverName: string;
  private readonly config: McpServerConfig;
  private readonly logger: StructuredLogger;

  constructor(
    client: McpClient,
    serverName: string,
    config: McpServerConfig,
    logger: StructuredLogger,
  ) {
    this.client = client;
    this.serverName = serverName;
    this.config = config;
    this.logger = logger;
  }

  async discoverTools(): Promise<readonly RegisteredTool[]> {
    const mcpTools = await this.client.listTools();
    const tools: RegisteredTool[] = [];

    for (const mcpTool of mcpTools) {
      const qualifiedName = `mcp__${this.serverName}__${mcpTool.name}`;

      // Check if this tool is disabled via server-level default policy
      const policy = this.config.defaultPolicy ?? "auto";
      if (policy === "disabled") continue;

      const tool = this.createRegisteredTool(qualifiedName, mcpTool);
      tools.push(tool);

      this.logger.log({
        sessionId: null,
        eventType: "tool:invoke",
        component: "mcp-tool-bridge",
        payload: {
          action: "discovered",
          server: this.serverName,
          tool: qualifiedName,
          originalName: mcpTool.name,
        },
      });
    }

    return tools;
  }

  private createRegisteredTool(qualifiedName: string, mcpTool: McpToolDefinition): RegisteredTool {
    const descriptor: ToolDescriptor = {
      name: qualifiedName,
      description: `[MCP: ${this.serverName}] ${mcpTool.description}`,
      parameters: mcpTool.inputSchema,
      capabilities: [...(this.config.capabilities ?? [])],
    };

    const client = this.client;
    const originalName = mcpTool.name;
    const serverName = this.serverName;
    const logger = this.logger;

    const handler: ToolHandler = {
      async execute(params: Record<string, unknown>): Promise<ToolResult> {
        const start = Date.now();

        if (!client.isConnected) {
          return {
            success: false,
            output: null,
            error: `MCP server "${serverName}" is not connected`,
            durationMs: Date.now() - start,
          };
        }

        try {
          const result = await client.callTool(originalName, params);

          // Extract text content from MCP response
          const textParts = result.content
            .filter(block => block.type === "text" && block.text)
            .map(block => block.text);
          const output = textParts.join("\n");

          logger.log({
            sessionId: null,
            eventType: "tool:invoke",
            component: "mcp-tool-bridge",
            payload: { action: "call_result", server: serverName, tool: originalName, isError: result.isError ?? false },
          });

          return {
            success: !result.isError,
            output,
            error: result.isError ? output : undefined,
            durationMs: Date.now() - start,
          };
        } catch (err) {
          return {
            success: false,
            output: null,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
          };
        }
      },
    };

    return { descriptor, handler };
  }
}
