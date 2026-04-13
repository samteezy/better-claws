import { toErrorMessage } from "../../utils/errors.js";
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
    "Manage session working memory and long-term memory. Use 'set', 'delete', or 'clear' for working memory. Use 'search' to query long-term memory. Use 'update' or 'delete-by-id' to edit/remove long-term entries by UUID.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set", "delete", "clear", "search", "update", "delete-by-id"],
        description:
          "The operation: 'set' create/update working memory, 'delete' remove from working + long-term, 'clear' remove all working memory, 'search' query long-term memory, 'update' edit a long-term entry by id, 'delete-by-id' remove a long-term entry by id.",
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
        description:
          "The memory content to store. Required for 'set'. Optional for 'update'.",
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
      id: {
        type: "string",
        description:
          "UUID of a long-term memory entry (returned by 'search'). Required for 'update' and 'delete-by-id'.",
      },
      confidence: {
        type: "number",
        description:
          "Confidence value between 0 and 1. Optional for 'update'.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags for the entry. Optional for 'update'.",
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

          // Write-through: also remove from long-term store
          if (longTermStoreInstance) {
            const tag = `wm:${key}`;
            const existing = longTermStoreInstance
              .search({ tags: [tag] })
              .find((e) => e.tags.includes(tag));
            if (existing) {
              await longTermStoreInstance.delete(existing.id);
            }
          }

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

        case "update": {
          const id = params["id"] as string | undefined;
          if (!id) {
            return {
              success: false,
              output: null,
              error: "Action 'update' requires an 'id' parameter (UUID from search results)",
              durationMs: Date.now() - start,
            };
          }
          if (!longTermStoreInstance) {
            return {
              success: false,
              output: null,
              error: "Long-term memory store is not available",
              durationMs: Date.now() - start,
            };
          }

          const patchContent = params["content"] as string | undefined;
          const patchConfidence = params["confidence"] as number | undefined;
          const patchTags = params["tags"] as readonly string[] | undefined;

          if (patchContent === undefined && patchConfidence === undefined && patchTags === undefined) {
            return {
              success: false,
              output: null,
              error: "Action 'update' requires at least one of 'content', 'confidence', or 'tags'",
              durationMs: Date.now() - start,
            };
          }

          const patch: { content?: string; confidence?: number; tags?: readonly string[] } = {};
          if (patchContent !== undefined) patch.content = patchContent;
          if (patchConfidence !== undefined) patch.confidence = patchConfidence;
          if (patchTags !== undefined) patch.tags = patchTags;

          const updated = await longTermStoreInstance.update(id, patch);
          return {
            success: true,
            output: {
              action: "update",
              id,
              entry: {
                category: updated.category,
                content: updated.content,
                confidence: updated.confidence,
                tags: updated.tags,
              },
            },
            durationMs: Date.now() - start,
          };
        }

        case "delete-by-id": {
          const id = params["id"] as string | undefined;
          if (!id) {
            return {
              success: false,
              output: null,
              error: "Action 'delete-by-id' requires an 'id' parameter (UUID from search results)",
              durationMs: Date.now() - start,
            };
          }
          if (!longTermStoreInstance) {
            return {
              success: false,
              output: null,
              error: "Long-term memory store is not available",
              durationMs: Date.now() - start,
            };
          }

          const existed = await longTermStoreInstance.delete(id);
          return {
            success: true,
            output: { action: "delete-by-id", id, existed },
            durationMs: Date.now() - start,
          };
        }

        default:
          return {
            success: false,
            output: null,
            error: `Unknown action: "${action}". Valid actions: set, delete, clear, search, update, delete-by-id`,
            durationMs: Date.now() - start,
          };
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        error: toErrorMessage(err),
        durationMs: Date.now() - start,
      };
    }
  },
};
