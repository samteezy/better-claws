import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isEnoent, toErrorMessage } from "../utils/errors.js";
import { createErrorClass, type AgendaItem } from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";

export const AgendaStoreError = createErrorClass("AgendaStoreError", "agenda-store", "AGENDA_STORE_ERROR");

const DEFAULT_ITEM_COOLDOWN_MS = 86_400_000; // 24 hours

/**
 * Persistent, per-sender agenda store. Backed by a single JSONL file
 * at data/memory/agenda.jsonl. Items survive session close and span
 * all channels for a given senderId.
 */
export class AgendaStore {
  private readonly filePath: string;
  private readonly logger: StructuredLogger;
  private items = new Map<string, AgendaItem>();
  private dirCreated = false;

  constructor(filePath: string, logger: StructuredLogger) {
    this.filePath = filePath;
    this.logger = logger;
  }

  async load(): Promise<void> {
    await this.ensureDirectory();
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch (err) {
      if (isEnoent(err)) return;
      throw new AgendaStoreError(`Failed to read agenda: ${toErrorMessage(err)}`, "READ_ERROR");
    }

    for (const line of content.trim().split("\n").filter(Boolean)) {
      try {
        const item = JSON.parse(line) as AgendaItem;
        this.items.set(item.id, item);
      } catch {
        // skip malformed lines
      }
    }
  }

  async add(input: Omit<AgendaItem, "id" | "addedAt" | "updatedAt">): Promise<string> {
    const now = Date.now();
    const id = randomUUID();
    const item: AgendaItem = { ...input, id, addedAt: now, updatedAt: now };
    this.items.set(id, item);
    await this.appendEntry(item);
    this.logger.log({
      sessionId: input.sourceSessionId ?? null,
      eventType: "agenda:write",
      component: "agenda-store",
      payload: { action: "add", id, type: item.type, priority: item.priority },
    });
    return id;
  }

  get(id: string): AgendaItem | undefined {
    return this.items.get(id);
  }

  async update(
    id: string,
    patch: { status?: AgendaItem["status"]; priority?: AgendaItem["priority"]; content?: string; snoozeUntil?: number },
  ): Promise<AgendaItem> {
    const item = this.items.get(id);
    if (!item) throw new AgendaStoreError(`Agenda item "${id}" not found`, "NOT_FOUND");
    const updated: AgendaItem = { ...item, ...patch, updatedAt: Date.now() };
    this.items.set(id, updated);
    await this.persist();
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const existed = this.items.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  /** Items eligible to be raised: not resolved, and not currently within a snooze window. */
  listPending(senderId: string): readonly AgendaItem[] {
    const now = Date.now();
    return Array.from(this.items.values()).filter(
      (i) =>
        i.senderId === senderId &&
        i.status !== "resolved" &&
        (i.snoozeUntil === undefined || i.snoozeUntil <= now),
    );
  }

  listAll(senderId: string): readonly AgendaItem[] {
    return Array.from(this.items.values()).filter((i) => i.senderId === senderId);
  }

  async markRaised(id: string): Promise<AgendaItem> {
    const item = this.items.get(id);
    if (!item) throw new AgendaStoreError(`Agenda item "${id}" not found`, "NOT_FOUND");
    const updated: AgendaItem = { ...item, status: "raised", lastRaisedAt: Date.now(), updatedAt: Date.now() };
    this.items.set(id, updated);
    await this.persist();
    return updated;
  }

  async resolve(id: string): Promise<AgendaItem> {
    return this.update(id, { status: "resolved" });
  }

  async snooze(id: string, untilMs: number): Promise<AgendaItem> {
    return this.update(id, { status: "snoozed", snoozeUntil: untilMs });
  }

  /**
   * Check whether an item is eligible to be raised right now.
   * Respects per-item 24h cooldown (except for high-priority items).
   */
  canRaise(item: AgendaItem): boolean {
    if (item.status === "resolved" || item.status === "snoozed") return false;
    if (item.snoozeUntil !== undefined && item.snoozeUntil > Date.now()) return false;
    if (item.priority === "high") return true;
    if (item.lastRaisedAt !== undefined) {
      return Date.now() - item.lastRaisedAt >= DEFAULT_ITEM_COOLDOWN_MS;
    }
    return true;
  }

  /** Serialize pending items for prompt injection. Includes id for resolution. */
  serializeForPrompt(senderId: string, maxItems: number): readonly string[] {
    return this.listPending(senderId)
      .filter((i) => this.canRaise(i))
      .sort((a, b) => {
        const priorityOrder: Record<AgendaItem["priority"], number> = { high: 0, normal: 1, low: 2 };
        return (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);
      })
      .slice(0, maxItems)
      .map((i) => `[id:${i.id}] (${i.type}, ${i.priority}) ${i.content}`);
  }

  async persist(): Promise<void> {
    await this.ensureDirectory();
    const lines = Array.from(this.items.values())
      .map((i) => JSON.stringify(i))
      .join("\n");
    await writeFile(this.filePath, lines + (lines.length > 0 ? "\n" : ""), "utf-8");
  }

  private async appendEntry(item: AgendaItem): Promise<void> {
    await this.ensureDirectory();
    await appendFile(this.filePath, JSON.stringify(item) + "\n", "utf-8");
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.dirCreated) {
      await mkdir(join(this.filePath, ".."), { recursive: true });
      this.dirCreated = true;
    }
  }
}
