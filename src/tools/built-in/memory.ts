import type { WorkingMemory } from "../../memory/working-memory.js";
import type { LongTermStore } from "../../memory/long-term-store.js";
import type { TfIdfRetriever } from "../../memory/retrieval.js";
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
 * When present, memory writes through to persistent storage
 * so entries appear in the dashboard.
 */
export let longTermStoreInstance: LongTermStore | null = null;

export function setLongTermStore(store: LongTermStore): void {
  longTermStoreInstance = store;
}

/**
 * Singleton TF-IDF retriever instance, set by bootstrap.
 * When present, the 'search' action queries long-term memory.
 */
export let retrieverInstance: TfIdfRetriever | null = null;

export function setRetriever(retriever: TfIdfRetriever): void {
  retrieverInstance = retriever;
}

/** Map working-memory categories to long-term-store categories. */
const CATEGORY_MAP: Record<string, MemoryEntry["category"]> = {
  fact: "fact",
  goal: "project",
  correction: "preference",
  decision: "procedure",
};

export const descriptor: ToolDescriptor = {
  name: "memory",
  description:
    "Manage session working memory and search long-term memory. Use 'set', 'delete', or 'clear' to manage working memory entries. Use 'search' to retrieve relevant entries from long-term memory by query.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set", "delete", "clear", "search"],
        description:
          "The operation: 'set' to create/update an entry, 'delete' to remove one, 'clear' to remove all, 'search' to query long-term memory.",
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
      query: {
        type: "string",
        description:
          "Search query text for finding relevant long-term memories. Required for 'search'.",
      },
      topK: {
        type: "number",
        description:
          "Maximum number of results to return from search. Defaults to 5. Only used with 'search'.",
      },
    },
    required: ["action"],
  },
  capabilities: ["memory:read", "memory:write"],
};

/** Look up working memory for a session, returning an error result if missing. */
function requireWorkingMemory(
  sessionId: string,
  start: number,
): { memory: WorkingMemory; error?: undefined } | { memory?: undefined; error: ToolResult } {
  const memory = workingMemoryRegistry.get(sessionId);
  if (!memory) {
    return {
      error: {
        success: false,
        output: null,
        error: `No working memory instance found for session "${sessionId}"`,
        durationMs: Date.now() - start,
      },
    };
  }
  return { memory };
}

export const handler: ToolHandler = {
  async execute(
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const start = Date.now();
    const action = params["action"] as string;

    try {
      switch (action) {
        case "set": {
          const wm = requireWorkingMemory(context.sessionId, start);
          if (wm.error) return wm.error;

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

          wm.memory.set(
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
              entryCount: wm.memory.count,
              sizeChars: wm.memory.size,
            },
            durationMs: Date.now() - start,
          };
        }

        case "delete": {
          const wm = requireWorkingMemory(context.sessionId, start);
          if (wm.error) return wm.error;

          const key = params["key"] as string | undefined;
          if (!key) {
            return {
              success: false,
              output: null,
              error: "Action 'delete' requires a 'key' parameter",
              durationMs: Date.now() - start,
            };
          }

          const deleted = wm.memory.delete(key);
          return {
            success: true,
            output: {
              action: "delete",
              key,
              existed: deleted,
              entryCount: wm.memory.count,
            },
            durationMs: Date.now() - start,
          };
        }

        case "clear": {
          const wm = requireWorkingMemory(context.sessionId, start);
          if (wm.error) return wm.error;

          wm.memory.clear();
          return {
            success: true,
            output: { action: "clear", entryCount: 0 },
            durationMs: Date.now() - start,
          };
        }

        case "search": {
          const query = params["query"] as string | undefined;
          if (!query) {
            return {
              success: false,
              output: null,
              error: "Action 'search' requires a 'query' parameter",
              durationMs: Date.now() - start,
            };
          }

          if (!retrieverInstance) {
            return {
              success: false,
              output: null,
              error:
                "Long-term memory search is not available (retriever not initialized)",
              durationMs: Date.now() - start,
            };
          }

          const topK = (params["topK"] as number | undefined) ?? 5;
          const results = retrieverInstance.retrieveWithInference(query, topK);

          return {
            success: true,
            output: {
              action: "search",
              query,
              resultCount: results.length,
              results: results.map((r) => ({
                id: r.entry.id,
                category: r.entry.category,
                content: r.entry.content,
                tags: r.entry.tags,
                confidence: r.entry.confidence,
                score: Math.round(r.score * 1000) / 1000,
              })),
            },
            durationMs: Date.now() - start,
          };
        }

        default:
          return {
            success: false,
            output: null,
            error: `Unknown action: "${action}". Valid actions: set, delete, clear, search`,
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
