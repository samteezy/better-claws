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
            assert.match((err as RegistryError).message, /Duplicate tool name/);
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
});
