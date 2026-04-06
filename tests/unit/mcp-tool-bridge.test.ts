import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpToolBridge } from "../../src/mcp/mcp-tool-bridge.js";
import type { McpClient, McpToolDefinition } from "../../src/mcp/mcp-client.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { McpServerConfig } from "../../src/types.js";

function createMockLogger(): StructuredLogger {
  return {
    log() {},
    async flush() {},
    async close() {},
  } as unknown as StructuredLogger;
}

function createMockMcpClient(tools: readonly McpToolDefinition[], connected = true): McpClient {
  return {
    isConnected: connected,
    async listTools() {
      return tools;
    },
    async callTool(name: string) {
      return {
        content: [{ type: "text", text: `Result for ${name}` }],
        isError: false,
      };
    },
    async connect() {},
    async disconnect() {},
  } as unknown as McpClient;
}

describe("McpToolBridge", () => {
  describe("discoverTools()", () => {
    it("creates RegisteredTool entries with mcp__{serverName}__{toolName} naming", async () => {
      const tools: McpToolDefinition[] = [
        {
          name: "get_weather",
          description: "Get weather for a location",
          inputSchema: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
          },
        },
      ];

      const client = createMockMcpClient(tools);
      const logger = createMockLogger();
      const serverConfig: McpServerConfig = {
        command: "mock-server",
      };

      const bridge = new McpToolBridge(client, "weather-api", serverConfig, logger);

      const registeredTools = await bridge.discoverTools();

      assert.equal(registeredTools.length, 1);
      assert.equal(registeredTools[0]!.descriptor.name, "mcp__weather-api__get_weather");
    });

    it("prefixes tool descriptions with [MCP: serverName]", async () => {
      const tools: McpToolDefinition[] = [
        {
          name: "search",
          description: "Search the web",
          inputSchema: { type: "object" },
        },
      ];

      const client = createMockMcpClient(tools);
      const logger = createMockLogger();
      const serverConfig: McpServerConfig = {
        command: "mock-server",
      };

      const bridge = new McpToolBridge(client, "search-engine", serverConfig, logger);

      const registeredTools = await bridge.discoverTools();

      assert.equal(registeredTools[0]!.descriptor.description, "[MCP: search-engine] Search the web");
    });

    it("includes server capabilities in tool descriptor", async () => {
      const tools: McpToolDefinition[] = [
        {
          name: "exec",
          description: "Execute a command",
          inputSchema: { type: "object" },
        },
      ];

      const client = createMockMcpClient(tools);
      const logger = createMockLogger();
      const serverConfig: McpServerConfig = {
        command: "mock-server",
        capabilities: ["exec:shell", "fs:write"],
      };

      const bridge = new McpToolBridge(client, "exec-server", serverConfig, logger);

      const registeredTools = await bridge.discoverTools();

      assert.deepEqual(registeredTools[0]!.descriptor.capabilities, ["exec:shell", "fs:write"]);
    });

    it("returns empty array when defaultPolicy is 'disabled'", async () => {
      const tools: McpToolDefinition[] = [
        {
          name: "tool1",
          description: "Tool 1",
          inputSchema: { type: "object" },
        },
        {
          name: "tool2",
          description: "Tool 2",
          inputSchema: { type: "object" },
        },
      ];

      const client = createMockMcpClient(tools);
      const logger = createMockLogger();
      const serverConfig: McpServerConfig = {
        command: "mock-server",
        defaultPolicy: "disabled",
      };

      const bridge = new McpToolBridge(client, "disabled-server", serverConfig, logger);

      const registeredTools = await bridge.discoverTools();

      assert.equal(registeredTools.length, 0);
    });

    it("includes tools when defaultPolicy is 'confirm'", async () => {
      const tools: McpToolDefinition[] = [
        {
          name: "risky-tool",
          description: "A tool requiring confirmation",
          inputSchema: { type: "object" },
        },
      ];

      const client = createMockMcpClient(tools);
      const logger = createMockLogger();
      const serverConfig: McpServerConfig = {
        command: "mock-server",
        defaultPolicy: "confirm",
      };

      const bridge = new McpToolBridge(client, "confirm-server", serverConfig, logger);

      const registeredTools = await bridge.discoverTools();

      assert.equal(registeredTools.length, 1);
      assert.equal(registeredTools[0]!.descriptor.name, "mcp__confirm-server__risky-tool");
    });

    it("includes tools when defaultPolicy is 'auto'", async () => {
      const tools: McpToolDefinition[] = [
        {
          name: "safe-tool",
          description: "A safe tool",
          inputSchema: { type: "object" },
        },
      ];

      const client = createMockMcpClient(tools);
      const logger = createMockLogger();
      const serverConfig: McpServerConfig = {
        command: "mock-server",
        defaultPolicy: "auto",
      };

      const bridge = new McpToolBridge(client, "auto-server", serverConfig, logger);

      const registeredTools = await bridge.discoverTools();

      assert.equal(registeredTools.length, 1);
    });

    it("includes tools when defaultPolicy is omitted (defaults to 'auto')", async () => {
      const tools: McpToolDefinition[] = [
        {
          name: "default-tool",
          description: "A tool with default policy",
          inputSchema: { type: "object" },
        },
      ];

      const client = createMockMcpClient(tools);
      const logger = createMockLogger();
      const serverConfig: McpServerConfig = {
        command: "mock-server",
      };

      const bridge = new McpToolBridge(client, "default-server", serverConfig, logger);

      const registeredTools = await bridge.discoverTools();

      assert.equal(registeredTools.length, 1);
    });

    it("discovers multiple tools with proper namespacing", async () => {
      const tools: McpToolDefinition[] = [
        {
          name: "list_files",
          description: "List files in a directory",
          inputSchema: { type: "object" },
        },
        {
          name: "read_file",
          description: "Read file contents",
          inputSchema: { type: "object" },
        },
        {
          name: "write_file",
          description: "Write file contents",
          inputSchema: { type: "object" },
        },
      ];

      const client = createMockMcpClient(tools);
      const logger = createMockLogger();
      const serverConfig: McpServerConfig = {
        command: "mock-server",
      };

      const bridge = new McpToolBridge(client, "filesystem", serverConfig, logger);

      const registeredTools = await bridge.discoverTools();

      assert.equal(registeredTools.length, 3);

      const names = registeredTools.map((t) => t.descriptor.name).sort();
      assert.deepEqual(names, [
        "mcp__filesystem__list_files",
        "mcp__filesystem__read_file",
        "mcp__filesystem__write_file",
      ]);
    });

    it("preserves original MCP tool inputSchema in descriptor", async () => {
      const inputSchema = {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      };

      const tools: McpToolDefinition[] = [
        {
          name: "search",
          description: "Search",
          inputSchema,
        },
      ];

      const client = createMockMcpClient(tools);
      const logger = createMockLogger();
      const serverConfig: McpServerConfig = {
        command: "mock-server",
      };

      const bridge = new McpToolBridge(client, "api", serverConfig, logger);

      const registeredTools = await bridge.discoverTools();

      assert.deepEqual(registeredTools[0]!.descriptor.parameters, inputSchema);
    });
  });

  describe("handler.execute()", () => {
    it("delegates to client.callTool() with original tool name", async () => {
      let capturedName: string | null = null;
      let capturedArgs: Record<string, unknown> | null = null;

      const mockClient = {
        isConnected: true,
        async listTools() {
          return [
            {
              name: "get_weather",
              description: "Get weather",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool(name: string, args: Record<string, unknown>) {
          capturedName = name;
          capturedArgs = args;
          return {
            content: [{ type: "text", text: "Sunny, 72°F" }],
            isError: false,
          };
        },
        async connect() {},
        async disconnect() {},
      } as unknown as McpClient;

      const logger = createMockLogger();
      const serverConfig: McpServerConfig = {
        command: "mock-server",
      };

      const bridge = new McpToolBridge(mockClient, "weather", serverConfig, logger);

      const registeredTools = await bridge.discoverTools();
      const handler = registeredTools[0]!.handler;

      const params = { location: "New York" };
      const result = await handler.execute(params, {
        sessionId: "test",
        capabilities: [],
        scratchDir: "/tmp",
        timeout: 5000,
        secrets: new Map(),
      });

      assert.equal(capturedName, "get_weather");
      assert.deepEqual(capturedArgs, params);
      assert.equal(result.success, true);
      assert.equal(result.output, "Sunny, 72°F");
    });

    it("extracts text content from MCP response", async () => {
      const mockClient = {
        isConnected: true,
        async listTools() {
          return [
            {
              name: "query",
              description: "Query",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool() {
          return {
            content: [
              { type: "text", text: "First part" },
              { type: "text", text: "Second part" },
              { type: "image", url: "data:image/png;..." },
            ],
            isError: false,
          };
        },
        async connect() {},
        async disconnect() {},
      } as unknown as McpClient;

      const logger = createMockLogger();
      const bridge = new McpToolBridge(mockClient, "api", { command: "mock" }, logger);

      const registeredTools = await bridge.discoverTools();
      const handler = registeredTools[0]!.handler;

      const result = await handler.execute(
        {},
        {
          sessionId: "test",
          capabilities: [],
          scratchDir: "/tmp",
          timeout: 5000,
          secrets: new Map(),
        },
      );

      assert.equal(result.output, "First part\nSecond part");
    });

    it("returns success:false when client is not connected", async () => {
      const mockClient = {
        isConnected: false,
        async listTools() {
          return [
            {
              name: "tool",
              description: "Tool",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool() {
          throw new Error("Should not be called");
        },
        async connect() {},
        async disconnect() {},
      } as unknown as McpClient;

      const logger = createMockLogger();
      const bridge = new McpToolBridge(mockClient, "disconnected", { command: "mock" }, logger);

      const registeredTools = await bridge.discoverTools();
      const handler = registeredTools[0]!.handler;

      const result = await handler.execute(
        {},
        {
          sessionId: "test",
          capabilities: [],
          scratchDir: "/tmp",
          timeout: 5000,
          secrets: new Map(),
        },
      );

      assert.equal(result.success, false);
      assert.match(result.error as string, /not connected/);
    });

    it("handles isError:true in MCP response", async () => {
      const mockClient = {
        isConnected: true,
        async listTools() {
          return [
            {
              name: "failing",
              description: "Failing",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool() {
          return {
            content: [{ type: "text", text: "Error: Invalid input" }],
            isError: true,
          };
        },
        async connect() {},
        async disconnect() {},
      } as unknown as McpClient;

      const logger = createMockLogger();
      const bridge = new McpToolBridge(mockClient, "api", { command: "mock" }, logger);

      const registeredTools = await bridge.discoverTools();
      const handler = registeredTools[0]!.handler;

      const result = await handler.execute(
        {},
        {
          sessionId: "test",
          capabilities: [],
          scratchDir: "/tmp",
          timeout: 5000,
          secrets: new Map(),
        },
      );

      assert.equal(result.success, false);
      assert.equal(result.error, "Error: Invalid input");
    });

    it("catches exceptions from client.callTool()", async () => {
      const mockClient = {
        isConnected: true,
        async listTools() {
          return [
            {
              name: "broken",
              description: "Broken",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool() {
          throw new Error("Connection lost");
        },
        async connect() {},
        async disconnect() {},
      } as unknown as McpClient;

      const logger = createMockLogger();
      const bridge = new McpToolBridge(mockClient, "unstable", { command: "mock" }, logger);

      const registeredTools = await bridge.discoverTools();
      const handler = registeredTools[0]!.handler;

      const result = await handler.execute(
        {},
        {
          sessionId: "test",
          capabilities: [],
          scratchDir: "/tmp",
          timeout: 5000,
          secrets: new Map(),
        },
      );

      assert.equal(result.success, false);
      assert.equal(result.error, "Connection lost");
    });

    it("measures execution duration in durationMs", async () => {
      const mockClient = {
        isConnected: true,
        async listTools() {
          return [
            {
              name: "slow",
              description: "Slow",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            content: [{ type: "text", text: "Done" }],
            isError: false,
          };
        },
        async connect() {},
        async disconnect() {},
      } as unknown as McpClient;

      const logger = createMockLogger();
      const bridge = new McpToolBridge(mockClient, "api", { command: "mock" }, logger);

      const registeredTools = await bridge.discoverTools();
      const handler = registeredTools[0]!.handler;

      const result = await handler.execute(
        {},
        {
          sessionId: "test",
          capabilities: [],
          scratchDir: "/tmp",
          timeout: 5000,
          secrets: new Map(),
        },
      );

      assert.ok(result.durationMs >= 50);
    });

    it("passes through original MCP tool name in error messages", async () => {
      const mockClient = {
        isConnected: true,
        async listTools() {
          return [
            {
              name: "original_name",
              description: "Tool",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool() {
          return {
            content: [{ type: "text", text: "Tool not found" }],
            isError: true,
          };
        },
        async connect() {},
        async disconnect() {},
      } as unknown as McpClient;

      const logger = createMockLogger();
      const bridge = new McpToolBridge(mockClient, "api", { command: "mock" }, logger);

      const registeredTools = await bridge.discoverTools();

      // Verify the registered name is prefixed
      assert.equal(registeredTools[0]!.descriptor.name, "mcp__api__original_name");

      // But handler should work with original name internally
      const handler = registeredTools[0]!.handler;
      const result = await handler.execute(
        {},
        {
          sessionId: "test",
          capabilities: [],
          scratchDir: "/tmp",
          timeout: 5000,
          secrets: new Map(),
        },
      );

      assert.equal(result.success, false);
    });
  });

  describe("empty capabilities", () => {
    it("accepts server config with no capabilities specified", async () => {
      const tools: McpToolDefinition[] = [
        {
          name: "tool",
          description: "Tool",
          inputSchema: { type: "object" },
        },
      ];

      const client = createMockMcpClient(tools);
      const logger = createMockLogger();
      const serverConfig: McpServerConfig = {
        command: "mock-server",
        // capabilities undefined
      };

      const bridge = new McpToolBridge(client, "api", serverConfig, logger);

      const registeredTools = await bridge.discoverTools();

      assert.deepEqual(registeredTools[0]!.descriptor.capabilities, []);
    });
  });

  describe("special characters in tool names", () => {
    it("properly namespaces tools with underscores and hyphens", async () => {
      const tools: McpToolDefinition[] = [
        {
          name: "get_weather_data",
          description: "Get weather",
          inputSchema: { type: "object" },
        },
      ];

      const client = createMockMcpClient(tools);
      const logger = createMockLogger();
      const bridge = new McpToolBridge(client, "weather-api-v2", { command: "mock" }, logger);

      const registeredTools = await bridge.discoverTools();

      assert.equal(registeredTools[0]!.descriptor.name, "mcp__weather-api-v2__get_weather_data");
    });
  });
});
