import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";

/**
 * @param {Record<string, unknown>} params
 * @param {{ scratchDir: string }} context
 * @returns {Promise<{ success: boolean; output: unknown; durationMs: number; error?: string }>}
 */
export async function execute(params, context) {
  const start = Date.now();
  const filePath = params.path;
  const content = params.content;

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

  const resolved = isAbsolute(filePath)
    ? filePath
    : resolve(context.scratchDir, filePath);

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
}
