/**
 * Loads skill definitions from disk and registers them as tools.
 *
 * A skill directory contains:
 * - descriptor.json — standard ToolDescriptor shape
 * - handler.js — compiled handler module with execute() export
 *
 * Skills are namespaced as `skill__{skillName}__{toolName}`.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BetterClawsError,
  isCapability,
  type SkillConfig,
  type ToolDescriptor,
  type ToolHandler,
} from "../types.js";
import type { RegisteredTool } from "../tools/registry.js";
import type { StructuredLogger } from "../logger/structured-logger.js";

export class SkillLoaderError extends BetterClawsError {
  constructor(message: string, code: string = "SKILL_LOADER_ERROR") {
    super(message, "skill-loader", code);
    this.name = "SkillLoaderError";
  }
}

export class SkillLoader {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  async loadSkill(name: string, config: SkillConfig): Promise<readonly RegisteredTool[]> {
    if (config.enabled === false) return [];
    if (config.defaultPolicy === "disabled") return [];

    const skillPath = config.path;
    const tools: RegisteredTool[] = [];

    // Check if path is a single skill directory or a parent of multiple skills
    const stats = await stat(skillPath);
    if (!stats.isDirectory()) {
      throw new SkillLoaderError(
        `Skill path "${skillPath}" is not a directory`,
        "NOT_DIRECTORY",
      );
    }

    // Check if this directory itself is a skill (has descriptor.json)
    const hasDescriptor = await this.fileExists(join(skillPath, "descriptor.json"));
    if (hasDescriptor) {
      const tool = await this.loadSingleSkill(name, skillPath);
      tools.push(tool);
    } else {
      // Treat as parent directory containing multiple skill subdirectories
      const entries = await readdir(skillPath);
      for (const entry of entries) {
        const entryPath = join(skillPath, entry);
        const entryStats = await stat(entryPath);
        if (!entryStats.isDirectory()) continue;
        if (!(await this.fileExists(join(entryPath, "descriptor.json")))) continue;

        const tool = await this.loadSingleSkill(`${name}__${entry}`, entryPath);
        tools.push(tool);
      }
    }

    return tools;
  }

  private async loadSingleSkill(qualifiedName: string, skillDir: string): Promise<RegisteredTool> {
    // Load descriptor
    const descriptorPath = join(skillDir, "descriptor.json");
    let rawDescriptor: unknown;
    try {
      const content = await readFile(descriptorPath, "utf-8");
      rawDescriptor = JSON.parse(content) as unknown;
    } catch (err) {
      throw new SkillLoaderError(
        `Failed to load descriptor for skill "${qualifiedName}": ${err instanceof Error ? err.message : String(err)}`,
        "DESCRIPTOR_ERROR",
      );
    }

    const descriptor = this.validateDescriptor(rawDescriptor, qualifiedName);
    const namespacedDescriptor: ToolDescriptor = {
      ...descriptor,
      name: `skill__${qualifiedName}`,
      description: `[Skill] ${descriptor.description}`,
    };

    // Load handler
    const handlerPath = join(skillDir, "handler.js");
    let handlerModule: unknown;
    try {
      handlerModule = await import(pathToFileURL(handlerPath).href);
    } catch (err) {
      throw new SkillLoaderError(
        `Failed to load handler for skill "${qualifiedName}": ${err instanceof Error ? err.message : String(err)}`,
        "HANDLER_ERROR",
      );
    }

    const handler = this.extractHandler(handlerModule, qualifiedName);

    this.logger.log({
      sessionId: null,
      eventType: "tool:invoke",
      component: "skill-loader",
      payload: { action: "loaded", skill: qualifiedName, tool: namespacedDescriptor.name },
    });

    return { descriptor: namespacedDescriptor, handler };
  }

  private validateDescriptor(raw: unknown, skillName: string): ToolDescriptor {
    if (raw === null || typeof raw !== "object") {
      throw new SkillLoaderError(
        `Descriptor for skill "${skillName}" is not an object`,
        "INVALID_DESCRIPTOR",
      );
    }

    const obj = raw as Record<string, unknown>;

    if (typeof obj["name"] !== "string" || obj["name"].length === 0) {
      throw new SkillLoaderError(`Descriptor for skill "${skillName}" missing "name"`, "INVALID_DESCRIPTOR");
    }
    if (typeof obj["description"] !== "string") {
      throw new SkillLoaderError(`Descriptor for skill "${skillName}" missing "description"`, "INVALID_DESCRIPTOR");
    }
    if (obj["parameters"] === null || typeof obj["parameters"] !== "object") {
      throw new SkillLoaderError(`Descriptor for skill "${skillName}" missing "parameters"`, "INVALID_DESCRIPTOR");
    }
    if (!Array.isArray(obj["capabilities"])) {
      throw new SkillLoaderError(`Descriptor for skill "${skillName}" missing "capabilities" array`, "INVALID_DESCRIPTOR");
    }

    for (const cap of obj["capabilities"]) {
      if (typeof cap !== "string" || !isCapability(cap)) {
        throw new SkillLoaderError(
          `Descriptor for skill "${skillName}" has unknown capability: "${String(cap)}"`,
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

  private extractHandler(module: unknown, skillName: string): ToolHandler {
    const mod = module as Record<string, unknown>;

    if (mod["default"] && typeof (mod["default"] as Record<string, unknown>)["execute"] === "function") {
      return mod["default"] as ToolHandler;
    }
    if (typeof mod["execute"] === "function") {
      return { execute: mod["execute"] as ToolHandler["execute"] };
    }

    throw new SkillLoaderError(
      `Handler for skill "${skillName}" must export an "execute" function`,
      "INVALID_HANDLER",
    );
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
}
