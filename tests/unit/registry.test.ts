import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry } from "../../src/tools/registry.js";
import { RegistryError } from "../../src/tools/registry.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

function createMockLogger() {
  const calls: Array<{
    sessionId: string | null;
    eventType: string;
    component: string;
    payload: Record<string, unknown>;
  }> = [];
  return {
    calls,
    log(entry: {
      sessionId: string | null;
      eventType: string;
      component: string;
      payload: Record<string, unknown>;
    }): void {
      calls.push(entry);
    },
    async flush(): Promise<void> {},
    async close(): Promise<void> {},
  } as unknown as StructuredLogger & { calls: typeof calls };
}

describe("ToolRegistry", () => {
  let tempDir: string;
  let mockLogger: ReturnType<typeof createMockLogger>;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "registry-test-"));
    mockLogger = createMockLogger();
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("loadTools()", () => {
    it("loads tools from fixture directory with valid descriptor.json and handler.js", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-valid-"));
      try {
        // Create a tool directory with descriptor.json
        const toolDir = join(toolsDir, "test-tool");
        await mkdir(toolDir);

        const descriptor = {
          name: "test-tool",
          description: "A test tool",
          parameters: {
            type: "object",
            properties: {
              input: { type: "string" },
            },
          },
          capabilities: ["fs:read"],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));

        // Create a handler.js that exports an execute function
        const handlerCode = `
export const execute = async (params, context) => {
  return {
    success: true,
    output: { received: params },
    durationMs: 10,
  };
};
`;
        await writeFile(join(toolDir, "handler.js"), handlerCode);

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await registry.loadTools();

        const descriptors = registry.getDescriptors();
        assert.equal(descriptors.length, 1);
        assert.equal(descriptors[0]?.name, "test-tool");
        assert.equal(descriptors[0]?.description, "A test tool");
        assert.deepEqual(descriptors[0]?.capabilities, ["fs:read"]);
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("rejects descriptor with missing capabilities array", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-missing-caps-"));
      try {
        const toolDir = join(toolsDir, "bad-tool");
        await mkdir(toolDir);

        const descriptor = {
          name: "bad-tool",
          description: "Missing capabilities",
          parameters: { type: "object" },
          // missing capabilities array
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));
        await writeFile(join(toolDir, "handler.js"), "export const execute = async () => {};");

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await assert.rejects(
          () => registry.loadTools(),
          (err) => {
            assert.ok(err instanceof RegistryError);
            assert.match(
              (err as RegistryError).message,
              /missing "capabilities" array/,
            );
            return true;
          },
        );
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("rejects descriptor with unknown capability strings", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-unknown-cap-"));
      try {
        const toolDir = join(toolsDir, "bad-cap-tool");
        await mkdir(toolDir);

        const descriptor = {
          name: "bad-cap-tool",
          description: "Unknown capability",
          parameters: { type: "object" },
          capabilities: ["fs:read", "invalid:capability"],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));
        await writeFile(join(toolDir, "handler.js"), "export const execute = async () => {};");

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await assert.rejects(
          () => registry.loadTools(),
          (err) => {
            assert.ok(err instanceof RegistryError);
            assert.match(
              (err as RegistryError).message,
              /unknown capability: "invalid:capability"/,
            );
            return true;
          },
        );
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("rejects duplicate tool names", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-dup-names-"));
      try {
        // Create two tool directories with the same name
        const tool1Dir = join(toolsDir, "tool-1");
        const tool2Dir = join(toolsDir, "tool-2");

        for (const dir of [tool1Dir, tool2Dir]) {
          await mkdir(dir);

          const descriptor = {
            name: "duplicated-tool", // Same name for both
            description: "Duplicate tool",
            parameters: { type: "object" },
            capabilities: [],
          };

          await writeFile(join(dir, "descriptor.json"), JSON.stringify(descriptor));
          await writeFile(join(dir, "handler.js"), "export const execute = async () => {};");
        }

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await assert.rejects(
          () => registry.loadTools(),
          (err) => {
            assert.ok(err instanceof RegistryError);
            assert.match((err as RegistryError).message, /conflicts with existing tool/);
            return true;
          },
        );
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });
  });

  describe("getDescriptors()", () => {
    it("returns loaded tools", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-get-desc-"));
      try {
        // Create two tools
        for (const toolName of ["tool-a", "tool-b"]) {
          const toolDir = join(toolsDir, toolName);
          await mkdir(toolDir);

          const descriptor = {
            name: toolName,
            description: `Tool ${toolName}`,
            parameters: { type: "object" },
            capabilities: ["fs:read"],
          };

          await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));
          await writeFile(join(toolDir, "handler.js"), "export const execute = async () => {};");
        }

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await registry.loadTools();
        const descriptors = registry.getDescriptors();

        assert.equal(descriptors.length, 2);
        const names = descriptors.map((d) => d.name).sort();
        assert.deepEqual(names, ["tool-a", "tool-b"]);
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });
  });

  describe("getHandler()", () => {
    it("returns undefined for unknown tool", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-unknown-tool-"));
      try {
        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await registry.loadTools();
        const handler = registry.getHandler("nonexistent-tool");

        assert.equal(handler, undefined);
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("returns handler for loaded tool", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-get-handler-"));
      try {
        const toolDir = join(toolsDir, "my-tool");
        await mkdir(toolDir);

        const descriptor = {
          name: "my-tool",
          description: "Test tool",
          parameters: { type: "object" },
          capabilities: [],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));
        await writeFile(join(toolDir, "handler.js"), "export const execute = async () => {};");

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await registry.loadTools();
        const handler = registry.getHandler("my-tool");

        assert.ok(handler !== undefined);
        assert.ok(typeof (handler as unknown as Record<string, unknown>)["execute"] === "function");
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });
  });

  describe("graceful handling of missing tools directory", () => {
    it("returns without error when tools directory does not exist", async () => {
      const nonexistentDir = join(tempDir, "nonexistent-tools-dir");

      const registry = new ToolRegistry({
        toolsDirectory: nonexistentDir,
        logger: mockLogger,
      });

      // Should not throw
      await registry.loadTools();

      // Registry should be empty
      assert.equal(registry.getDescriptors().length, 0);
    });
  });

  describe("tool loading validation", () => {
    it("accepts handler exported as default.execute", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-default-export-"));
      try {
        const toolDir = join(toolsDir, "default-export-tool");
        await mkdir(toolDir);

        const descriptor = {
          name: "default-export-tool",
          description: "Tool with default export",
          parameters: { type: "object" },
          capabilities: [],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));

        // Export as default object with execute method
        const handlerCode = `
export default {
  execute: async (params, context) => ({
    success: true,
    output: null,
    durationMs: 0,
  }),
};
`;
        await writeFile(join(toolDir, "handler.js"), handlerCode);

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await registry.loadTools();
        const handler = registry.getHandler("default-export-tool");

        assert.ok(handler !== undefined);
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("rejects handler with invalid export", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-invalid-export-"));
      try {
        const toolDir = join(toolsDir, "invalid-export-tool");
        await mkdir(toolDir);

        const descriptor = {
          name: "invalid-export-tool",
          description: "Tool with invalid handler export",
          parameters: { type: "object" },
          capabilities: [],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));

        // Export something invalid
        const handlerCode = `
export const notExecute = async () => {};
`;
        await writeFile(join(toolDir, "handler.js"), handlerCode);

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await assert.rejects(
          () => registry.loadTools(),
          (err) => {
            assert.ok(err instanceof RegistryError);
            assert.match(
              (err as RegistryError).message,
              /must export an "execute" function/,
            );
            return true;
          },
        );
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("logs tool loading events", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-logging-"));
      try {
        const toolDir = join(toolsDir, "logged-tool");
        await mkdir(toolDir);

        const descriptor = {
          name: "logged-tool",
          description: "Tool that logs loading",
          parameters: { type: "object" },
          capabilities: ["fs:read"],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));
        await writeFile(join(toolDir, "handler.js"), "export const execute = async () => {};");

        const testLogger = createMockLogger();
        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: testLogger,
        });

        await registry.loadTools();

        // Should have logged a tool:invoke event with action "loaded"
        const loadedEvent = testLogger.calls.find(
          (c) => c.eventType === "tool:invoke" && c.payload.action === "loaded",
        );
        assert.ok(loadedEvent !== undefined);
        assert.equal(loadedEvent?.payload.tool, "logged-tool");
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });
  });

  describe("descriptor validation", () => {
    it("rejects descriptor with missing name", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-missing-name-"));
      try {
        const toolDir = join(toolsDir, "no-name");
        await mkdir(toolDir);

        const descriptor = {
          // missing name
          description: "No name tool",
          parameters: { type: "object" },
          capabilities: [],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));
        await writeFile(join(toolDir, "handler.js"), "export const execute = async () => {};");

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await assert.rejects(
          () => registry.loadTools(),
          (err) => {
            assert.ok(err instanceof RegistryError);
            assert.match((err as RegistryError).message, /missing "name"/);
            return true;
          },
        );
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("rejects descriptor with missing description", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-missing-desc-"));
      try {
        const toolDir = join(toolsDir, "no-desc");
        await mkdir(toolDir);

        const descriptor = {
          name: "no-desc",
          // missing description
          parameters: { type: "object" },
          capabilities: [],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));
        await writeFile(join(toolDir, "handler.js"), "export const execute = async () => {};");

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await assert.rejects(
          () => registry.loadTools(),
          (err) => {
            assert.ok(err instanceof RegistryError);
            assert.match((err as RegistryError).message, /missing "description"/);
            return true;
          },
        );
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("rejects descriptor with missing parameters", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-missing-params-"));
      try {
        const toolDir = join(toolsDir, "no-params");
        await mkdir(toolDir);

        const descriptor = {
          name: "no-params",
          description: "No parameters",
          // missing parameters
          capabilities: [],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));
        await writeFile(join(toolDir, "handler.js"), "export const execute = async () => {};");

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await assert.rejects(
          () => registry.loadTools(),
          (err) => {
            assert.ok(err instanceof RegistryError);
            assert.match((err as RegistryError).message, /missing "parameters"/);
            return true;
          },
        );
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });
  });

  describe("multiple capabilities", () => {
    it("accepts multiple capabilities in descriptor", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-multi-cap-"));
      try {
        const toolDir = join(toolsDir, "multi-cap-tool");
        await mkdir(toolDir);

        const descriptor = {
          name: "multi-cap-tool",
          description: "Tool with multiple capabilities",
          parameters: { type: "object" },
          capabilities: ["fs:read", "fs:write", "net:outbound"],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));
        await writeFile(join(toolDir, "handler.js"), "export const execute = async () => {};");

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await registry.loadTools();
        const descriptors = registry.getDescriptors();

        assert.equal(descriptors.length, 1);
        assert.deepEqual(descriptors[0]?.capabilities, ["fs:read", "fs:write", "net:outbound"]);
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("accepts empty capabilities array", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-empty-cap-"));
      try {
        const toolDir = join(toolsDir, "no-cap-tool");
        await mkdir(toolDir);

        const descriptor = {
          name: "no-cap-tool",
          description: "Tool with no capabilities",
          parameters: { type: "object" },
          capabilities: [],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));
        await writeFile(join(toolDir, "handler.js"), "export const execute = async () => {};");

        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await registry.loadTools();
        const descriptors = registry.getDescriptors();

        assert.equal(descriptors.length, 1);
        assert.deepEqual(descriptors[0]?.capabilities, []);
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });
  });

  describe("built-in tools", () => {
    it("built-in tools appear in getDescriptors()", async () => {
      const builtInDescriptor = {
        name: "built-in-test-tool",
        description: "A built-in test tool",
        parameters: { type: "object" as const, properties: { input: { type: "string" } } },
        capabilities: ["fs:read"] as const,
      };

      const builtInHandler = {
        execute: async () => ({
          success: true,
          output: { received: "test" },
          durationMs: 10,
        }),
      };

      const registry = new ToolRegistry({
        builtInTools: [
          {
            descriptor: builtInDescriptor,
            handler: builtInHandler,
          },
        ],
        logger: mockLogger,
      });

      await registry.loadTools();

      const descriptors = registry.getDescriptors();
      assert.equal(descriptors.length, 1);
      assert.equal(descriptors[0]?.name, "built-in-test-tool");
      assert.equal(descriptors[0]?.description, "A built-in test tool");
      assert.deepEqual(descriptors[0]?.capabilities, ["fs:read"]);
    });

    it("built-in tools are accessible via getHandler()", async () => {
      const builtInDescriptor = {
        name: "handler-test-tool",
        description: "Test handler retrieval",
        parameters: { type: "object" as const },
        capabilities: [] as const,
      };

      const testPayload = { test: "data" };
      const builtInHandler = {
        execute: async () => ({
          success: true,
          output: testPayload,
          durationMs: 5,
        }),
      };

      const registry = new ToolRegistry({
        builtInTools: [
          {
            descriptor: builtInDescriptor,
            handler: builtInHandler,
          },
        ],
        logger: mockLogger,
      });

      await registry.loadTools();

      const handler = registry.getHandler("handler-test-tool");
      assert.ok(handler !== undefined);
      assert.ok(handler);

      // Verify the handler works correctly
      const result = await handler.execute(
        {},
        { sessionId: "test", capabilities: [], scratchDir: "/tmp", timeout: 5000, secrets: new Map<string, string>() },
      );
      assert.deepEqual(result.output, testPayload);
    });

    it("plugin name conflicting with built-in throws DUPLICATE_TOOL", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-builtin-conflict-"));
      try {
        const builtInDescriptor = {
          name: "conflict-tool",
          description: "Built-in tool",
          parameters: { type: "object" as const },
          capabilities: [] as const,
        };

        const builtInHandler = {
          execute: async () => ({
            success: true,
            output: null,
            durationMs: 0,
          }),
        };

        // Create a plugin with the same name
        const pluginDir = join(toolsDir, "conflict-tool");
        await mkdir(pluginDir);

        const pluginDescriptor = {
          name: "conflict-tool",
          description: "Plugin tool",
          parameters: { type: "object" },
          capabilities: [],
        };

        await writeFile(join(pluginDir, "descriptor.json"), JSON.stringify(pluginDescriptor));
        await writeFile(join(pluginDir, "handler.js"), "export const execute = async () => {};");

        const registry = new ToolRegistry({
          builtInTools: [
            {
              descriptor: builtInDescriptor,
              handler: builtInHandler,
            },
          ],
          pluginDirectory: toolsDir,
          logger: mockLogger,
        });

        await assert.rejects(
          () => registry.loadTools(),
          (err) => {
            assert.ok(err instanceof RegistryError);
            assert.match(
              (err as RegistryError).message,
              /conflicts with existing tool/,
            );
            return true;
          },
        );
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("built-in tools and plugins coexist", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-coexist-"));
      try {
        const builtInDescriptor = {
          name: "builtin-tool",
          description: "Built-in tool",
          parameters: { type: "object" as const },
          capabilities: ["fs:read"] as const,
        };

        const builtInHandler = {
          execute: async () => ({
            success: true,
            output: { source: "builtin" },
            durationMs: 5,
          }),
        };

        // Create a plugin with a different name
        const pluginDir = join(toolsDir, "plugin-tool");
        await mkdir(pluginDir);

        const pluginDescriptor = {
          name: "plugin-tool",
          description: "Plugin tool",
          parameters: { type: "object" },
          capabilities: ["fs:write"],
        };

        await writeFile(join(pluginDir, "descriptor.json"), JSON.stringify(pluginDescriptor));
        await writeFile(join(pluginDir, "handler.js"), "export const execute = async () => {};");

        const registry = new ToolRegistry({
          builtInTools: [
            {
              descriptor: builtInDescriptor,
              handler: builtInHandler,
            },
          ],
          pluginDirectory: toolsDir,
          logger: mockLogger,
        });

        await registry.loadTools();

        const descriptors = registry.getDescriptors();
        assert.equal(descriptors.length, 2);

        const names = descriptors.map((d) => d.name).sort();
        assert.deepEqual(names, ["builtin-tool", "plugin-tool"]);

        // Verify both handlers are accessible
        const builtinHandler = registry.getHandler("builtin-tool");
        const pluginHandler = registry.getHandler("plugin-tool");

        assert.ok(builtinHandler !== undefined);
        assert.ok(pluginHandler !== undefined);
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("built-in tools log with source: 'built-in'", async () => {
      const builtInDescriptor = {
        name: "logging-builtin-tool",
        description: "Tool that logs",
        parameters: { type: "object" as const },
        capabilities: [] as const,
      };

      const builtInHandler = {
        execute: async () => ({
          success: true,
          output: null,
          durationMs: 0,
        }),
      };

      const testLogger = createMockLogger();
      const registry = new ToolRegistry({
        builtInTools: [
          {
            descriptor: builtInDescriptor,
            handler: builtInHandler,
          },
        ],
        logger: testLogger,
      });

      await registry.loadTools();

      // Find the tool:invoke log entry for the built-in tool
      const logEntry = testLogger.calls.find(
        (c) =>
          c.eventType === "tool:invoke" &&
          c.payload.action === "loaded" &&
          c.payload.tool === "logging-builtin-tool",
      );

      assert.ok(logEntry !== undefined);
      assert.equal(logEntry?.payload.source, "built-in");
    });

    it("pluginDirectory alias works with toolsDirectory", async () => {
      const toolsDir = await mkdtemp(join(tmpdir(), "registry-alias-"));
      try {
        const toolDir = join(toolsDir, "alias-test-tool");
        await mkdir(toolDir);

        const descriptor = {
          name: "alias-test-tool",
          description: "Tool for testing alias",
          parameters: { type: "object" },
          capabilities: [],
        };

        await writeFile(join(toolDir, "descriptor.json"), JSON.stringify(descriptor));
        await writeFile(join(toolDir, "handler.js"), "export const execute = async () => {};");

        // Use deprecated toolsDirectory option (should work as alias)
        const registry = new ToolRegistry({
          toolsDirectory: toolsDir,
          logger: mockLogger,
        });

        await registry.loadTools();

        const descriptors = registry.getDescriptors();
        assert.equal(descriptors.length, 1);
        assert.equal(descriptors[0]?.name, "alias-test-tool");
      } finally {
        await rm(toolsDir, { recursive: true, force: true });
      }
    });

    it("multiple built-in tools are all registered", async () => {
      const builtInTool1 = {
        descriptor: {
          name: "builtin-1",
          description: "First built-in",
          parameters: { type: "object" as const },
          capabilities: ["fs:read"] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: { id: 1 },
            durationMs: 5,
          }),
        },
      };

      const builtInTool2 = {
        descriptor: {
          name: "builtin-2",
          description: "Second built-in",
          parameters: { type: "object" as const },
          capabilities: ["fs:write"] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: { id: 2 },
            durationMs: 5,
          }),
        },
      };

      const registry = new ToolRegistry({
        builtInTools: [builtInTool1, builtInTool2],
        logger: mockLogger,
      });

      await registry.loadTools();

      const descriptors = registry.getDescriptors();
      assert.equal(descriptors.length, 2);

      const names = descriptors.map((d) => d.name).sort();
      assert.deepEqual(names, ["builtin-1", "builtin-2"]);

      // Verify both are accessible
      assert.ok(registry.getHandler("builtin-1") !== undefined);
      assert.ok(registry.getHandler("builtin-2") !== undefined);
    });

    it("duplicate built-in tool names throw DUPLICATE_TOOL", async () => {
      const tool1 = {
        descriptor: {
          name: "duplicate-builtin",
          description: "First",
          parameters: { type: "object" as const },
          capabilities: [] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: null,
            durationMs: 0,
          }),
        },
      };

      const tool2 = {
        descriptor: {
          name: "duplicate-builtin",
          description: "Second",
          parameters: { type: "object" as const },
          capabilities: [] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: null,
            durationMs: 0,
          }),
        },
      };

      const registry = new ToolRegistry({
        builtInTools: [tool1, tool2],
        logger: mockLogger,
      });

      await assert.rejects(
        () => registry.loadTools(),
        (err) => {
          assert.ok(err instanceof RegistryError);
          assert.match(
            (err as RegistryError).message,
            /Duplicate built-in tool name/,
          );
          return true;
        },
      );
    });
  });

  describe("register()", () => {
    it("adds a tool to the registry that appears in getDescriptors()", async () => {
      const registry = new ToolRegistry({
        logger: mockLogger,
      });

      await registry.loadTools();

      const newTool = {
        descriptor: {
          name: "dynamic-tool",
          description: "Dynamically registered tool",
          parameters: { type: "object" as const },
          capabilities: ["fs:read"] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: { test: "data" },
            durationMs: 5,
          }),
        },
      };

      registry.register(newTool);

      const descriptors = registry.getDescriptors();
      const found = descriptors.find((d) => d.name === "dynamic-tool");

      assert.ok(found !== undefined);
      assert.equal(found.description, "Dynamically registered tool");
      assert.deepEqual(found.capabilities, ["fs:read"]);
    });

    it("throws DUPLICATE_TOOL when registering with conflicting name", async () => {
      const registry = new ToolRegistry({
        logger: mockLogger,
      });

      await registry.loadTools();

      const tool1 = {
        descriptor: {
          name: "conflict-tool",
          description: "First registration",
          parameters: { type: "object" as const },
          capabilities: [] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: null,
            durationMs: 0,
          }),
        },
      };

      const tool2 = {
        descriptor: {
          name: "conflict-tool",
          description: "Second registration",
          parameters: { type: "object" as const },
          capabilities: [] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: null,
            durationMs: 0,
          }),
        },
      };

      registry.register(tool1);

      assert.throws(
        () => registry.register(tool2),
        (err) => {
          assert.ok(err instanceof RegistryError);
          assert.match((err as RegistryError).message, /name already exists/);
          return true;
        },
      );
    });

    it("logs tool:invoke event with action 'registered'", async () => {
      const testLogger = createMockLogger();
      const registry = new ToolRegistry({
        logger: testLogger,
      });

      await registry.loadTools();

      const tool = {
        descriptor: {
          name: "logged-dynamic-tool",
          description: "Tool that logs registration",
          parameters: { type: "object" as const },
          capabilities: [] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: null,
            durationMs: 0,
          }),
        },
      };

      registry.register(tool);

      const logEntry = testLogger.calls.find(
        (c) => c.eventType === "tool:invoke" && c.payload.action === "registered",
      );

      assert.ok(logEntry !== undefined);
      assert.equal(logEntry?.payload.tool, "logged-dynamic-tool");
    });

    it("makes registered tool accessible via getHandler()", async () => {
      const registry = new ToolRegistry({
        logger: mockLogger,
      });

      await registry.loadTools();

      const tool = {
        descriptor: {
          name: "accessible-tool",
          description: "Test handler access",
          parameters: { type: "object" as const },
          capabilities: [] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: { message: "success" },
            durationMs: 5,
          }),
        },
      };

      registry.register(tool);

      const handler = registry.getHandler("accessible-tool");

      assert.ok(handler !== undefined);
      const result = await handler.execute(
        {},
        { sessionId: "test", capabilities: [], scratchDir: "/tmp", timeout: 5000, secrets: new Map<string, string>() },
      );

      assert.deepEqual(result.output, { message: "success" });
    });
  });

  describe("remove()", () => {
    it("removes a tool that was dynamically registered", async () => {
      const registry = new ToolRegistry({
        logger: mockLogger,
      });

      await registry.loadTools();

      const tool = {
        descriptor: {
          name: "removable-tool",
          description: "Tool to remove",
          parameters: { type: "object" as const },
          capabilities: [] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: null,
            durationMs: 0,
          }),
        },
      };

      registry.register(tool);

      // Verify it exists
      assert.ok(registry.getHandler("removable-tool") !== undefined);

      // Remove it
      const removed = registry.remove("removable-tool");

      assert.equal(removed, true);
      assert.equal(registry.getHandler("removable-tool"), undefined);
      assert.equal(
        registry
          .getDescriptors()
          .find((d) => d.name === "removable-tool"),
        undefined,
      );
    });

    it("returns false when removing a non-existent tool", async () => {
      const registry = new ToolRegistry({
        logger: mockLogger,
      });

      await registry.loadTools();

      const removed = registry.remove("nonexistent-tool");

      assert.equal(removed, false);
    });

    it("logs tool:invoke event with action 'removed' when tool is removed", async () => {
      const testLogger = createMockLogger();
      const registry = new ToolRegistry({
        logger: testLogger,
      });

      await registry.loadTools();

      const tool = {
        descriptor: {
          name: "logged-removal-tool",
          description: "Tool with removal logging",
          parameters: { type: "object" as const },
          capabilities: [] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: null,
            durationMs: 0,
          }),
        },
      };

      registry.register(tool);

      // Get count of log entries before removal
      const logCountBeforeRemoval = testLogger.calls.length;

      registry.remove("logged-removal-tool");

      // Check that a new log entry was added for removal
      const removalLogEntry = testLogger.calls.slice(logCountBeforeRemoval).find(
        (c) => c.eventType === "tool:invoke" && c.payload.action === "removed",
      );

      assert.ok(removalLogEntry !== undefined);
      assert.equal(removalLogEntry?.payload.tool, "logged-removal-tool");
    });

    it("does not log when removing non-existent tool", async () => {
      const testLogger = createMockLogger();
      const registry = new ToolRegistry({
        logger: testLogger,
      });

      await registry.loadTools();

      const initialCallCount = testLogger.calls.length;

      registry.remove("nonexistent-tool");

      // No new log should be added
      assert.equal(testLogger.calls.length, initialCallCount);
    });
  });

  describe("getPolicy()", () => {
    it("returns 'auto' by default for any tool", async () => {
      const registry = new ToolRegistry({
        logger: mockLogger,
      });

      await registry.loadTools();

      const tool = {
        descriptor: {
          name: "policy-test-tool",
          description: "Test policy retrieval",
          parameters: { type: "object" as const },
          capabilities: [] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: null,
            durationMs: 0,
          }),
        },
      };

      registry.register(tool);

      const policy = registry.getPolicy("policy-test-tool");

      assert.equal(policy, "auto");
    });

    it("returns configured policy from toolPolicies", async () => {
      const registry = new ToolRegistry({
        logger: mockLogger,
        toolPolicies: {
          "restricted-tool": "confirm",
          "disabled-tool": "disabled",
        },
      });

      await registry.loadTools();

      assert.equal(registry.getPolicy("restricted-tool"), "confirm");
      assert.equal(registry.getPolicy("disabled-tool"), "disabled");
    });

    it("returns 'auto' for tools not in toolPolicies", async () => {
      const registry = new ToolRegistry({
        logger: mockLogger,
        toolPolicies: {
          "specific-tool": "disabled",
        },
      });

      await registry.loadTools();

      assert.equal(registry.getPolicy("other-tool"), "auto");
    });

    it("getDescriptors() filters out disabled tools", async () => {
      const registry = new ToolRegistry({
        builtInTools: [
          {
            descriptor: {
              name: "visible-tool",
              description: "Visible",
              parameters: { type: "object" as const },
              capabilities: [] as const,
            },
            handler: {
              execute: async () => ({
                success: true,
                output: null,
                durationMs: 0,
              }),
            },
          },
          {
            descriptor: {
              name: "hidden-tool",
              description: "Hidden",
              parameters: { type: "object" as const },
              capabilities: [] as const,
            },
            handler: {
              execute: async () => ({
                success: true,
                output: null,
                durationMs: 0,
              }),
            },
          },
        ],
        logger: mockLogger,
        toolPolicies: {
          "hidden-tool": "disabled",
        },
      });

      await registry.loadTools();

      const descriptors = registry.getDescriptors();

      assert.equal(descriptors.length, 1);
      assert.equal(descriptors[0]?.name, "visible-tool");
    });

    it("getHandler() still returns handler for disabled tools", async () => {
      const registry = new ToolRegistry({
        logger: mockLogger,
        toolPolicies: {
          "disabled-tool": "disabled",
        },
      });

      await registry.loadTools();

      const tool = {
        descriptor: {
          name: "disabled-tool",
          description: "Disabled but still accessible",
          parameters: { type: "object" as const },
          capabilities: [] as const,
        },
        handler: {
          execute: async () => ({
            success: true,
            output: { test: "data" },
            durationMs: 5,
          }),
        },
      };

      registry.register(tool);

      // Handler should still be accessible
      const handler = registry.getHandler("disabled-tool");
      assert.ok(handler !== undefined);

      // But it should not appear in getDescriptors()
      const descriptors = registry.getDescriptors();
      const found = descriptors.find((d) => d.name === "disabled-tool");
      assert.equal(found, undefined);
    });
  });
});
