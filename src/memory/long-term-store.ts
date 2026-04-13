import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isEnoent, toErrorMessage } from "../utils/errors.js";
import {
  createErrorClass,
  type MemoryEntry,
  type MemoryConfig } from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";

export const LongTermStoreError = createErrorClass("LongTermStoreError", "long-term-store", "LONG_TERM_STORE_ERROR");

export interface LongTermStoreOptions {
  readonly directory: string;
  readonly config: MemoryConfig;
  readonly logger: StructuredLogger;
}

/**
 * Cross-session long-term memory (Tier 3). Persisted as JSONL in
 * `data/memory/entries.jsonl`. Supports CRUD, confidence decay,
 * supersedes chains, and size-budget pruning.
 */
export class LongTermStore {
  private readonly directory: string;
  private readonly config: MemoryConfig;
  private readonly logger: StructuredLogger;
  private entries = new Map<string, MemoryEntry>();
  private dirCreated = false;

  constructor(options: LongTermStoreOptions) {
    this.directory = options.directory;
    this.config = options.config;
    this.logger = options.logger;
  }

  /** Load all entries from the JSONL file into memory. */
  async load(): Promise<void> {
    await this.ensureDirectory();
    const filePath = this.filePath();

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      if (isEnoent(err)) {
        return; // no file yet — start empty
      }
      throw new LongTermStoreError(
        `Failed to read memory store: ${toErrorMessage(err)}`,
        "READ_ERROR",
      );
    }

    const lines = content.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as MemoryEntry;
        this.entries.set(entry.id, entry);
      } catch {
        // skip malformed lines
      }
    }
  }

  /** Create a new memory entry. Returns the generated id. */
  async create(
    input: Omit<MemoryEntry, "id" | "created" | "lastAccessed">,
  ): Promise<string> {
    const now = Date.now();
    const id = randomUUID();

    const entry: MemoryEntry = {
      id,
      category: input.category,
      content: input.content,
      sourceSessions: [...input.sourceSessions],
      created: now,
      lastAccessed: now,
      confidence: Math.max(0, Math.min(1, input.confidence)),
      supersedes: input.supersedes,
      tags: [...input.tags],
    };

    this.entries.set(id, entry);
    await this.appendEntry(entry);

    this.logger.log({
      sessionId: null,
      eventType: "memory:write",
      component: "long-term-store",
      payload: { action: "create", id, category: entry.category },
    });

    return id;
  }

  /** Get a single entry by id, updating lastAccessed. */
  get(id: string): MemoryEntry | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      entry.lastAccessed = Date.now();

      this.logger.log({
        sessionId: null,
        eventType: "memory:read",
        component: "long-term-store",
        payload: { action: "get", id },
      });
    }
    return entry;
  }

  /** Get all entries (does not update lastAccessed). */
  getAll(): readonly MemoryEntry[] {
    return Array.from(this.entries.values());
  }

  /** Number of entries. */
  get count(): number {
    return this.entries.size;
  }

  /**
   * Update an existing entry's content and/or confidence.
   * Preserves created timestamp and id.
   */
  async update(
    id: string,
    patch: Partial<Pick<MemoryEntry, "content" | "confidence" | "tags">>,
  ): Promise<MemoryEntry> {
    const existing = this.entries.get(id);
    if (!existing) {
      throw new LongTermStoreError(
        `Memory entry "${id}" not found`,
        "NOT_FOUND",
      );
    }

    const updated: MemoryEntry = {
      ...existing,
      content: patch.content ?? existing.content,
      confidence: Math.max(0, Math.min(1, patch.confidence ?? existing.confidence)),
      tags: patch.tags ? [...patch.tags] : [...existing.tags],
      lastAccessed: Date.now(),
    };

    this.entries.set(id, updated);
    await this.persist();

    this.logger.log({
      sessionId: null,
      eventType: "memory:write",
      component: "long-term-store",
      payload: { action: "update", id },
    });

    return updated;
  }

  /** Delete an entry by id. Returns true if it existed. */
  async delete(id: string): Promise<boolean> {
    const existed = this.entries.delete(id);
    if (existed) {
      await this.persist();
      this.logger.log({
        sessionId: null,
        eventType: "memory:write",
        component: "long-term-store",
        payload: { action: "delete", id },
      });
    }
    return existed;
  }

  /**
   * Search entries by category and/or tags. Returns all matches
   * (filtering only — scoring is done by the retriever).
   */
  search(options?: {
    category?: MemoryEntry["category"];
    tags?: readonly string[];
    minConfidence?: number;
  }): readonly MemoryEntry[] {
    let results = Array.from(this.entries.values());

    if (options?.category) {
      results = results.filter((e) => e.category === options.category);
    }

    if (options?.tags && options.tags.length > 0) {
      const tagSet = new Set(options.tags);
      results = results.filter((e) => e.tags.some((t) => tagSet.has(t)));
    }

    if (options?.minConfidence !== undefined) {
      results = results.filter((e) => e.confidence >= options.minConfidence!);
    }

    return results;
  }

  /**
   * Apply confidence decay to all entries based on time since last access.
   * Entries below the stale threshold are not deleted, just flagged
   * (excluded from retrieval by the minConfidence filter).
   */
  applyConfidenceDecay(): { decayed: number; stale: number } {
    const now = Date.now();
    const msPerDay = 86_400_000;
    let decayed = 0;
    let stale = 0;

    for (const entry of this.entries.values()) {
      const daysSinceAccess = (now - entry.lastAccessed) / msPerDay;
      if (daysSinceAccess <= 0) continue;

      const decay = this.config.confidenceDecayRate * daysSinceAccess;
      const newConfidence = Math.max(0, entry.confidence - decay);

      if (newConfidence !== entry.confidence) {
        entry.confidence = newConfidence;
        decayed++;
      }

      if (newConfidence < this.config.staleThreshold) {
        stale++;
      }
    }

    return { decayed, stale };
  }

  /**
   * Prune lowest-confidence entries when count exceeds maxLongTermEntries.
   * Returns the number of entries pruned.
   */
  prune(): number {
    const max = this.config.maxLongTermEntries;
    if (this.entries.size <= max) return 0;

    const sorted = Array.from(this.entries.entries()).sort(
      (a, b) => a[1].confidence - b[1].confidence,
    );

    const toRemove = this.entries.size - max;
    let pruned = 0;

    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      const key = sorted[i]![0];
      this.entries.delete(key);
      pruned++;
    }

    return pruned;
  }

  /**
   * Persist the full in-memory state to disk (compact rewrite).
   * Use after bulk operations like decay + prune.
   */
  async persist(): Promise<void> {
    await this.ensureDirectory();
    const lines = Array.from(this.entries.values())
      .map((e) => JSON.stringify(e))
      .join("\n");
    await writeFile(this.filePath(), lines + (lines.length > 0 ? "\n" : ""), "utf-8");
  }

  /**
   * Resolve a supersedes chain: given an entry id, walk the
   * `supersedes` links to find the original entry.
   */
  resolveChain(id: string): readonly MemoryEntry[] {
    const chain: MemoryEntry[] = [];
    let currentId: string | undefined = id;

    while (currentId) {
      const entry = this.entries.get(currentId);
      if (!entry) break;
      chain.push(entry);
      currentId = entry.supersedes;
    }

    return chain;
  }

  private filePath(): string {
    return join(this.directory, "entries.jsonl");
  }

  private async appendEntry(entry: MemoryEntry): Promise<void> {
    await this.ensureDirectory();
    await appendFile(this.filePath(), JSON.stringify(entry) + "\n", "utf-8");
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.dirCreated) {
      await mkdir(this.directory, { recursive: true });
      this.dirCreated = true;
    }
  }
}
