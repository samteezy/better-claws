import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  ToolDescriptor,
  ToolHandler,
  ExecutionContext,
  ToolResult,
} from "../../types.js";
import { checkPath } from "../../utils/path-policy.js";
import { missingParamResult } from "./tool-helpers.js";

export const handlerPath = fileURLToPath(import.meta.url);

export const descriptor: ToolDescriptor = {
  name: "shell",
  description:
    "Execute a shell command with arguments. Runs via execFile (no shell expansion) for safety.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to execute (e.g. 'ls', 'git')",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass to the command",
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the command. Defaults to the scratch directory.",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds. Defaults to context timeout.",
      },
    },
    required: ["command"],
  },
  capabilities: ["exec:shell"],
};

export const handler: ToolHandler = {
  async execute(
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const start = Date.now();
    const command = params["command"];

    if (typeof command !== "string" || command.length === 0) {
      return missingParamResult("command", start);
    }

    const args = Array.isArray(params["args"])
      ? (params["args"] as unknown[]).map(String)
      : [];
    const rawCwd =
      typeof params["cwd"] === "string" ? params["cwd"] : context.scratchDir;
    const allowedRoots = [context.scratchDir, ...(context.allowedFsRoots ?? [])];
    const cwdCheck = await checkPath(rawCwd, context.scratchDir, allowedRoots);
    if (!cwdCheck.allowed) {
      return {
        success: false,
        output: null,
        error: `Working directory not allowed: ${rawCwd}`,
        durationMs: Date.now() - start,
      };
    }
    const cwd = cwdCheck.resolvedPath;
    const timeout =
      typeof params["timeout"] === "number"
        ? params["timeout"]
        : context.timeout;

    return new Promise((resolve) => {
      execFile(
        command,
        args,
        { cwd, timeout, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - start;

          if (error) {
            resolve({
              success: false,
              output: {
                stdout: stdout || "",
                stderr: stderr || error.message,
                exitCode: error.code ?? 1,
              },
              error: error.message,
              durationMs,
            });
            return;
          }

          resolve({
            success: true,
            output: { stdout, stderr, exitCode: 0 },
            durationMs,
          });
        },
      );
    });
  },
};
