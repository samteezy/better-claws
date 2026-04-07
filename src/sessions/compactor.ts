import {
  BetterClawsError,
  type ChatMessage,
  type CompactionConfig,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import type { LlmClient } from "../llm/llm-client.js";
import type { SessionManager } from "./session-manager.js";

export class CompactionError extends BetterClawsError {
  constructor(message: string, code: string = "COMPACTION_ERROR") {
    super(message, "compactor", code);
    this.name = "CompactionError";
  }
}

export interface SessionCompactorOptions {
  readonly sessionManager: SessionManager;
  readonly llmClient: LlmClient;
  readonly weakLlmClient?: LlmClient;
  readonly compactionConfig: CompactionConfig;
  readonly logger: StructuredLogger;
}

export interface CompactionResult {
  readonly compressedTurnCount: number;
  readonly summaryLength: number;
}

const SUMMARISATION_SYSTEM_PROMPT = `You are a conversation archivist. Write a compact, factual summary of the conversation segment below.
The summary will replace the original messages in the assistant's context window.

Rules:
- Preserve every decision, fact, file path, code change, tool result, and user preference.
- Write in past tense ("The user asked...", "The assistant ran...").
- Include tool calls and their outcomes.
- Do not editorialize. Capture everything needed to continue the conversation coherently.
- One dense paragraph per ~10 turns.`;

const CHARS_PER_TOKEN = 4;

export class SessionCompactor {
  private readonly sessionManager: SessionManager;
  private readonly llmClient: LlmClient;
  private readonly weakLlmClient: LlmClient;
  private readonly config: CompactionConfig;
  private readonly logger: StructuredLogger;

  constructor(options: SessionCompactorOptions) {
    this.sessionManager = options.sessionManager;
    this.llmClient = options.llmClient;
    this.weakLlmClient = options.weakLlmClient ?? options.llmClient;
    this.config = options.compactionConfig;
    this.logger = options.logger;
  }

  async compact(sessionId: string): Promise<CompactionResult> {
    const history = await this.sessionManager.getHistory(sessionId);

    if (history.length < 2) {
      // Nothing worth summarising
      return { compressedTurnCount: 0, summaryLength: 0 };
    }

    // Split history: keep the most recent messages that fit in keepRecentTokens,
    // summarise everything older.
    const keepCharBudget = this.config.keepRecentTokens * CHARS_PER_TOKEN;
    let keptChars = 0;
    let keepFromIdx = history.length; // exclusive lower bound from the right

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]!;
      const msgChars = msg.content.length;
      if (keptChars + msgChars > keepCharBudget) break;
      keptChars += msgChars;
      keepFromIdx = i;
    }

    const toSummarise = history.slice(0, keepFromIdx);

    if (toSummarise.length < 2) {
      // All history fits in the keep window — nothing to compact
      return { compressedTurnCount: 0, summaryLength: 0 };
    }

    const conversationText = this.serialiseMessages(toSummarise);

    const summarisationMessages: ChatMessage[] = [
      { role: "system", content: SUMMARISATION_SYSTEM_PROMPT },
      { role: "user", content: conversationText },
    ];

    let summary: string;
    try {
      const response = await this.weakLlmClient.chat(summarisationMessages);
      summary = response.message.content.trim();
    } catch (err) {
      throw new CompactionError(
        `Summarisation LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        "SUMMARISATION_FAILED",
      );
    }

    if (!summary) {
      throw new CompactionError(
        "Summarisation returned empty content",
        "EMPTY_SUMMARY",
      );
    }

    await this.sessionManager.appendToLog(sessionId, {
      type: "compaction",
      summary,
      compressedTurnCount: toSummarise.length,
      createdAt: Date.now(),
    });

    this.logger.log({
      sessionId,
      eventType: "session:compaction",
      component: "compactor",
      payload: {
        success: true,
        compressedTurnCount: toSummarise.length,
        summaryLength: summary.length,
        weakModel: this.weakLlmClient !== this.llmClient,
      },
    });

    return { compressedTurnCount: toSummarise.length, summaryLength: summary.length };
  }

  private serialiseMessages(messages: readonly ChatMessage[]): string {
    return messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");
  }
}
