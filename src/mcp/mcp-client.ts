/**
 * MCP (Model Context Protocol) stdio client.
 *
 * Spawns an MCP server as a subprocess, communicates via JSON-RPC 2.0 over
 * newline-delimited stdin/stdout. Implements the MCP client protocol:
 * initialize → tools/list → tools/call → shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { BetterClawsError, type McpServerConfig, type JsonSchema } from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import { JsonRpcTransport } from "./json-rpc.js";

export class McpClientError extends BetterClawsError {
  constructor(message: string, code: string = "MCP_CLIENT_ERROR") {
    super(message, "mcp-client", code);
    this.name = "McpClientError";
  }
}

// ── MCP protocol types ───────────────────────────────────────────────────────

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface McpToolResult {
  readonly content: readonly McpContentBlock[];
  readonly isError?: boolean;
}

interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
}

interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly capabilities: Record<string, unknown>;
}

interface McpToolsListResult {
  readonly tools: readonly McpToolDefinition[];
}

// ── Client ───────────────────────────────────────────────────────────────────

export class McpClient {
  private readonly config: McpServerConfig;
  private readonly logger: StructuredLogger;
  private readonly serverName: string;

  private process: ChildProcess | null = null;
  private transport: JsonRpcTransport | null = null;
  private connected = false;

  constructor(serverName: string, config: McpServerConfig, logger: StructuredLogger) {
    this.serverName = serverName;
    this.config = config;
    this.logger = logger;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    const child = spawn(this.config.command, [...(this.config.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(this.config.env ?? {}),
      },
    });

    this.process = child;

    // Capture stderr for logging
    let stderrBuffer = "";
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      // Flush complete lines to logger
      let newlineIdx: number;
      while ((newlineIdx = stderrBuffer.indexOf("\n")) !== -1) {
        const line = stderrBuffer.slice(0, newlineIdx).trim();
        stderrBuffer = stderrBuffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          this.logger.log({
            sessionId: null,
            eventType: "tool:invoke",
            component: "mcp-client",
            payload: { server: this.serverName, stderr: line },
          });
        }
      }
    });

    child.on("exit", (code, signal) => {
      this.connected = false;
      this.logger.log({
        sessionId: null,
        eventType: "config:change",
        component: "mcp-client",
        payload: { server: this.serverName, action: "exit", code, signal },
      });
    });

    child.on("error", (err) => {
      this.connected = false;
      this.logger.log({
        sessionId: null,
        eventType: "config:change",
        component: "mcp-client",
        payload: { server: this.serverName, action: "error", error: err.message },
      });
    });

    if (!child.stdout || !child.stdin) {
      throw new McpClientError(
        `Failed to spawn MCP server "${this.serverName}": no stdio`,
        "SPAWN_ERROR",
      );
    }

    this.transport = new JsonRpcTransport(child.stdout, child.stdin);

    // MCP initialize handshake
    const initResponse = await this.transport.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "betterClaws", version: "0.1.0" },
    });

    if (initResponse.error) {
      throw new McpClientError(
        `MCP initialize failed for "${this.serverName}": ${initResponse.error.message}`,
        "INIT_ERROR",
      );
    }

    const initResult = initResponse.result as McpInitializeResult;

    // Send initialized notification
    this.transport.sendNotification("notifications/initialized");

    this.connected = true;

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "mcp-client",
      payload: {
        server: this.serverName,
        action: "connected",
        serverInfo: initResult.serverInfo,
        protocolVersion: initResult.protocolVersion,
      },
    });
  }

  async listTools(): Promise<readonly McpToolDefinition[]> {
    if (!this.transport || !this.connected) {
      throw new McpClientError(
        `MCP server "${this.serverName}" is not connected`,
        "NOT_CONNECTED",
      );
    }

    const response = await this.transport.sendRequest("tools/list");

    if (response.error) {
      throw new McpClientError(
        `tools/list failed for "${this.serverName}": ${response.error.message}`,
        "LIST_ERROR",
      );
    }

    const result = response.result as McpToolsListResult;
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.transport || !this.connected) {
      throw new McpClientError(
        `MCP server "${this.serverName}" is not connected`,
        "NOT_CONNECTED",
      );
    }

    const response = await this.transport.sendRequest("tools/call", {
      name,
      arguments: args,
    });

    if (response.error) {
      return {
        content: [{ type: "text", text: response.error.message }],
        isError: true,
      };
    }

    return response.result as McpToolResult;
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.process) {
      return;
    }

    this.connected = false;

    // Try graceful shutdown
    this.transport?.close();

    const child = this.process;
    this.process = null;

    // Give the process a moment to exit, then force kill
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);

      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      child.kill("SIGTERM");
    });

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "mcp-client",
      payload: { server: this.serverName, action: "disconnected" },
    });
  }
}
