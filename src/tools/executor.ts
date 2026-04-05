import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BetterClawsError,
  type ExecutionContext,
  type ToolHandler,
  type ToolResult,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";

export class ExecutorError extends BetterClawsError {
  constructor(message: string, code: string = "EXECUTOR_ERROR") {
    super(message, "executor", code);
    this.name = "ExecutorError";
  }
}

export interface ToolExecutorOptions {
  readonly scratchBaseDir: string;
  readonly defaultTimeout: number;
  readonly stripEnvironment: boolean;
  readonly logger: StructuredLogger;
}

export class ToolExecutor {
  private readonly scratchBaseDir: string;
  private readonly defaultTimeout: number;
  private readonly logger: StructuredLogger;

  constructor(options: ToolExecutorOptions) {
    this.scratchBaseDir = options.scratchBaseDir;
    this.defaultTimeout = options.defaultTimeout;
    this.logger = options.logger;
  }

  async execute(
    handler: ToolHandler,
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const scratchDir = await this.createScratchDir(context.sessionId);
    const timeout = context.timeout || this.defaultTimeout;

    const executionContext: ExecutionContext = {
      ...context,
      scratchDir,
      timeout,
    };

    this.logger.log({
      sessionId: context.sessionId,
      eventType: "executor:start",
      component: "executor",
      payload: { scratchDir, timeout },
    });

    const startTime = Date.now();

    try {
      const output = await Promise.race([
        handler.execute(params, executionContext),
        this.timeoutPromise(timeout),
      ]);

      this.logger.log({
        sessionId: context.sessionId,
        eventType: "executor:result",
        component: "executor",
        payload: {
          success: output.success,
          durationMs: output.durationMs,
        },
      });

      return output;
    } catch (err) {
      const durationMs = Date.now() - startTime;

      if (err instanceof ExecutorError && err.code === "TIMEOUT") {
        this.logger.log({
          sessionId: context.sessionId,
          eventType: "executor:timeout",
          component: "executor",
          payload: { timeout, durationMs },
        });

        return {
          success: false,
          output: null,
          error: `Execution timed out after ${timeout}ms`,
          durationMs,
        };
      }

      this.logger.log({
        sessionId: context.sessionId,
        eventType: "executor:result",
        component: "executor",
        payload: {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs,
        },
      });

      return {
        success: false,
        output: null,
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      };
    } finally {
      await this.cleanupScratchDir(scratchDir);
    }
  }

  private async createScratchDir(sessionId: string): Promise<string> {
    const dir = join(this.scratchBaseDir, sessionId, randomUUID());
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async cleanupScratchDir(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }

  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new ExecutorError(`Execution timed out after ${ms}ms`, "TIMEOUT"));
      }, ms);
    });
  }
}
