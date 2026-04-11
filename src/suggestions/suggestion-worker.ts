import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BetterClawsError,
  type BetterClawsConfig,
  type ChatMessage,
  type LlmResponse,
  type SuggestionCategory,
  type SuggestionsConfig,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import type { LongTermStore } from "../memory/long-term-store.js";
import type { SuggestionStore, CreateSuggestionInput } from "./suggestion-store.js";

export class SuggestionError extends BetterClawsError {
  constructor(message: string, code: string = "SUGGESTION_ERROR") {
    super(message, "suggestion-worker", code);
    this.name = "SuggestionError";
  }
}

// ── LLM interface (subset needed by suggestions) ──────────────────────────

export interface SuggestionLlmClient {
  chat(messages: readonly ChatMessage[]): Promise<LlmResponse>;
}

// ── Options ───────────────────────────────────────────────────────────────

export interface SuggestionWorkerOptions {
  readonly store: SuggestionStore;
  readonly memoryStore: LongTermStore;
  readonly llmClient: SuggestionLlmClient;
  readonly config: SuggestionsConfig;
  readonly appConfig: BetterClawsConfig;
  readonly logger: StructuredLogger;
  readonly logsDirectory: string;
}

// ── System prompt ─────────────────────────────────────────────────────────

const SUGGESTION_SYSTEM_PROMPT = `You are a configuration advisor for a personal AI assistant called betterClaws. Your role is to analyze usage patterns and suggest improvements.

Given context about the user's sessions, memory entries, tool usage, current configuration, and any errors, generate actionable suggestions. Each suggestion should be one specific, concrete improvement.

Categories of suggestions:
- "persona": Changes to the AI's personality/system prompt to better match user needs
- "user-context": Updates to stored user information (name, preferences, timezone, etc.)
- "tools": Adding, removing, or reconfiguring tools/MCP servers/skills
- "integration": Fixing errors, connection issues, or misconfigurations
- "workflow": Improvements to schedules, memory settings, or operational patterns
- "general": Other improvements

Return a JSON array of objects, each with:
- "category": one of the categories above
- "title": a short imperative title (e.g., "Add a web search tool")
- "body": a 1-3 sentence explanation of the suggestion and why it would help

Guidelines:
- Only suggest things that are clearly supported by the usage data
- Don't suggest things that are already configured correctly
- Focus on the most impactful improvements
- Limit to 3-5 suggestions per cycle
- Don't repeat suggestions that already exist in the pending list

Respond ONLY with valid JSON — no markdown, no explanation. Return [] if no suggestions are warranted.`;

// ── Worker ────────────────────────────────────────────────────────────────

export class SuggestionWorker {
  private readonly store: SuggestionStore;
  private readonly memoryStore: LongTermStore;
  private readonly llmClient: SuggestionLlmClient;
  private readonly config: SuggestionsConfig;
  private readonly appConfig: BetterClawsConfig;
  private readonly logger: StructuredLogger;
  private readonly logsDirectory: string;
  private readonly maxLlmCallsPerCycle: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private llmCallsThisCycle = 0;

  constructor(options: SuggestionWorkerOptions) {
    this.store = options.store;
    this.memoryStore = options.memoryStore;
    this.llmClient = options.llmClient;
    this.config = options.config;
    this.appConfig = options.appConfig;
    this.logger = options.logger;
    this.logsDirectory = options.logsDirectory;
    this.maxLlmCallsPerCycle = options.config.maxLlmCallsPerCycle;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.log({
        sessionId: null,
        eventType: "suggestion:generated",
        component: "suggestion-worker",
        payload: { action: "disabled" },
      });
      return;
    }

    this.running = true;
    const intervalMs = this.config.intervalMinutes * 60_000;

    this.timer = setInterval(() => {
      void this.runCycle();
    }, intervalMs);

    this.logger.log({
      sessionId: null,
      eventType: "suggestion:generated",
      component: "suggestion-worker",
      payload: {
        action: "start",
        intervalMinutes: this.config.intervalMinutes,
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
      eventType: "suggestion:generated",
      component: "suggestion-worker",
      payload: { action: "stop" },
    });
  }

  async runCycle(): Promise<SuggestionCycleResult> {
    this.llmCallsThisCycle = 0;

    const result: SuggestionCycleResult = {
      suggestionsCreated: 0,
      prunedDismissed: 0,
    };

    try {
      // 1. Gather context
      const context = await this.gatherContext();

      // 2. Call LLM for suggestions
      if (this.canMakeLlmCall() && context.length > 0) {
        const suggestions = await this.generateSuggestions(context);
        for (const s of suggestions) {
          this.store.create(s);
          result.suggestionsCreated++;
        }
      }

      // 3. Prune old dismissed suggestions (>30 days)
      result.prunedDismissed = this.store.pruneOld(30);

      // 4. Persist
      await this.store.persist();

      this.logger.log({
        sessionId: null,
        eventType: "suggestion:generated",
        component: "suggestion-worker",
        payload: { action: "cycle_complete", ...result },
      });
    } catch (err) {
      this.logger.log({
        sessionId: null,
        eventType: "suggestion:generated",
        component: "suggestion-worker",
        payload: {
          action: "cycle_error",
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }

    return result;
  }

  // ── Context Gathering ──────────────────────────────────────────────────

  private async gatherContext(): Promise<string> {
    const parts: string[] = [];

    // Current config summary (redact secrets)
    parts.push(this.summarizeConfig());

    // Memory entries summary
    const memories = this.memoryStore.getAll();
    if (memories.length > 0) {
      const memSummary = memories
        .slice(0, 50)
        .map(m => `[${m.category}] (conf=${m.confidence.toFixed(2)}) ${m.content}`)
        .join("\n");
      parts.push(`## Memory Entries (${memories.length} total, showing up to 50)\n${memSummary}`);
    } else {
      parts.push("## Memory Entries\nNo long-term memory entries yet.");
    }

    // Existing pending suggestions (to avoid duplicates)
    const pending = this.store.getByStatus("pending");
    if (pending.length > 0) {
      const pendingSummary = pending
        .map(s => `- [${s.category}] ${s.title}`)
        .join("\n");
      parts.push(`## Existing Pending Suggestions (do NOT repeat these)\n${pendingSummary}`);
    }

    // Recent log activity summary
    const logSummary = await this.summarizeRecentLogs();
    if (logSummary) {
      parts.push(logSummary);
    }

    return parts.join("\n\n");
  }

  private summarizeConfig(): string {
    const lines: string[] = ["## Current Configuration"];

    // Persona
    const persona = this.appConfig.systemContext?.persona;
    lines.push(`Persona: ${persona ? `"${persona.slice(0, 200)}..."` : "(not set)"}`);

    // User context
    const userCtx = this.appConfig.systemContext?.userContext;
    lines.push(`User context: ${userCtx ? `"${userCtx.slice(0, 200)}..."` : "(not set)"}`);

    // Timezone
    lines.push(`Timezone: ${this.appConfig.systemContext?.timezone ?? "UTC"}`);

    // LLM model
    lines.push(`LLM model: ${this.appConfig.llm.model}`);
    if (this.appConfig.llm.weak) {
      lines.push(`Weak LLM: ${this.appConfig.llm.weak.model}`);
    }

    // Adapters
    const adapterNames = Object.entries(this.appConfig.adapters)
      .filter(([, v]) => v.enabled)
      .map(([k]) => k);
    lines.push(`Active adapters: ${adapterNames.length > 0 ? adapterNames.join(", ") : "none"}`);

    // Tools
    const mcpServers = Object.keys(this.appConfig.tools?.mcpServers ?? {});
    const skills = Object.keys(this.appConfig.tools?.skills ?? {});
    lines.push(`MCP servers: ${mcpServers.length > 0 ? mcpServers.join(", ") : "none"}`);
    lines.push(`Skills: ${skills.length > 0 ? skills.join(", ") : "none"}`);

    // Memory config
    lines.push(`Memory curation: ${this.appConfig.memory.curationEnabled ? "enabled" : "disabled"}`);

    // Schedules
    const schedCount = this.appConfig.schedules?.length ?? 0;
    lines.push(`Scheduled tasks: ${schedCount}`);

    return lines.join("\n");
  }

  private async summarizeRecentLogs(): Promise<string | null> {
    const today = new Date().toISOString().slice(0, 10);
    const logPath = join(this.logsDirectory, `${today}.jsonl`);

    let lines: string[];
    try {
      const content = await readFile(logPath, "utf-8");
      lines = content.trim().split("\n").filter(Boolean);
    } catch {
      return null;
    }

    if (lines.length === 0) return null;

    // Count event types and errors
    const eventCounts = new Map<string, number>();
    const errors: string[] = [];
    const toolUsage = new Map<string, number>();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const eventType = entry["eventType"] as string;

        eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);

        // Track tool usage
        if (eventType === "tool:invoke") {
          const payload = entry["payload"] as Record<string, unknown> | undefined;
          const toolName = payload?.["tool"] as string | undefined;
          if (toolName) {
            toolUsage.set(toolName, (toolUsage.get(toolName) ?? 0) + 1);
          }
        }

        // Track errors
        if (eventType === "tool:warning" || eventType === "executor:timeout") {
          const payload = entry["payload"] as Record<string, unknown> | undefined;
          const error = payload?.["error"] as string | undefined;
          if (error && errors.length < 5) {
            errors.push(`[${eventType}] ${error.slice(0, 150)}`);
          }
        }
      } catch {
        continue;
      }
    }

    const parts: string[] = ["## Recent Activity (today)"];

    // Event summary
    const eventSummary = Array.from(eventCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([type, count]) => `${type}: ${count}`)
      .join(", ");
    parts.push(`Events: ${eventSummary}`);

    // Tool usage
    if (toolUsage.size > 0) {
      const toolSummary = Array.from(toolUsage.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}(${count})`)
        .join(", ");
      parts.push(`Tool usage: ${toolSummary}`);
    }

    // Errors
    if (errors.length > 0) {
      parts.push(`Errors/warnings:\n${errors.map(e => `- ${e}`).join("\n")}`);
    }

    return parts.join("\n");
  }

  // ── LLM Suggestion Generation ─────────────────────────────────────────

  private async generateSuggestions(context: string): Promise<readonly CreateSuggestionInput[]> {
    this.llmCallsThisCycle++;

    const messages: ChatMessage[] = [
      { role: "system", content: SUGGESTION_SYSTEM_PROMPT },
      { role: "user", content: context },
    ];

    this.logger.log({
      sessionId: null,
      eventType: "suggestion:generated",
      component: "suggestion-worker",
      payload: { action: "llm_call", contextLength: context.length },
    });

    try {
      const response = await this.llmClient.chat(messages);
      return this.parseSuggestionResponse(response.message.content);
    } catch (err) {
      this.logger.log({
        sessionId: null,
        eventType: "suggestion:generated",
        component: "suggestion-worker",
        payload: {
          action: "llm_error",
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return [];
    }
  }

  private parseSuggestionResponse(content: string): readonly CreateSuggestionInput[] {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!Array.isArray(parsed)) return [];

      const validCategories = new Set<SuggestionCategory>([
        "persona", "user-context", "tools", "integration", "workflow", "general",
      ]);

      const results: CreateSuggestionInput[] = [];

      for (const item of parsed) {
        if (
          typeof item === "object" &&
          item !== null &&
          "category" in item &&
          "title" in item &&
          "body" in item
        ) {
          const obj = item as Record<string, unknown>;
          const category = obj["category"] as string;
          const title = obj["title"] as string;
          const body = obj["body"] as string;

          if (
            typeof category === "string" &&
            typeof title === "string" &&
            typeof body === "string" &&
            validCategories.has(category as SuggestionCategory)
          ) {
            results.push({
              category: category as SuggestionCategory,
              title,
              body,
            });
          }
        }
      }

      return results.slice(0, 5); // Cap at 5 per cycle
    } catch {
      return [];
    }
  }

  private canMakeLlmCall(): boolean {
    return this.running && this.llmCallsThisCycle < this.maxLlmCallsPerCycle;
  }
}

// ── Result type ───────────────────────────────────────────────────────────

export interface SuggestionCycleResult {
  suggestionsCreated: number;
  prunedDismissed: number;
}
