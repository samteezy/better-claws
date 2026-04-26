import { toErrorMessage } from "../utils/errors.js";
import { createErrorClass, type AgendaItem, type ChatMessage, type ReflectConfig, type SessionState } from "../types.js";
import type { LongTermStore } from "../memory/long-term-store.js";
import type { AgendaStore } from "../memory/agenda-store.js";
import type { StructuredLogger } from "../logger/structured-logger.js";

export const ReflectionError = createErrorClass("ReflectionError", "reflection-job", "REFLECTION_ERROR");

export interface ReflectionLlmClient {
  chat(messages: readonly ChatMessage[]): Promise<{ message: ChatMessage }>;
}

export interface ReflectionResult {
  readonly taskComplete: boolean;
  readonly completionSummary?: string;
  readonly nudgeItemId?: string;
  readonly nudgeRationale?: string;
  readonly memoryCandidate?: string;
  readonly selfPattern?: string;
}

interface ReflectionLlmOutput {
  taskComplete: boolean;
  completionSummary?: string;
  nudgeItemId?: string;
  nudgeRationale?: string;
  memoryCandidate?: string;
  selfPattern?: string;
}

const REFLECTION_SYSTEM_PROMPT = `You are a background reflection agent for an AI assistant. After each conversation turn, you silently review recent exchanges to decide what needs follow-up.

Given the recent conversation history and a list of pending agenda items, answer these four questions by returning a single JSON object (no markdown, no extra text):

{
  "taskComplete": true/false,        // Was the previous exchange a completed task or resolved question?
  "completionSummary": "...",        // If taskComplete, a one-sentence summary of what was resolved. Omit if false.
  "nudgeItemId": "...",              // ID of a pending agenda item worth raising now, or omit if none is appropriate.
  "nudgeRationale": "...",           // Why now is a good time to raise that item. Omit if no nudge.
  "memoryCandidate": "...",          // A fact worth preserving from this exchange (one sentence), or omit if nothing durable.
  "selfPattern": "..."               // A pattern about the AI's own performance in this session (e.g. recurring confusion, a gap), or omit if none.
}

Rules:
- Only suggest a nudge if the agenda item is genuinely relevant to this conversation or the user seems receptive.
- memoryCandidate should be something durable, not ephemeral. Omit if nothing was said worth remembering.
- selfPattern is about the AI assistant's own behaviour, not the user's. Only include if you noticed something meaningful.
- Respond ONLY with valid JSON. No markdown fences, no explanation.`;

/**
 * Lightweight 4-question reflection called ~4 min after each turn.
 * Direct LLM call — not routed through the pipeline.
 */
export class ReflectionJob {
  private readonly llmClient: ReflectionLlmClient;
  private readonly longTermStore: LongTermStore;
  private readonly logger: StructuredLogger;

  constructor(
    llmClient: ReflectionLlmClient,
    _agendaStore: AgendaStore,
    longTermStore: LongTermStore,
    logger: StructuredLogger,
    _config: ReflectConfig,
  ) {
    this.llmClient = llmClient;
    this.longTermStore = longTermStore;
    this.logger = logger;
  }

  async run(
    session: SessionState,
    recentHistory: readonly ChatMessage[],
    pendingItems: readonly AgendaItem[],
    signal?: AbortSignal,
  ): Promise<ReflectionResult> {
    if (signal?.aborted) return { taskComplete: false };
    if (recentHistory.length === 0) return { taskComplete: false };

    const conversationText = recentHistory
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const agendaSection =
      pendingItems.length > 0
        ? `\n\nPending agenda items:\n${pendingItems.map((i) => `[id:${i.id}] (${i.type}, ${i.priority}) ${i.content}`).join("\n")}`
        : "\n\nNo pending agenda items.";

    const userMessage: ChatMessage = {
      role: "user",
      content: `Recent conversation:\n${conversationText}${agendaSection}`,
    };

    let raw: ReflectionLlmOutput;
    try {
      const response = await this.llmClient.chat([
        { role: "system", content: REFLECTION_SYSTEM_PROMPT },
        userMessage,
      ]);

      if (signal?.aborted) return { taskComplete: false };

      raw = this.parseOutput(response.message.content);
    } catch (err) {
      if (signal?.aborted) return { taskComplete: false };
      this.logger.log({
        sessionId: session.id,
        eventType: "message:reflect",
        component: "reflection-job",
        payload: { action: "llm_error", error: toErrorMessage(err) },
      });
      return { taskComplete: false };
    }

    const result: ReflectionResult = {
      taskComplete: raw.taskComplete,
      completionSummary: raw.completionSummary,
      nudgeItemId: raw.nudgeItemId,
      nudgeRationale: raw.nudgeRationale,
      memoryCandidate: raw.memoryCandidate,
      selfPattern: raw.selfPattern,
    };

    // Write lightweight memory candidates — CurationWorker will consolidate later
    if (result.taskComplete && result.completionSummary) {
      try {
        await this.longTermStore.create({
          category: "fact",
          content: result.completionSummary,
          sourceSessions: [session.id],
          confidence: 0.6,
          tags: ["reflect:candidate"],
        });
      } catch (err) {
        this.logger.log({
          sessionId: session.id,
          eventType: "message:reflect",
          component: "reflection-job",
          payload: { action: "memory_write_error", error: toErrorMessage(err) },
        });
      }
    }

    if (result.selfPattern) {
      try {
        await this.longTermStore.create({
          category: "self",
          content: result.selfPattern,
          sourceSessions: [session.id],
          confidence: 0.7,
          tags: ["agent:self"],
        });
      } catch (err) {
        this.logger.log({
          sessionId: session.id,
          eventType: "message:reflect",
          component: "reflection-job",
          payload: { action: "self_memory_write_error", error: toErrorMessage(err) },
        });
      }
    }

    this.logger.log({
      sessionId: session.id,
      eventType: "message:reflect",
      component: "reflection-job",
      payload: {
        action: "reflect_complete",
        taskComplete: result.taskComplete,
        hasNudge: !!result.nudgeItemId,
        hasMemoryCandidate: !!result.memoryCandidate,
        hasSelfPattern: !!result.selfPattern,
      },
    });

    return result;
  }

  private parseOutput(content: string): ReflectionLlmOutput {
    const trimmed = content.trim();
    // Strip markdown fences if the model wrapped it anyway
    const json = trimmed.startsWith("```") ? trimmed.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "") : trimmed;
    try {
      return JSON.parse(json) as ReflectionLlmOutput;
    } catch {
      return { taskComplete: false };
    }
  }
}
