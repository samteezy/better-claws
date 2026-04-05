import { execFile } from "node:child_process";

/**
 * @param {Record<string, unknown>} params
 * @param {{ scratchDir: string; timeout: number }} context
 * @returns {Promise<{ success: boolean; output: unknown; durationMs: number; error?: string }>}
 */
export async function execute(params, context) {
  const start = Date.now();
  const command = params.command;

  if (typeof command !== "string" || command.length === 0) {
    return {
      success: false,
      output: null,
      error: "Missing required parameter: command",
      durationMs: Date.now() - start,
    };
  }

  const args = Array.isArray(params.args) ? params.args.map(String) : [];
  const cwd =
    typeof params.cwd === "string" ? params.cwd : context.scratchDir;
  const timeout =
    typeof params.timeout === "number" ? params.timeout : context.timeout;

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
          output: {
            stdout,
            stderr,
            exitCode: 0,
          },
          durationMs,
        });
      },
    );
  });
}
