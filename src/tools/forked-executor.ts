import { fork, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  BetterClawsError,
  type ExecutionContext,
  type ToolResult,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import { redactSecrets } from "../utils/redact.js";

export class ForkedExecutorError extends BetterClawsError {
  constructor(message: string, code: string = "FORKED_EXECUTOR_ERROR") {
    super(message, "forked-executor", code);
    this.name = "ForkedExecutorError";
  }
}

// ── IPC message types ───────────────────────────────────────────────────────

interface WorkerRequest {
  readonly handlerPath: string;
  readonly params: Record<string, unknown>;
  readonly context: {
    readonly sessionId: string;
    readonly capabilities: readonly string[];
    readonly scratchDir: string;
    readonly timeout: number;
    readonly secrets: readonly (readonly [string, string])[];
  };
}

interface WorkerResponse {
  readonly ready?: boolean;
  readonly success: boolean;
  readonly output: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface ForkedExecutorOptions {
  readonly scratchBaseDir: string;
  readonly defaultTimeout: number;
  readonly stripEnvironment: boolean;
  readonly logger: StructuredLogger;
  /** Path to the compiled tool-worker.js file. */
  readonly workerScript?: string;
  /** Allowed environment variable names when stripEnvironment is true. */
  readonly allowedEnvVars?: readonly string[];
  /**
   * Enable Node --experimental-permission for filesystem policy.
   * Disabled by default — requires careful allow-list configuration.
   * When enabled, only scratchDir, workerScript, and handlerPath are readable.
   */
  readonly enablePermissionFlag?: boolean;
  /** V8 heap limit for child processes in MB. Default: 128. */
  readonly maxMemoryMb?: number;
  /** Allowed root directories for handler paths. Validated before execution. */
  readonly allowedHandlerRoots?: readonly string[];
}

// ── Executor ────────────────────────────────────────────────────────────────

/**
 * Process-isolated tool executor using child_process.fork().
 *
 * Each tool invocation:
 * 1. Creates a scratch directory
 * 2. Forks a worker process with stripped env and locked cwd
 * 3. Sends handler path + params via IPC
 * 4. Receives structured result via IPC
 * 5. Kills process on timeout
 * 6. Captures stdout/stderr to structured logger
 * 7. Cleans up scratch directory
 */
export class ForkedExecutor {
  private readonly scratchBaseDir: string;
  private readonly defaultTimeout: number;
  private readonly stripEnvironment: boolean;
  private readonly enablePermissionFlag: boolean;
  private readonly maxMemoryMb: number;
  private readonly logger: StructuredLogger;
  private readonly workerScript: string;
  private readonly allowedEnvVars: ReadonlySet<string>;
  private readonly allowedHandlerRoots: readonly string[];

  constructor(options: ForkedExecutorOptions) {
    this.scratchBaseDir = options.scratchBaseDir;
    this.defaultTimeout = options.defaultTimeout;
    this.stripEnvironment = options.stripEnvironment;
    this.enablePermissionFlag = options.enablePermissionFlag ?? false;
    this.maxMemoryMb = options.maxMemoryMb ?? 128;
    this.logger = options.logger;
    this.workerScript = options.workerScript ?? this.resolveDefaultWorkerScript();
    this.allowedEnvVars = new Set(options.allowedEnvVars ?? [
      "NODE_PATH", "HOME", "LANG", "TERM",
    ]);
    this.allowedHandlerRoots = options.allowedHandlerRoots ?? [
      resolvePath("tools"),
      resolvePath("dist", "src", "tools"),
      resolvePath("src", "tools"),
    ];
  }

  async execute(
    handlerPath: string,
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    // Validate handler path is within allowed directories
    const resolvedHandler = resolvePath(handlerPath);
    const withinAllowed = this.allowedHandlerRoots.some(root => {
      const prefix = root.endsWith("/") ? root : root + "/";
      return resolvedHandler === root || resolvedHandler.startsWith(prefix);
    });
    if (!withinAllowed) {
      return {
        success: false,
        output: null,
        error: `Handler path is outside allowed directories: ${handlerPath}`,
        durationMs: 0,
      };
    }

    const scratchDir = await this.createScratchDir(context.sessionId);
    const timeout = context.timeout || this.defaultTimeout;

    this.logger.log({
      sessionId: context.sessionId,
      eventType: "executor:start",
      component: "forked-executor",
      payload: {
        scratchDir,
        timeout,
        handlerPath,
        isolated: true,
      },
    });

    const startTime = Date.now();

    try {
      const result = await this.runInFork(handlerPath, params, {
        ...context,
        scratchDir,
        timeout,
      });

      this.logger.log({
        sessionId: context.sessionId,
        eventType: "executor:result",
        component: "forked-executor",
        payload: {
          success: result.success,
          durationMs: result.durationMs,
          isolated: true,
        },
      });

      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const isTimeout = err instanceof ForkedExecutorError && err.code === "TIMEOUT";

      this.logger.log({
        sessionId: context.sessionId,
        eventType: isTimeout ? "executor:timeout" : "executor:result",
        component: "forked-executor",
        payload: {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs,
          isolated: true,
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

  // ── Fork management ───────────────────────────────────────────────────

  private runInFork(
    handlerPath: string,
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const env = this.buildEnvironment();
      const execArgv = this.buildExecArgv(context);

      const child: ChildProcess = fork(this.workerScript, [], {
        cwd: context.scratchDir,
        env,
        execArgv,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });

      let resolved = false;
      let timedOut = false;
      let stdout = "";
      let stderr = "";
      const MAX_BUFFER_BYTES = 1_048_576; // 1 MB

      // Capture stdout/stderr with buffer size limits
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_BUFFER_BYTES) {
          stdout += chunk.toString().slice(0, MAX_BUFFER_BYTES - stdout.length);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_BUFFER_BYTES) {
          stderr += chunk.toString().slice(0, MAX_BUFFER_BYTES - stderr.length);
        }
      });

      // Timeout enforcement — SIGTERM first, SIGKILL after grace period
      const GRACEFUL_SHUTDOWN_MS = 3000;
      const timer = setTimeout(() => {
        if (!resolved) {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              child.kill("SIGKILL");
              reject(new ForkedExecutorError(
                `Execution timed out after ${context.timeout}ms`,
                "TIMEOUT",
              ));
            }
          }, GRACEFUL_SHUTDOWN_MS);
        }
      }, context.timeout);

      // Handle IPC messages
      child.on("message", (msg: WorkerResponse) => {
        if (msg.ready) {
          // Worker is ready, send the task
          const request: WorkerRequest = {
            handlerPath: resolvePath(handlerPath),
            params,
            context: {
              sessionId: context.sessionId,
              capabilities: [...context.capabilities],
              scratchDir: context.scratchDir,
              timeout: context.timeout,
              secrets: [...context.secrets.entries()],
            },
          };
          child.send(request);
          return;
        }

        // Got a result
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);

          // Log captured output with redaction
          const combinedStdout = redactSecrets((stdout + (msg.stdout || "")).slice(0, 10000));
          const combinedStderr = redactSecrets((stderr + (msg.stderr || "")).slice(0, 10000));
          if (combinedStdout || combinedStderr) {
            this.logger.log({
              sessionId: context.sessionId,
              eventType: "executor:result",
              component: "forked-executor",
              payload: {
                action: "captured_output",
                stdout: combinedStdout,
                stderr: combinedStderr,
              },
            });
          }

          const redactedOutput = typeof msg.output === "string"
            ? redactSecrets(msg.output)
            : msg.output;

          resolve({
            success: msg.success,
            output: redactedOutput,
            error: msg.error,
            durationMs: msg.durationMs,
          });
        }
      });

      // Handle process exit without result
      child.on("exit", (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (timedOut) {
            reject(new ForkedExecutorError(
              `Execution timed out after ${context.timeout}ms`,
              "TIMEOUT",
            ));
          } else {
            reject(new ForkedExecutorError(
              `Worker process exited with code ${code} without sending a result`,
              "WORKER_EXIT",
            ));
          }
        }
      });

      // Handle process errors
      child.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new ForkedExecutorError(
            `Worker process error: ${err.message}`,
            "WORKER_ERROR",
          ));
        }
      });
    });
  }

  // ── Environment ───────────────────────────────────────────────────────

  private buildEnvironment(): Record<string, string> {
    if (!this.stripEnvironment) {
      this.logger.log({
        sessionId: null,
        eventType: "executor:result",
        component: "forked-executor",
        payload: {
          action: "env_warning",
          message: "stripEnvironment is disabled — full parent environment will be inherited by child process",
        },
      });
      return { ...process.env } as Record<string, string>;
    }

    const env: Record<string, string> = {};
    for (const key of this.allowedEnvVars) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return env;
  }

  /** Build Node.js exec arguments for optional hardening. */
  private buildExecArgv(context: ExecutionContext): string[] {
    const args: string[] = [`--max-old-space-size=${this.maxMemoryMb}`];

    if (!this.enablePermissionFlag) {
      this.logger.log({
        sessionId: null,
        eventType: "executor:result",
        component: "forked-executor",
        payload: {
          action: "permission_warning",
          message: "Node --experimental-permission is disabled — child processes have unrestricted filesystem access",
        },
      });
    }

    // Only apply permission flag when explicitly enabled and supported
    if (this.enablePermissionFlag && this.isPermissionFlagSupported()) {
      args.push("--experimental-permission");
      args.push(`--allow-fs-read=${context.scratchDir}`);
      args.push(`--allow-fs-write=${context.scratchDir}`);
      // Allow reading the worker script and handler
      args.push(`--allow-fs-read=${this.workerScript}`);
    }

    return args;
  }

  private isPermissionFlagSupported(): boolean {
    const majorVersion = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    return majorVersion >= 20;
  }

  // ── Scratch directory ─────────────────────────────────────────────────

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

  private resolveDefaultWorkerScript(): string {
    // Look for the compiled worker script relative to this file
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(currentDir, "tool-worker.js"),
      join(currentDir, "..", "..", "dist", "src", "tools", "tool-worker.js"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return candidates[0]!;
  }
}
