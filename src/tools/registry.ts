import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BetterClawsError,
  isCapability,
  type ToolDescriptor,
  type ToolHandler,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";

export class RegistryError extends BetterClawsError {
  constructor(message: string, code: string = "REGISTRY_ERROR") {
    super(message, "registry", code);
    this.name = "RegistryError";
  }
}

interface RegisteredTool {
  readonly descriptor: ToolDescriptor;
  readonly handler: ToolHandler;
}

export interface ToolRegistryOptions {
  readonly toolsDirectory: string;
  readonly logger: StructuredLogger;
}

export class ToolRegistry {
  private readonly toolsDirectory: string;
  private readonly logger: StructuredLogger;
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(options: ToolRegistryOptions) {
    this.toolsDirectory = options.toolsDirectory;
    this.logger = options.logger;
  }

  async loadTools(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.toolsDirectory);
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return; // no tools directory — that's fine
      }
      throw new RegistryError(
        `Failed to read tools directory: ${err instanceof Error ? err.message : String(err)}`,
        "READ_ERROR",
      );
    }

    for (const entry of entries) {
      const toolDir = join(this.toolsDirectory, entry);
      const stats = await stat(toolDir);
      if (!stats.isDirectory()) continue;

      await this.loadTool(toolDir, entry);
    }
  }

  getDescriptors(): readonly ToolDescriptor[] {
    return Array.from(this.tools.values()).map((t) => t.descriptor);
  }

  getDescriptor(toolName: string): ToolDescriptor | undefined {
    return this.tools.get(toolName)?.descriptor;
  }

  getHandler(toolName: string): ToolHandler | undefined {
    return this.tools.get(toolName)?.handler;
  }

  private async loadTool(toolDir: string, dirName: string): Promise<void> {
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
        `Duplicate tool name "${descriptor.name}" (from "${dirName}")`,
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
      payload: { action: "loaded", tool: descriptor.name },
    });
  }

  private validateDescriptor(
    raw: unknown,
    dirName: string,
  ): ToolDescriptor {
    if (raw === null || typeof raw !== "object") {
      throw new RegistryError(
        `Descriptor for "${dirName}" is not an object`,
        "INVALID_DESCRIPTOR",
      );
    }

    const obj = raw as Record<string, unknown>;

    if (typeof obj["name"] !== "string" || obj["name"].length === 0) {
      throw new RegistryError(
        `Descriptor for "${dirName}" missing "name"`,
        "INVALID_DESCRIPTOR",
      );
    }
    if (typeof obj["description"] !== "string") {
      throw new RegistryError(
        `Descriptor for "${dirName}" missing "description"`,
        "INVALID_DESCRIPTOR",
      );
    }
    if (obj["parameters"] === null || typeof obj["parameters"] !== "object") {
      throw new RegistryError(
        `Descriptor for "${dirName}" missing "parameters"`,
        "INVALID_DESCRIPTOR",
      );
    }
    if (!Array.isArray(obj["capabilities"])) {
      throw new RegistryError(
        `Descriptor for "${dirName}" missing "capabilities" array`,
        "INVALID_DESCRIPTOR",
      );
    }

    for (const cap of obj["capabilities"]) {
      if (typeof cap !== "string" || !isCapability(cap)) {
        throw new RegistryError(
          `Descriptor for "${dirName}" has unknown capability: "${String(cap)}"`,
          "INVALID_CAPABILITY",
        );
      }
    }

    return {
      name: obj["name"] as string,
      description: obj["description"] as string,
      parameters: obj["parameters"] as ToolDescriptor["parameters"],
      capabilities: obj["capabilities"] as unknown as ToolDescriptor["capabilities"],
    };
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
