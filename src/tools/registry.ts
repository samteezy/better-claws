import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BetterClawsError, createErrorClass,
  type BuiltInToolModule,
  type ToolDescriptor,
  type ToolHandler,
  type ToolPolicy,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import { validateToolDescriptor } from "../utils/validate-descriptor.js";

export const RegistryError = createErrorClass("RegistryError", "registry", "REGISTRY_ERROR");

export interface RegisteredTool {
  readonly descriptor: ToolDescriptor;
  readonly handler: ToolHandler;
}

export interface ToolRegistryOptions {
  readonly builtInTools?: readonly BuiltInToolModule[];
  readonly pluginDirectory?: string;
  /** @deprecated Use pluginDirectory */
  readonly toolsDirectory?: string;
  readonly logger: StructuredLogger;
  /** Global per-tool access policies. */
  readonly toolPolicies?: Readonly<Record<string, ToolPolicy>>;
}

export class ToolRegistry {
  private readonly builtInTools: readonly BuiltInToolModule[];
  private readonly pluginDirectory: string | null;
  private readonly logger: StructuredLogger;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly toolPolicies: Readonly<Record<string, ToolPolicy>>;

  constructor(options: ToolRegistryOptions) {
    this.builtInTools = options.builtInTools ?? [];
    this.pluginDirectory =
      options.pluginDirectory ?? options.toolsDirectory ?? null;
    this.logger = options.logger;
    this.toolPolicies = options.toolPolicies ?? {};
  }

  async loadTools(): Promise<void> {
    // Phase 1: Register built-in tools (compile-time typed, no validation needed)
    for (const tool of this.builtInTools) {
      if (this.tools.has(tool.descriptor.name)) {
        throw new RegistryError(
          `Duplicate built-in tool name "${tool.descriptor.name}"`,
          "DUPLICATE_TOOL",
        );
      }
      this.tools.set(tool.descriptor.name, {
        descriptor: tool.descriptor,
        handler: tool.handler,
      });
      this.logger.log({
        sessionId: null,
        eventType: "tool:invoke",
        component: "registry",
        payload: { action: "loaded", tool: tool.descriptor.name, source: "built-in" },
      });
    }

    // Phase 2: Load user-defined plugin tools from plugin directory
    if (!this.pluginDirectory) return;

    let entries: string[];
    try {
      entries = await readdir(this.pluginDirectory);
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return; // no plugin directory — that's fine
      }
      throw new RegistryError(
        `Failed to read plugin directory: ${err instanceof Error ? err.message : String(err)}`,
        "READ_ERROR",
      );
    }

    for (const entry of entries) {
      const toolDir = join(this.pluginDirectory, entry);
      const stats = await stat(toolDir);
      if (!stats.isDirectory()) continue;

      await this.loadPlugin(toolDir, entry);
    }
  }

  getDescriptors(): readonly ToolDescriptor[] {
    return Array.from(this.tools.values())
      .filter((t) => this.getPolicy(t.descriptor.name) !== "disabled")
      .map((t) => t.descriptor);
  }

  getDescriptor(toolName: string): ToolDescriptor | undefined {
    return this.tools.get(toolName)?.descriptor;
  }

  getHandler(toolName: string): ToolHandler | undefined {
    return this.tools.get(toolName)?.handler;
  }

  /** Dynamically register a tool (e.g., from MCP or skills). */
  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.descriptor.name)) {
      throw new RegistryError(
        `Cannot register "${tool.descriptor.name}": name already exists`,
        "DUPLICATE_TOOL",
      );
    }
    this.tools.set(tool.descriptor.name, tool);
    this.logger.log({
      sessionId: null,
      eventType: "tool:invoke",
      component: "registry",
      payload: { action: "registered", tool: tool.descriptor.name },
    });
  }

  /** Remove a dynamically registered tool. Returns true if it existed. */
  remove(toolName: string): boolean {
    const existed = this.tools.delete(toolName);
    if (existed) {
      this.logger.log({
        sessionId: null,
        eventType: "tool:invoke",
        component: "registry",
        payload: { action: "removed", tool: toolName },
      });
    }
    return existed;
  }

  /** Get the access policy for a tool. Defaults to "auto". */
  getPolicy(toolName: string): ToolPolicy {
    return this.toolPolicies[toolName] ?? "auto";
  }

  private async loadPlugin(toolDir: string, dirName: string): Promise<void> {
    const descriptorPath = join(toolDir, "descriptor.json");
    let rawDescriptor: unknown;

    try {
      const content = await readFile(descriptorPath, "utf-8");
      rawDescriptor = JSON.parse(content) as unknown;
    } catch (err) {
      throw new RegistryError(
        `Failed to load descriptor for tool "${dirName}": ${err instanceof Error ? err.message : String(err)}`,
        "DESCRIPTOR_ERROR",
      );
    }

    const descriptor = this.validateDescriptor(rawDescriptor, dirName);

    if (this.tools.has(descriptor.name)) {
      throw new RegistryError(
        `Plugin "${dirName}" conflicts with existing tool "${descriptor.name}"`,
        "DUPLICATE_TOOL",
      );
    }

    const handlerPath = join(toolDir, "handler.js");
    let handlerModule: unknown;

    try {
      handlerModule = await import(pathToFileURL(handlerPath).href);
    } catch (err) {
      throw new RegistryError(
        `Failed to load handler for tool "${dirName}": ${err instanceof Error ? err.message : String(err)}`,
        "HANDLER_ERROR",
      );
    }

    const handler = this.extractHandler(handlerModule, dirName);

    this.tools.set(descriptor.name, { descriptor, handler });

    this.logger.log({
      sessionId: null,
      eventType: "tool:invoke",
      component: "registry",
      payload: { action: "loaded", tool: descriptor.name, source: "plugin" },
    });
  }

  private validateDescriptor(
    raw: unknown,
    dirName: string,
  ): ToolDescriptor {
    try {
      return validateToolDescriptor(raw, dirName, { validateSecrets: true });
    } catch (err) {
      if (err instanceof BetterClawsError) {
        throw new RegistryError(err.message, err.code);
      }
      throw err;
    }
  }

  private extractHandler(module: unknown, dirName: string): ToolHandler {
    const mod = module as Record<string, unknown>;

    if (mod["default"] && typeof (mod["default"] as Record<string, unknown>)["execute"] === "function") {
      return mod["default"] as ToolHandler;
    }
    if (typeof mod["execute"] === "function") {
      return { execute: mod["execute"] as ToolHandler["execute"] };
    }

    throw new RegistryError(
      `Handler for "${dirName}" must export an "execute" function or a default object with "execute"`,
      "INVALID_HANDLER",
    );
  }
}
