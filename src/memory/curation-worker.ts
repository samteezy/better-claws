import { toErrorMessage } from "../utils/errors.js";
import {
  createErrorClass,
  type MemoryConfig,
  type MemoryEntry,
  type ChatMessage,
  type LlmResponse } from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import type { LongTermStore } from "./long-term-store.js";
import type { SessionManager } from "../sessions/session-manager.js";

export const CurationError = createErrorClass("CurationError", "curation-worker", "CURATION_ERROR");

// ── LLM interface (subset needed by curation) ──────────────────────────────

export interface CurationLlmClient {
  chat(
    messages: readonly ChatMessage[],
  ): Promise<LlmResponse>;
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface CurationWorkerOptions {
  readonly store: LongTermStore;
  readonly sessionManager: SessionManager;
  readonly llmClient: CurationLlmClient;
  readonly config: MemoryConfig;
  readonly logger: StructuredLogger;
  /** Max LLM calls per curation cycle. Prevents runaway cost. */
  readonly maxLlmCallsPerCycle?: number;
}

// ── Distillation prompt ─────────────────────────────────────────────────────

const DISTILLATION_SYSTEM_PROMPT = `You are a memory curation agent. Given a conversation log, extract durable facts, user preferences, project details, entity information, and procedures as structured memory entries.

Return a JSON array of objects, each with:
- "category": one of "fact", "preference", "project", "entity", "procedure"
- "content": a concise statement of what was learned
- "confidence": a number 0-1 indicating how confident you are this is a durable memory
- "tags": an array of relevant keyword strings

Only extract information that would be useful across future conversations. Do not include ephemeral details like greetings or one-time requests. Return [] if nothing durable was discussed.

Respond ONLY with valid JSON — no markdown, no explanation.`;

// ── Consolidation prompt ────────────────────────────────────────────────────

const CONSOLIDATION_SYSTEM_PROMPT = `You are a memory consolidation agent. Given a set of potentially overlapping or contradictory memory entries, identify which entries should be consolidated.

For each group of related entries, indicate which entry is the most current/accurate (the "winner") and which entries it supersedes.

Return a JSON array of objects, each with:
- "winnerId": the id of the most current/accurate entry
- "supersededIds": array of ids that the winner supersedes
- "updatedContent": optional updated content if the winner should be refined
- "updatedConfidence": optional updated confidence

Return [] if no consolidation is needed.

Respond ONLY with valid JSON — no markdown, no explanation.`;

// ── Parsed types ────────────────────────────────────────────────────────────

interface DistilledEntry {
  readonly category: MemoryEntry["category"];
  readonly content: string;
  readonly confidence: number;
  readonly tags: readonly string[];
}

interface ConsolidationAction {
  readonly winnerId: string;
  readonly supersededIds: readonly string[];
  readonly updatedContent?: string;
  readonly updatedConfidence?: number;
}

// ── Worker ──────────────────────────────────────────────────────────────────

export class CurationWorker {
  private readonly store: LongTermStore;
  private readonly sessionManager: SessionManager;
  private readonly llmClient: CurationLlmClient;
  private readonly config: MemoryConfig;
  private readonly logger: StructuredLogger;
  private readonly maxLlmCallsPerCycle: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private llmCallsThisCycle = 0;

  constructor(options: CurationWorkerOptions) {
    this.store = options.store;
    this.sessionManager = options.sessionManager;
    this.llmClient = options.llmClient;
    this.config = options.config;
    this.logger = options.logger;
    this.maxLlmCallsPerCycle = options.maxLlmCallsPerCycle ?? 5;
  }

  async start(): Promise<void> {
    if (!this.config.curationEnabled) {
      this.logger.log({
        sessionId: null,
        eventType: "memory:curation",
        component: "curation-worker",
        payload: { action: "disabled" },
      });
      return;
    }

    this.running = true;
    const intervalMs = this.config.curationIntervalMinutes * 60_000;

    this.timer = setInterval(() => {
      void this.runCycle();
    }, intervalMs);

    this.logger.log({
      sessionId: null,
      eventType: "memory:curation",
      component: "curation-worker",
      payload: {
        action: "start",
        intervalMinutes: this.config.curationIntervalMinutes,
      },
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.logger.log({
      sessionId: null,
      eventType: "memory:curation",
      component: "curation-worker",
      payload: { action: "stop" },
    });
  }

  /**
   * Run a full curation cycle: distill idle sessions, consolidate,
   * apply decay, prune, and persist.
   */
  async runCycle(): Promise<CurationCycleResult> {
    this.llmCallsThisCycle = 0;

    const result: CurationCycleResult = {
      distilledSessions: 0,
      entriesCreated: 0,
      consolidated: 0,
      decayed: 0,
      stale: 0,
      pruned: 0,
    };

    try {
      // 1. Distill idle sessions
      const distillResult = await this.distillIdleSessions();
      result.distilledSessions = distillResult.sessions;
      result.entriesCreated = distillResult.entries;

      // 2. Consolidate overlapping entries
      result.consolidated = await this.consolidateEntries();

      // 3. Apply confidence decay
      const decayResult = this.store.applyConfidenceDecay();
      result.decayed = decayResult.decayed;
      result.stale = decayResult.stale;

      // 4. Prune over-budget entries
      result.pruned = this.store.prune();

      // 5. Persist all changes
      await this.store.persist();

      this.logger.log({
        sessionId: null,
        eventType: "memory:curation",
        component: "curation-worker",
        payload: { action: "cycle_complete", ...result },
      });
    } catch (err) {
      this.logger.log({
        sessionId: null,
        eventType: "memory:curation",
        component: "curation-worker",
        payload: {
          action: "cycle_error",
          error: toErrorMessage(err),
        },
      });
    }

    return result;
  }

  // ── Session Distillation ────────────────────────────────────────────────

  private async distillIdleSessions(): Promise<{ sessions: number; entries: number }> {
    const idleIds = this.sessionManager.checkIdleSessions();
    let sessions = 0;
    let entries = 0;

    for (const sessionId of idleIds) {
      if (!this.canMakeLlmCall()) break;

      const history = await this.sessionManager.getHistory(sessionId);
      if (history.length === 0) {
        await this.sessionManager.close(sessionId);
        continue;
      }

      const conversationText = history
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");

      const distilled = await this.callDistillation(conversationText, sessionId);
      for (const item of distilled) {
        await this.store.create({
          category: item.category,
          content: item.content,
          sourceSessions: [sessionId],
          confidence: item.confidence,
          tags: [...item.tags],
        });
        entries++;
      }

      await this.sessionManager.close(sessionId);
      sessions++;
    }

    return { sessions, entries };
  }

  private async callDistillation(
    conversationText: string,
    sessionId: string,
  ): Promise<readonly DistilledEntry[]> {
    this.llmCallsThisCycle++;

    const messages: ChatMessage[] = [
      { role: "system", content: DISTILLATION_SYSTEM_PROMPT },
      { role: "user", content: conversationText },
    ];

    this.logger.log({
      sessionId: null,
      eventType: "memory:curation",
      component: "curation-worker",
      payload: { action: "distillation_call", sessionId },
    });

    try {
      const response = await this.llmClient.chat(messages);
      return this.parseDistillationResponse(response.message.content);
    } catch (err) {
      this.logger.log({
        sessionId: null,
        eventType: "memory:curation",
        component: "curation-worker",
        payload: {
          action: "distillation_error",
          sessionId,
          error: toErrorMessage(err),
        },
      });
      return [];
    }
  }

  private parseDistillationResponse(content: string): readonly DistilledEntry[] {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!Array.isArray(parsed)) return [];

      const validCategories = new Set(["fact", "preference", "project", "entity", "procedure"]);
      const results: DistilledEntry[] = [];

      for (const item of parsed) {
        if (
          typeof item === "object" &&
          item !== null &&
          "category" in item &&
          "content" in item &&
          typeof (item as Record<string, unknown>)["category"] === "string" &&
          typeof (item as Record<string, unknown>)["content"] === "string" &&
          validCategories.has((item as Record<string, unknown>)["category"] as string)
        ) {
          const obj = item as Record<string, unknown>;
          results.push({
            category: obj["category"] as MemoryEntry["category"],
            content: obj["content"] as string,
            confidence: typeof obj["confidence"] === "number"
              ? Math.max(0, Math.min(1, obj["confidence"] as number))
              : 0.5,
            tags: Array.isArray(obj["tags"])
              ? (obj["tags"] as unknown[]).filter((t): t is string => typeof t === "string")
              : [],
          });
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  // ── Consolidation ───────────────────────────────────────────────────────

  private async consolidateEntries(): Promise<number> {
    if (!this.canMakeLlmCall()) return 0;

    const allEntries = this.store.getAll();
    if (allEntries.length < 2) return 0;

    // Group by category to reduce scope
    const byCategory = new Map<string, MemoryEntry[]>();
    for (const entry of allEntries) {
      const group = byCategory.get(entry.category) ?? [];
      group.push(entry);
      byCategory.set(entry.category, group);
    }

    let totalConsolidated = 0;

    for (const [category, entries] of byCategory) {
      if (entries.length < 2) continue;
      if (!this.canMakeLlmCall()) break;

      const actions = await this.callConsolidation(entries, category);
      for (const action of actions) {
        await this.applyConsolidation(action);
        totalConsolidated += action.supersededIds.length;
      }
    }

    return totalConsolidated;
  }

  private async callConsolidation(
    entries: readonly MemoryEntry[],
    category: string,
  ): Promise<readonly ConsolidationAction[]> {
    this.llmCallsThisCycle++;

    const entrySummary = entries
      .map((e) => `[id=${e.id}] (confidence=${e.confidence.toFixed(2)}, created=${new Date(e.created).toISOString()}) ${e.content}`)
      .join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: CONSOLIDATION_SYSTEM_PROMPT },
      { role: "user", content: `Category: ${category}\n\nEntries:\n${entrySummary}` },
    ];

    this.logger.log({
      sessionId: null,
      eventType: "memory:curation",
      component: "curation-worker",
      payload: { action: "consolidation_call", category, entryCount: entries.length },
    });

    try {
      const response = await this.llmClient.chat(messages);
      return this.parseConsolidationResponse(response.message.content);
    } catch (err) {
      this.logger.log({
        sessionId: null,
        eventType: "memory:curation",
        component: "curation-worker",
        payload: {
          action: "consolidation_error",
          category,
          error: toErrorMessage(err),
        },
      });
      return [];
    }
  }

  private parseConsolidationResponse(content: string): readonly ConsolidationAction[] {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!Array.isArray(parsed)) return [];

      const results: ConsolidationAction[] = [];

      for (const item of parsed) {
        if (
          typeof item === "object" &&
          item !== null &&
          "winnerId" in item &&
          "supersededIds" in item &&
          typeof (item as Record<string, unknown>)["winnerId"] === "string" &&
          Array.isArray((item as Record<string, unknown>)["supersededIds"])
        ) {
          const obj = item as Record<string, unknown>;
          results.push({
            winnerId: obj["winnerId"] as string,
            supersededIds: (obj["supersededIds"] as unknown[]).filter(
              (id): id is string => typeof id === "string",
            ),
            updatedContent: typeof obj["updatedContent"] === "string"
              ? obj["updatedContent"] as string
              : undefined,
            updatedConfidence: typeof obj["updatedConfidence"] === "number"
              ? obj["updatedConfidence"] as number
              : undefined,
          });
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  private async applyConsolidation(action: ConsolidationAction): Promise<void> {
    const winner = this.store.get(action.winnerId);
    if (!winner) return;

    // Update the winner if new content/confidence provided
    if (action.updatedContent !== undefined || action.updatedConfidence !== undefined) {
      await this.store.update(action.winnerId, {
        content: action.updatedContent,
        confidence: action.updatedConfidence,
      });
    }

    // Mark superseded entries: set low confidence so they get pruned,
    // but don't delete — the supersedes chain preserves history
    for (const supersededId of action.supersededIds) {
      const entry = this.store.get(supersededId);
      if (entry) {
        await this.store.update(supersededId, {
          confidence: 0,
        });
      }
    }

    this.logger.log({
      sessionId: null,
      eventType: "memory:curation",
      component: "curation-worker",
      payload: {
        action: "consolidation_applied",
        winnerId: action.winnerId,
        supersededCount: action.supersededIds.length,
      },
    });
  }

  // ── Rate limiting ───────────────────────────────────────────────────────

  private canMakeLlmCall(): boolean {
    return this.running && this.llmCallsThisCycle < this.maxLlmCallsPerCycle;
  }
}

// ── Result type ─────────────────────────────────────────────────────────────

export interface CurationCycleResult {
  distilledSessions: number;
  entriesCreated: number;
  consolidated: number;
  decayed: number;
  stale: number;
  pruned: number;
}
