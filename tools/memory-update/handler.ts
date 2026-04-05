import type { ExecutionContext, ToolResult } from "../../src/types.js";

/**
 * Global registry of working memory instances keyed by sessionId.
 * Populated by the application bootstrap (index.ts) when sessions are created.
 */
export const workingMemoryRegistry = new Map<
  string,
  import("../../src/memory/working-memory.js").WorkingMemory
>();

export async function execute(
  params: Record<string, unknown>,
  context: ExecutionContext,
): Promise<ToolResult> {
  const start = Date.now();
  const action = params["action"] as string;
  const memory = workingMemoryRegistry.get(context.sessionId);

  if (!memory) {
    return {
      success: false,
      output: null,
      error: `No working memory instance found for session "${context.sessionId}"`,
      durationMs: Date.now() - start,
    };
  }

  try {
    switch (action) {
      case "set": {
        const key = params["key"] as string | undefined;
        const category = params["category"] as string | undefined;
        const content = params["content"] as string | undefined;

        if (!key || !category || !content) {
          return {
            success: false,
            output: null,
            error: "Action 'set' requires 'key', 'category', and 'content' parameters",
            durationMs: Date.now() - start,
          };
        }

        memory.set(
          key,
          category as "fact" | "goal" | "correction" | "decision",
          content,
        );

        return {
          success: true,
          output: { action: "set", key, entryCount: memory.count, sizeChars: memory.size },
          durationMs: Date.now() - start,
        };
      }

      case "delete": {
        const key = params["key"] as string | undefined;
        if (!key) {
          return {
            success: false,
            output: null,
            error: "Action 'delete' requires a 'key' parameter",
            durationMs: Date.now() - start,
          };
        }

        const deleted = memory.delete(key);
        return {
          success: true,
          output: { action: "delete", key, existed: deleted, entryCount: memory.count },
          durationMs: Date.now() - start,
        };
      }

      case "clear": {
        memory.clear();
        return {
          success: true,
          output: { action: "clear", entryCount: 0 },
          durationMs: Date.now() - start,
        };
      }

      default:
        return {
          success: false,
          output: null,
          error: `Unknown action: "${action}". Valid actions: set, delete, clear`,
          durationMs: Date.now() - start,
        };
    }
  } catch (err) {
    return {
      success: false,
      output: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}
