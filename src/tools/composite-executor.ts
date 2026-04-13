import type { ExecutionContext, ToolHandler, ToolResult } from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import { ToolExecutor } from "./executor.js";
import { ForkedExecutor } from "./forked-executor.js";

export interface CompositeExecutorOptions {
  readonly scratchBaseDir: string;
  readonly defaultTimeout: number;
  readonly stripEnvironment: boolean;
  readonly logger: StructuredLogger;
  /** V8 heap limit for forked child processes in MB. Default: 128. */
  readonly maxMemoryMb?: number;
  /** When true (default), file-backed tools run in isolated child processes. */
  readonly useForkedExecution?: boolean;
}

/**
 * Routes tool execution to either ForkedExecutor (process-isolated) or
 * ToolExecutor (in-process) based on whether the tool has a file-backed handler.
 *
 * - Tools with a `handlerPath` run in a child process via ForkedExecutor.
 * - Tools without a path (MCP stubs, inline handlers) run in-process via ToolExecutor.
 * - Setting `useForkedExecution: false` disables forking entirely.
 */
export class CompositeExecutor {
  private readonly inProcess: ToolExecutor;
  private readonly forked: ForkedExecutor;
  private readonly useForkedExecution: boolean;

  constructor(options: CompositeExecutorOptions) {
    this.useForkedExecution = options.useForkedExecution ?? true;

    this.inProcess = new ToolExecutor({
      scratchBaseDir: options.scratchBaseDir,
      defaultTimeout: options.defaultTimeout,
      stripEnvironment: options.stripEnvironment,
      logger: options.logger,
    });

    this.forked = new ForkedExecutor({
      scratchBaseDir: options.scratchBaseDir,
      defaultTimeout: options.defaultTimeout,
      stripEnvironment: options.stripEnvironment,
      maxMemoryMb: options.maxMemoryMb,
      logger: options.logger,
    });
  }

  async execute(
    handler: ToolHandler,
    handlerPath: string | null,
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    if (this.useForkedExecution && handlerPath !== null) {
      return this.forked.execute(handlerPath, params, context);
    }
    return this.inProcess.execute(handler, params, context);
  }
}
