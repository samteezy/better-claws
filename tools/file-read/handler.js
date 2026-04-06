import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";

/**
 * @param {Record<string, unknown>} params
 * @param {{ scratchDir: string }} context
 * @returns {Promise<{ success: boolean; output: unknown; durationMs: number; error?: string }>}
 */
export async function execute(params, context) {
  const start = Date.now();
  const filePath = params.path;

  if (typeof filePath !== "string" || filePath.length === 0) {
    return {
      success: false,
      output: null,
      error: "Missing required parameter: path",
      durationMs: Date.now() - start,
    };
  }

  const resolved = isAbsolute(filePath)
    ? filePath
    : resolve(context.scratchDir, filePath);

  try {
    const content = await readFile(resolved, "utf-8");
    const lines = content.split("\n");

    const startLine =
      typeof params.startLine === "number" ? Math.max(1, params.startLine) : 1;
    const endLine =
      typeof params.endLine === "number"
        ? Math.min(lines.length, params.endLine)
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
}
