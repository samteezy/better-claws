import type { WorkingMemory } from "../../memory/working-memory.js";
import type { LongTermStore } from "../../memory/long-term-store.js";
import type {
  ToolDescriptor,
  ToolHandler,
  ExecutionContext,
  ToolResult,
  MemoryEntry,
} from "../../types.js";

/**
 * Global registry of working memory instances keyed by sessionId.
 * Populated by the application bootstrap when sessions are created.
 */
export const workingMemoryRegistry = new Map<string, WorkingMemory>();

/**
 * Singleton long-term store instance, set by bootstrap.
 * When present, memory-update writes through to persistent storage
 * so entries appear in the dashboard.
 */
export let longTermStoreInstance: LongTermStore | null = null;

export function setLongTermStore(store: LongTermStore): void {
  longTermStoreInstance = store;
}

/** Map working-memory categories to long-term-store categories. */
const CATEGORY_MAP: Record<string, MemoryEntry["category"]> = {
  fact: "fact",
  goal: "project",
  correction: "preference",
  decision: "procedure",
};

export const descriptor: ToolDescriptor = {
  name: "memory-update",
  description:
    "Update working memory for the current session. Use this to save key facts, active goals, user corrections, or decisions that should persist across conversation turns even if history is truncated.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set", "delete", "clear"],
        description:
          "The operation: 'set' to create/update an entry, 'delete' to remove one, 'clear' to remove all.",
      },
      key: {
        type: "string",
        description:
          "Unique identifier for the memory entry. Required for 'set' and 'delete'.",
      },
      category: {
        type: "string",
        enum: ["fact", "goal", "correction", "decision"],
        description: "Category of the entry. Required for 'set'.",
      },
      content: {
        type: "string",
        description: "The memory content to store. Required for 'set'.",
      },
    },
    required: ["action"],
  },
  capabilities: ["memory:write"],
};

export const handler: ToolHandler = {
  async execute(
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
              error:
                "Action 'set' requires 'key', 'category', and 'content' parameters",
              durationMs: Date.now() - start,
            };
          }

          memory.set(
            key,
            category as "fact" | "goal" | "correction" | "decision",
            content,
          );

          // Write through to long-term store so the entry appears in the dashboard
          if (longTermStoreInstance) {
            const ltCategory = CATEGORY_MAP[category] ?? "fact";
            const tag = `wm:${key}`;

            // Check for an existing entry with this working-memory key to avoid duplicates
            const existing = longTermStoreInstance
              .search({ tags: [tag] })
              .find((e) => e.tags.includes(tag));

            if (existing) {
              await longTermStoreInstance.update(existing.id, {
                content,
                confidence: 1.0,
              });
            } else {
              await longTermStoreInstance.create({
                category: ltCategory,
                content,
                sourceSessions: [context.sessionId],
                confidence: 1.0,
                tags: [tag, category],
              });
            }
          }

          return {
            success: true,
            output: {
              action: "set",
              key,
              entryCount: memory.count,
              sizeChars: memory.size,
            },
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
            output: {
              action: "delete",
              key,
              existed: deleted,
              entryCount: memory.count,
            },
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
  },
};
