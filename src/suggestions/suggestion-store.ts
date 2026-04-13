import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BetterClawsError,
  type Suggestion,
  type SuggestionCategory,
  type SuggestionStatus,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import { isEnoent, toErrorMessage } from "../utils/errors.js";

export class SuggestionStoreError extends BetterClawsError {
  constructor(message: string, code: string = "SUGGESTION_STORE_ERROR") {
    super(message, "suggestion-store", code);
    this.name = "SuggestionStoreError";
  }
}

export interface SuggestionStoreOptions {
  readonly directory: string;
  readonly logger: StructuredLogger;
}

export interface CreateSuggestionInput {
  readonly category: SuggestionCategory;
  readonly title: string;
  readonly body: string;
}

/**
 * Persisted store for auto-generated suggestions. Stored as JSONL
 * in `data/suggestions/suggestions.jsonl`.
 */
export class SuggestionStore {
  private readonly directory: string;
  private readonly logger: StructuredLogger;
  private entries = new Map<string, Suggestion>();
  private dirCreated = false;

  constructor(options: SuggestionStoreOptions) {
    this.directory = options.directory;
    this.logger = options.logger;
  }

  async load(): Promise<void> {
    await this.ensureDirectory();
    const filePath = this.filePath();

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      if (isEnoent(err)) {
        return;
      }
      throw new SuggestionStoreError(
        `Failed to read suggestion store: ${toErrorMessage(err)}`,
        "READ_ERROR",
      );
    }

    const lines = content.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Suggestion;
        if (entry.id) {
          this.entries.set(entry.id, entry);
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  create(input: CreateSuggestionInput): Suggestion {
    const now = Date.now();
    const suggestion: Suggestion = {
      id: randomUUID(),
      category: input.category,
      title: input.title,
      body: input.body,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    this.entries.set(suggestion.id, suggestion);

    this.logger.log({
      sessionId: null,
      eventType: "suggestion:generated",
      component: "suggestion-store",
      payload: {
        action: "created",
        id: suggestion.id,
        category: suggestion.category,
        title: suggestion.title,
      },
    });

    return suggestion;
  }

  get(id: string): Suggestion | undefined {
    return this.entries.get(id);
  }

  getAll(): readonly Suggestion[] {
    return Array.from(this.entries.values());
  }

  getByStatus(status: SuggestionStatus): readonly Suggestion[] {
    return Array.from(this.entries.values()).filter(s => s.status === status);
  }

  updateStatus(id: string, status: SuggestionStatus): Suggestion | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;

    entry.status = status;
    entry.updatedAt = Date.now();

    this.logger.log({
      sessionId: null,
      eventType: "suggestion:status",
      component: "suggestion-store",
      payload: { action: "status_updated", id, status },
    });

    return entry;
  }

  delete(id: string): boolean {
    const existed = this.entries.delete(id);
    if (existed) {
      this.logger.log({
        sessionId: null,
        eventType: "suggestion:status",
        component: "suggestion-store",
        payload: { action: "deleted", id },
      });
    }
    return existed;
  }

  /** Persist all entries to disk (full rewrite). */
  async persist(): Promise<void> {
    await this.ensureDirectory();
    const lines = Array.from(this.entries.values())
      .map(e => JSON.stringify(e))
      .join("\n");
    await writeFile(this.filePath(), lines + (lines.length > 0 ? "\n" : ""), "utf-8");
  }

  /** Remove dismissed suggestions older than the given age in days. */
  pruneOld(maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let pruned = 0;
    for (const [id, entry] of this.entries) {
      if (entry.status === "dismissed" && entry.updatedAt < cutoff) {
        this.entries.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  private filePath(): string {
    return join(this.directory, "suggestions.jsonl");
  }

  private async ensureDirectory(): Promise<void> {
    if (this.dirCreated) return;
    await mkdir(this.directory, { recursive: true });
    this.dirCreated = true;
  }
}
