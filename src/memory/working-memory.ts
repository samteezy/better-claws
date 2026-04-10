import { BetterClawsError } from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";

export class WorkingMemoryError extends BetterClawsError {
  constructor(message: string, code: string = "WORKING_MEMORY_ERROR") {
    super(message, "working-memory", code);
    this.name = "WorkingMemoryError";
  }
}

/**
 * A single entry in working memory — a distilled fact, goal, correction,
 * or decision from the current conversation.
 */
export interface WorkingMemoryEntry {
  readonly key: string;
  readonly category: "fact" | "goal" | "correction" | "decision";
  readonly content: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkingMemoryOptions {
  /** Maximum size budget in characters. */
  readonly maxSizeChars: number;
  readonly logger: StructuredLogger;
}

/**
 * Per-session working memory (Tier 2). A structured scratchpad the LLM writes
 * to via tool calls, injected into the system prompt by the prompt builder.
 *
 * Stored in-memory only — one instance per active session. Persistence is
 * handled by the session log (every write is a logged tool call).
 */
export class WorkingMemory {
  private readonly entries = new Map<string, WorkingMemoryEntry>();
  private readonly maxSizeChars: number;
  private readonly logger: StructuredLogger;
  private readonly sessionId: string;

  constructor(sessionId: string, options: WorkingMemoryOptions) {
    this.sessionId = sessionId;
    this.maxSizeChars = options.maxSizeChars;
    this.logger = options.logger;
  }

  /** Get a single entry by key, or undefined if not found. */
  get(key: string): WorkingMemoryEntry | undefined {
    return this.entries.get(key);
  }

  /** Get all entries as a readonly array. */
  getAll(): readonly WorkingMemoryEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Set (create or update) an entry. Throws if adding this entry would exceed
   * the size budget even after evicting stale entries.
   */
  set(
    key: string,
    category: WorkingMemoryEntry["category"],
    content: string,
  ): void {
    const now = Date.now();
    const previousEntry = this.entries.get(key);
    const newEntry: WorkingMemoryEntry = {
      key,
      category,
      content,
      createdAt: previousEntry?.createdAt ?? now,
      updatedAt: now,
    };

    // Temporarily remove old version of this key (if any) for size calculation
    this.entries.delete(key);

    const currentSize = this.calculateSize();
    const entrySize = this.entrySize(newEntry);

    if (currentSize + entrySize > this.maxSizeChars) {
      // Try evicting oldest entries to make room
      this.evictUntilFits(entrySize);

      if (this.calculateSize() + entrySize > this.maxSizeChars) {
        // Restore the previous entry if we can't fit the new one
        if (previousEntry) {
          this.entries.set(key, previousEntry);
        }
        throw new WorkingMemoryError(
          `Entry "${key}" (${entrySize} chars) exceeds remaining budget (${this.maxSizeChars - this.calculateSize()} available)`,
          "BUDGET_EXCEEDED",
        );
      }
    }

    this.entries.set(key, newEntry);

    this.logger.log({
      sessionId: this.sessionId,
      eventType: "memory:write",
      component: "working-memory",
      payload: { key, category, contentLength: content.length },
    });
  }

  /** Delete a single entry by key. Returns true if the entry existed. */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Clear all entries. */
  clear(): void {
    this.entries.clear();
  }

  /** Current total size in characters. */
  get size(): number {
    return this.calculateSize();
  }

  /** Number of entries. */
  get count(): number {
    return this.entries.size;
  }

  /**
   * Serialize working memory to a string suitable for injection into the
   * system prompt. Groups entries by category.
   */
  serialize(): string {
    if (this.entries.size === 0) return "";

    const byCategory = new Map<string, WorkingMemoryEntry[]>();
    for (const entry of this.entries.values()) {
      const list = byCategory.get(entry.category);
      if (list) {
        list.push(entry);
      } else {
        byCategory.set(entry.category, [entry]);
      }
    }

    const sections: string[] = [];
    const categoryOrder: WorkingMemoryEntry["category"][] = [
      "goal",
      "fact",
      "decision",
      "correction",
    ];

    for (const cat of categoryOrder) {
      const list = byCategory.get(cat);
      if (!list || list.length === 0) continue;
      const label = cat.charAt(0).toUpperCase() + cat.slice(1) + "s";
      const items = list.map((e) => `- [${e.key}] ${e.content}`).join("\n");
      sections.push(`### ${label}\n${items}`);
    }

    return sections.join("\n\n");
  }

  /**
   * Create an independent copy of this working memory bound to a new session.
   * All entries are deep-copied; mutations to either instance are independent.
   */
  clone(newSessionId: string, options: WorkingMemoryOptions): WorkingMemory {
    const cloned = new WorkingMemory(newSessionId, options);
    for (const entry of this.entries.values()) {
      cloned.entries.set(entry.key, {
        key: entry.key,
        category: entry.category,
        content: entry.content,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
    return cloned;
  }

  private calculateSize(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += this.entrySize(entry);
    }
    return total;
  }

  private entrySize(entry: WorkingMemoryEntry): number {
    // key + category + content + small overhead for formatting
    return entry.key.length + entry.category.length + entry.content.length + 10;
  }

  /** Evict oldest entries until `needed` chars can fit. */
  private evictUntilFits(needed: number): void {
    const sorted = Array.from(this.entries.entries()).sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    );

    for (const [key] of sorted) {
      if (this.calculateSize() + needed <= this.maxSizeChars) break;
      this.entries.delete(key);
    }
  }
}
