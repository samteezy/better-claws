import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import type {
  ToolDescriptor,
  ToolHandler,
  ExecutionContext,
  ToolResult,
} from "../../types.js";

export const descriptor: ToolDescriptor = {
  name: "file-write",
  description:
    "Write content to a file. Creates parent directories if they do not exist.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to write (absolute or relative to scratch dir)",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["path", "content"],
  },
  capabilities: ["fs:write"],
};

export const handler: ToolHandler = {
  async execute(
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const start = Date.now();
    const filePath = params["path"];
    const content = params["content"];

    if (typeof filePath !== "string" || filePath.length === 0) {
      return {
        success: false,
        output: null,
        error: "Missing required parameter: path",
        durationMs: Date.now() - start,
      };
    }

    if (typeof content !== "string") {
      return {
        success: false,
        output: null,
        error: "Missing required parameter: content",
        durationMs: Date.now() - start,
      };
    }

    const resolved = resolve(
      isAbsolute(filePath) ? filePath : resolve(context.scratchDir, filePath),
    );

    const allowedRoots = [context.scratchDir, ...(context.allowedFsRoots ?? [])];
    const pathAllowed = allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + "/"),
    );
    if (!pathAllowed) {
      return {
        success: false,
        output: null,
        error: `Path not allowed: ${filePath}`,
        durationMs: Date.now() - start,
      };
    }

    try {
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");

      return {
        success: true,
        output: {
          path: resolved,
          bytesWritten: Buffer.byteLength(content, "utf-8"),
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
