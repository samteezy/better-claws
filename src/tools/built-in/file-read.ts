import { readFile } from "node:fs/promises";
import type {
  ToolDescriptor,
  ToolHandler,
  ExecutionContext,
  ToolResult,
} from "../../types.js";
import { checkPath } from "../../utils/path-policy.js";

export const descriptor: ToolDescriptor = {
  name: "file-read",
  description:
    "Read the contents of a file. Supports optional line range selection.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read (absolute or relative to scratch dir)",
      },
      startLine: {
        type: "number",
        description: "First line to read (1-based, inclusive). Defaults to 1.",
      },
      endLine: {
        type: "number",
        description: "Last line to read (1-based, inclusive). Defaults to end of file.",
      },
    },
    required: ["path"],
  },
  capabilities: ["fs:read"],
};

export const handler: ToolHandler = {
  async execute(
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const start = Date.now();
    const filePath = params["path"];

    if (typeof filePath !== "string" || filePath.length === 0) {
      return {
        success: false,
        output: null,
        error: "Missing required parameter: path",
        durationMs: Date.now() - start,
      };
    }

    const allowedRoots = [context.scratchDir, ...(context.allowedFsRoots ?? [])];
    const pathCheck = await checkPath(filePath, context.scratchDir, allowedRoots);
    if (!pathCheck.allowed) {
      return {
        success: false,
        output: null,
        error: `Path not allowed: ${filePath}`,
        durationMs: Date.now() - start,
      };
    }
    const resolved = pathCheck.resolvedPath;

    try {
      const content = await readFile(resolved, "utf-8");
      const lines = content.split("\n");

      const startLine =
        typeof params["startLine"] === "number"
          ? Math.max(1, params["startLine"])
          : 1;
      const endLine =
        typeof params["endLine"] === "number"
          ? Math.min(lines.length, params["endLine"])
          : lines.length;

      const selected = lines.slice(startLine - 1, endLine);

      return {
        success: true,
        output: {
          path: resolved,
          content: selected.join("\n"),
          totalLines: lines.length,
          startLine,
          endLine,
        },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  },
};
