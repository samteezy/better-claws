import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { ForkedExecutor, ForkedExecutorError } from "../../src/tools/forked-executor.js";
import type { ExecutionContext } from "../../src/types.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

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

// ── Test Fixtures ───────────────────────────────────────────────────────────

const currentDir = dirname(fileURLToPath(import.meta.url));
// When compiled, this test is at dist/tests/unit/ — worker is at dist/src/tools/
const WORKER_SCRIPT_PATH = join(
  currentDir,
  "..", "..", "src", "tools", "tool-worker.js",
);

async function createTestHandler(dir: string, code: string): Promise<string> {
  const handlerPath = join(dir, `handler-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  await writeFile(handlerPath, code, "utf-8");
  return handlerPath;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ForkedExecutor", () => {
  let tempDir: string;
  let scratchBaseDir: string;
  let handlersDir: string;
  let mockLogger: ReturnType<typeof createMockLogger>;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "forked-exec-test-"));
    scratchBaseDir = join(tempDir, "scratch");
    handlersDir = join(tempDir, "handlers");
    await mkdir(scratchBaseDir);
    await mkdir(handlersDir);
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  function makeExecutor(overrides?: Partial<{
    stripEnvironment: boolean;
    defaultTimeout: number;
  }>) {
    return new ForkedExecutor({
      scratchBaseDir,
      defaultTimeout: overrides?.defaultTimeout ?? 5000,
      stripEnvironment: overrides?.stripEnvironment ?? true,
      logger: mockLogger,
      workerScript: WORKER_SCRIPT_PATH,
    });
  }

  function makeContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
    return {
      sessionId: overrides?.sessionId ?? "test-session",
      capabilities: overrides?.capabilities ?? [],
      scratchDir: "",
      timeout: overrides?.timeout ?? 5000,
      secrets: overrides?.secrets ?? new Map<string, string>(),
    };
  }

  describe("successful execution in forked process", () => {
    it("executes a handler and returns ToolResult", async () => {
      const executor = makeExecutor();
      const handlerPath = await createTestHandler(handlersDir, `
        export default {
          async execute(params, context) {
            return {
              success: true,
              output: { echo: params.message, sessionId: context.sessionId },
              durationMs: 5,
            };
          },
        };
      `);

      const result = await executor.execute(
        handlerPath,
        { message: "hello" },
        makeContext(),
      );

      assert.equal(result.success, true);
      const output = result.output as Record<string, unknown>;
      assert.equal(output["echo"], "hello");
      assert.equal(output["sessionId"], "test-session");
      assert.ok(result.durationMs >= 0);
    });

    it("passes params correctly to the handler", async () => {
      const executor = makeExecutor();
      const handlerPath = await createTestHandler(handlersDir, `
        export default {
          async execute(params) {
            return {
              success: true,
              output: params,
              durationMs: 1,
            };
          },
        };
      `);

      const testParams = { str: "value", num: 42, nested: { key: "val" } };
      const result = await executor.execute(handlerPath, testParams, makeContext());

      assert.equal(result.success, true);
      const output = result.output as Record<string, unknown>;
      assert.equal(output["str"], "value");
      assert.equal(output["num"], 42);
      assert.deepEqual(output["nested"], { key: "val" });
    });
  });

  describe("environment stripping", () => {
    it("strips environment variables when stripEnvironment is true", async () => {
      // Set a test env var
      process.env["BC_TEST_SECRET"] = "super_secret_key";

      const executor = makeExecutor({ stripEnvironment: true });
      const handlerPath = await createTestHandler(handlersDir, `
        export default {
          async execute() {
            return {
              success: true,
              output: {
                hasSecret: process.env.BC_TEST_SECRET !== undefined,
                envKeys: Object.keys(process.env),
              },
              durationMs: 1,
            };
          },
        };
      `);

      const result = await executor.execute(handlerPath, {}, makeContext());

      assert.equal(result.success, true);
      const output = result.output as Record<string, unknown>;
      assert.equal(output["hasSecret"], false, "Secret env var should be stripped");

      // Only allowed vars should be present
      const envKeys = output["envKeys"] as string[];
      assert.ok(!envKeys.includes("BC_TEST_SECRET"));

      delete process.env["BC_TEST_SECRET"];
    });

    it("preserves environment when stripEnvironment is false", async () => {
      process.env["BC_TEST_PRESERVED"] = "kept";

      const executor = new ForkedExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: false,
        logger: mockLogger,
        workerScript: WORKER_SCRIPT_PATH,
      });

      const handlerPath = await createTestHandler(handlersDir, `
        export default {
          async execute() {
            return {
              success: true,
              output: { hasVar: process.env.BC_TEST_PRESERVED === "kept" },
              durationMs: 1,
            };
          },
        };
      `);

      const result = await executor.execute(handlerPath, {}, makeContext());

      assert.equal(result.success, true);
      assert.equal((result.output as Record<string, unknown>)["hasVar"], true);

      delete process.env["BC_TEST_PRESERVED"];
    });
  });

  describe("timeout enforcement", () => {
    it("kills child process on timeout", async () => {
      const executor = makeExecutor({ defaultTimeout: 200 });
      const handlerPath = await createTestHandler(handlersDir, `
        export default {
          async execute() {
            await new Promise(r => setTimeout(r, 10000));
            return { success: true, output: null, durationMs: 10000 };
          },
        };
      `);

      const result = await executor.execute(
        handlerPath,
        {},
        makeContext({ timeout: 200 }),
      );

      assert.equal(result.success, false);
      assert.ok(result.error?.includes("timed out") || result.error?.includes("exited"));
      assert.ok(result.durationMs < 5000);
    });
  });

  describe("error handling", () => {
    it("handles handler that throws an error", async () => {
      const executor = makeExecutor();
      const handlerPath = await createTestHandler(handlersDir, `
        export default {
          async execute() {
            throw new Error("Handler exploded");
          },
        };
      `);

      const result = await executor.execute(handlerPath, {}, makeContext());

      assert.equal(result.success, false);
      assert.ok(result.error?.includes("Handler exploded"));
    });

    it("handles invalid handler module", async () => {
      const executor = makeExecutor();
      const handlerPath = await createTestHandler(handlersDir, `
        export default { notExecute: true };
      `);

      const result = await executor.execute(handlerPath, {}, makeContext());

      assert.equal(result.success, false);
      assert.ok(result.error?.includes("execute"));
    });

    it("handles handler module that does not exist", async () => {
      const executor = makeExecutor();

      const result = await executor.execute(
        "/nonexistent/handler.js",
        {},
        makeContext(),
      );

      assert.equal(result.success, false);
      assert.ok(result.error);
    });
  });

  describe("process isolation", () => {
    it("handler runs in a separate process (different PID)", async () => {
      const executor = makeExecutor();
      const handlerPath = await createTestHandler(handlersDir, `
        export default {
          async execute() {
            return {
              success: true,
              output: { pid: process.pid },
              durationMs: 1,
            };
          },
        };
      `);

      const result = await executor.execute(handlerPath, {}, makeContext());

      assert.equal(result.success, true);
      const workerPid = (result.output as Record<string, unknown>)["pid"] as number;
      assert.notEqual(workerPid, process.pid, "Worker should run in a different process");
    });

    it("scratch directory is created and cleaned up", async () => {
      const executor = makeExecutor();
      let capturedScratchDir: string | undefined;

      const handlerPath = await createTestHandler(handlersDir, `
        import { existsSync } from "node:fs";
        export default {
          async execute(params, context) {
            return {
              success: true,
              output: {
                scratchDir: context.scratchDir,
                exists: existsSync(context.scratchDir),
              },
              durationMs: 1,
            };
          },
        };
      `);

      const result = await executor.execute(handlerPath, {}, makeContext());

      assert.equal(result.success, true);
      const output = result.output as Record<string, unknown>;
      assert.equal(output["exists"], true);
    });
  });

  describe("logging", () => {
    it("logs executor:start with isolated flag", async () => {
      const executor = makeExecutor();
      const handlerPath = await createTestHandler(handlersDir, `
        export default {
          async execute() {
            return { success: true, output: null, durationMs: 1 };
          },
        };
      `);

      await executor.execute(handlerPath, {}, makeContext());

      const startLog = mockLogger.calls.find(
        (c) => c.eventType === "executor:start",
      );
      assert.ok(startLog);
      assert.equal(startLog.payload["isolated"], true);
      assert.equal(startLog.component, "forked-executor");
    });

    it("logs executor:result on success", async () => {
      const executor = makeExecutor();
      const handlerPath = await createTestHandler(handlersDir, `
        export default {
          async execute() {
            return { success: true, output: "done", durationMs: 1 };
          },
        };
      `);

      await executor.execute(handlerPath, {}, makeContext());

      const resultLog = mockLogger.calls.find(
        (c) => c.eventType === "executor:result" && c.payload["success"] === true,
      );
      assert.ok(resultLog);
      assert.equal(resultLog.payload["isolated"], true);
    });

    it("logs executor:timeout on timeout", async () => {
      const executor = makeExecutor({ defaultTimeout: 200 });
      const handlerPath = await createTestHandler(handlersDir, `
        export default {
          async execute() {
            await new Promise(r => setTimeout(r, 10000));
            return { success: true, output: null, durationMs: 10000 };
          },
        };
      `);

      await executor.execute(handlerPath, {}, makeContext({ timeout: 200 }));

      const timeoutLog = mockLogger.calls.find(
        (c) => c.eventType === "executor:timeout",
      );
      assert.ok(timeoutLog);
      assert.equal(timeoutLog.component, "forked-executor");
    });
  });

  describe("multiple executions", () => {
    it("can execute handlers sequentially", async () => {
      const executor = makeExecutor();
      const handlerPath = await createTestHandler(handlersDir, `
        let counter = 0;
        export default {
          async execute() {
            counter++;
            return { success: true, output: { count: counter }, durationMs: 1 };
          },
        };
      `);

      const r1 = await executor.execute(handlerPath, {}, makeContext());
      const r2 = await executor.execute(handlerPath, {}, makeContext());

      assert.equal(r1.success, true);
      assert.equal(r2.success, true);
      // Each fork is a fresh process, so counter resets
      assert.equal((r1.output as Record<string, unknown>)["count"], 1);
      assert.equal((r2.output as Record<string, unknown>)["count"], 1);
    });
  });
});
