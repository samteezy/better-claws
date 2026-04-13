import type { ToolResult } from "../../types.js";

/** Return a failed ToolResult for a missing required parameter. */
export function missingParamResult(paramName: string, start: number): ToolResult {
  return {
    success: false,
    output: null,
    error: `Missing required parameter: ${paramName}`,
    durationMs: Date.now() - start,
  };
}
