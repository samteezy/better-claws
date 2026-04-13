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
  BetterClawsError, createErrorClass,
  type SkillConfig,
  type ToolDescriptor,
  type ToolHandler,
  type ToolResult,
} from "../types.js";
import type { RegisteredTool } from "../tools/registry.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import { parseSkillMd } from "./frontmatter-parser.js";
import { validateToolDescriptor } from "../utils/validate-descriptor.js";
import { toErrorMessage } from "../utils/errors.js";

export const SkillLoaderError = createErrorClass("SkillLoaderError", "skill-loader", "SKILL_LOADER_ERROR");

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

    // Check if this directory itself is a skill
    const hasDescriptor = await this.fileExists(join(skillPath, "descriptor.json"));
    const hasSkillMd = await this.fileExists(join(skillPath, "SKILL.md"));

    if (hasDescriptor) {
      const tool = await this.loadSingleSkill(name, skillPath);
      tools.push(tool);
    } else if (hasSkillMd) {
      const tool = await this.loadAgentSkill(name, skillPath);
      tools.push(tool);
    } else {
      // Treat as parent directory containing multiple skill subdirectories
      const entries = await readdir(skillPath);
      for (const entry of entries) {
        const entryPath = join(skillPath, entry);
        const entryStats = await stat(entryPath);
        if (!entryStats.isDirectory()) continue;

        if (await this.fileExists(join(entryPath, "descriptor.json"))) {
          const tool = await this.loadSingleSkill(`${name}__${entry}`, entryPath);
          tools.push(tool);
        } else if (await this.fileExists(join(entryPath, "SKILL.md"))) {
          const tool = await this.loadAgentSkill(`${name}__${entry}`, entryPath);
          tools.push(tool);
        }
      }
    }

    return tools;
  }

  private async loadAgentSkill(qualifiedName: string, skillDir: string): Promise<RegisteredTool> {
    const skillMdPath = join(skillDir, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillMdPath, "utf-8");
    } catch (err) {
      throw new SkillLoaderError(
        `Failed to read SKILL.md for "${qualifiedName}": ${toErrorMessage(err)}`,
        "SKILLMD_READ_ERROR",
      );
    }

    const parsed = parseSkillMd(content);

    // Collect reference documents if present
    let instructions = parsed.body;
    const refsDir = join(skillDir, "references");
    if (await this.fileExists(refsDir)) {
      try {
        const refEntries = await readdir(refsDir);
        for (const refFile of refEntries) {
          if (!refFile.endsWith(".md")) continue;
          const refContent = await readFile(join(refsDir, refFile), "utf-8");
          instructions += `\n\n---\n## Reference: ${refFile}\n\n${refContent}`;
        }
      } catch {
        // Non-fatal: skip references if unreadable
      }
    }

    const descriptor: ToolDescriptor = {
      name: `skill__${qualifiedName}`,
      description: `[Skill] ${parsed.frontmatter.description}`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional query to focus the skill instructions on a specific aspect",
          },
        },
      },
      capabilities: [],
    };

    const handler: ToolHandler = {
      async execute(): Promise<ToolResult> {
        return {
          success: true,
          output: instructions,
          durationMs: 0,
        };
      },
    };

    this.logger.log({
      sessionId: null,
      eventType: "tool:invoke",
      component: "skill-loader",
      payload: {
        action: "loaded",
        skill: qualifiedName,
        tool: descriptor.name,
        format: "agentskills",
        skillName: parsed.frontmatter.name,
      },
    });

    return { descriptor, handler };
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
        `Failed to load descriptor for skill "${qualifiedName}": ${toErrorMessage(err)}`,
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
        `Failed to load handler for skill "${qualifiedName}": ${toErrorMessage(err)}`,
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

    return { descriptor: namespacedDescriptor, handler, handlerPath };
  }

  private validateDescriptor(raw: unknown, skillName: string): ToolDescriptor {
    try {
      return validateToolDescriptor(raw, `skill "${skillName}"`);
    } catch (err) {
      if (err instanceof BetterClawsError) {
        throw new SkillLoaderError(err.message, err.code);
      }
      throw err;
    }
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
