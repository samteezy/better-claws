import {
  BetterClawsError,
  type ChatMessage,
  type ToolDescriptor,
} from "../types.js";
import {
  sanitizeMemoryContent,
  wrapMemoryBlock,
} from "../utils/prompt-sanitizer.js";

export class PromptBuilderError extends BetterClawsError {
  constructor(message: string, code: string = "PROMPT_BUILDER_ERROR") {
    super(message, "prompt", code);
    this.name = "PromptBuilderError";
  }
}

export interface PromptBuilderOptions {
  /** Base system prompt text. */
  readonly systemPrompt: string;
  /** Maximum estimated token budget for the full message array. */
  readonly tokenBudget: number;
  /** Approximate characters per token for estimation. Default: 4. */
  readonly charsPerToken?: number;
  /** AI persona / personality text from config (sanitized once at construction). */
  readonly persona?: string;
  /** Static user context from config (sanitized once at construction). */
  readonly userContext?: string;
}

export interface BuildInput {
  /** Conversation history (oldest first). */
  readonly history: readonly ChatMessage[];
  /** Available tool descriptors to declare in the system prompt. */
  readonly tools: readonly ToolDescriptor[];
  /** Current date/time string to inject (caller provides, keeps builder pure). */
  readonly currentDateTime?: string;
  /** Adapter-specific prompt augmentation text (cached after first sanitization). */
  readonly adapterPrompt?: string;
  /** Optional working memory text to inject (placeholder for issue #4). */
  readonly workingMemory?: string;
  /** Optional retrieved long-term memories (placeholder for issue #5). */
  readonly longTermMemories?: readonly string[];
}

export interface BuildResult {
  /** The assembled message array ready to send to the LLM. */
  readonly messages: ChatMessage[];
  /** Estimated token count of the assembled messages. */
  readonly estimatedTokens: number;
  /** Number of history messages that were truncated. */
  readonly truncatedCount: number;
}

export class PromptBuilder {
  private readonly systemPrompt: string;
  private readonly tokenBudget: number;
  private readonly charsPerToken: number;
  private readonly sanitizedPersona: string | undefined;
  private readonly sanitizedUserContext: string | undefined;
  private readonly adapterPromptCache = new Map<string, string>();

  get budget(): number {
    return this.tokenBudget;
  }

  constructor(options: PromptBuilderOptions) {
    this.systemPrompt = options.systemPrompt;
    this.tokenBudget = options.tokenBudget;
    this.charsPerToken = options.charsPerToken ?? 4;
    this.sanitizedPersona = options.persona
      ? sanitizeMemoryContent(options.persona, 2000)
      : undefined;
    this.sanitizedUserContext = options.userContext
      ? sanitizeMemoryContent(options.userContext, 2000)
      : undefined;
  }

  build(input: BuildInput): BuildResult {
    const systemContent = this.assembleSystemContent(input);
    const systemMessage: ChatMessage = {
      role: "system",
      content: systemContent,
    };

    const systemTokens = this.estimateTokens(systemContent);

    // If the system prompt alone exceeds the budget, return just the system message
    if (systemTokens >= this.tokenBudget) {
      return {
        messages: [systemMessage],
        estimatedTokens: systemTokens,
        truncatedCount: input.history.length,
      };
    }

    const remainingBudget = this.tokenBudget - systemTokens;
    const { messages: historyMessages, truncatedCount } =
      this.fitHistory(input.history, remainingBudget);

    const messages: ChatMessage[] = [systemMessage, ...historyMessages];
    const estimatedTokens = this.estimateMessageArrayTokens(messages);

    return { messages, estimatedTokens, truncatedCount };
  }

  /** Estimate tokens for a string. */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / this.charsPerToken);
  }

  private getCachedAdapterPrompt(raw: string): string {
    let cached = this.adapterPromptCache.get(raw);
    if (cached === undefined) {
      cached = sanitizeMemoryContent(raw, 1000);
      this.adapterPromptCache.set(raw, cached);
    }
    return cached;
  }

  private assembleSystemContent(input: BuildInput): string {
    const parts: string[] = [this.systemPrompt];

    if (this.sanitizedPersona) {
      parts.push(`\n## Persona\n${this.sanitizedPersona}`);
    }

    if (this.sanitizedUserContext) {
      parts.push(`\n## User Context\n${this.sanitizedUserContext}`);
    }

    if (input.currentDateTime) {
      parts.push(`\n## Current Date and Time\n${input.currentDateTime}`);
    }

    if (input.adapterPrompt) {
      parts.push(`\n## Channel Instructions\n${this.getCachedAdapterPrompt(input.adapterPrompt)}`);
    }

    // Inject working memory if present, sanitized against prompt injection
    if (input.workingMemory) {
      const sanitized = sanitizeMemoryContent(input.workingMemory);
      parts.push(`\n${wrapMemoryBlock("WorkingMemory", sanitized)}`);
    }

    // Inject long-term memories if present, sanitized against prompt injection
    if (input.longTermMemories && input.longTermMemories.length > 0) {
      const sanitizedMemories = input.longTermMemories
        .map((m) => sanitizeMemoryContent(m, 500))
        .map((m) => `- ${m}`)
        .join("\n");
      parts.push(`\n${wrapMemoryBlock("RelevantMemories", sanitizedMemories)}`);
    }

    // Inject tool declarations
    if (input.tools.length > 0) {
      const toolSection = this.formatToolDeclarations(input.tools);
      parts.push(`\n## Available Tools\n\n${toolSection}`);
    }

    return parts.join("\n");
  }

  private formatToolDeclarations(tools: readonly ToolDescriptor[]): string {
    return tools
      .map((tool) => {
        const params = JSON.stringify(tool.parameters);
        return `### ${tool.name}\n${tool.description}\nParameters: ${params}`;
      })
      .join("\n\n");
  }

  /**
   * Fit history messages into the remaining token budget.
   * When truncation is needed, preserves the first message and the most recent
   * messages, removing from the middle. This keeps the conversation opening
   * and the latest context intact.
   */
  private fitHistory(
    history: readonly ChatMessage[],
    budget: number,
  ): { messages: ChatMessage[]; truncatedCount: number } {
    if (history.length === 0) {
      return { messages: [], truncatedCount: 0 };
    }

    const totalTokens = this.estimateMessageArrayTokens(history);
    if (totalTokens <= budget) {
      return { messages: [...history], truncatedCount: 0 };
    }

    // Strategy: keep the first message + as many recent messages as fit
    const first = history[0];
    if (!first) {
      return { messages: [], truncatedCount: 0 };
    }

    const firstTokens = this.estimateMessageTokens(first);
    if (firstTokens >= budget) {
      // Even the first message doesn't fit — return empty
      return { messages: [], truncatedCount: history.length };
    }

    let remaining = budget - firstTokens;
    const tail: ChatMessage[] = [];

    // Walk backwards from the end, adding messages while they fit
    for (let i = history.length - 1; i >= 1; i--) {
      const msg = history[i]!;
      const msgTokens = this.estimateMessageTokens(msg);
      if (msgTokens > remaining) break;
      remaining -= msgTokens;
      tail.unshift(msg);
    }

    const kept = 1 + tail.length;
    return {
      messages: [first, ...tail],
      truncatedCount: history.length - kept,
    };
  }

  private estimateMessageTokens(message: ChatMessage): number {
    // Account for role overhead (~4 tokens per message for role/formatting)
    const roleOverhead = 4;
    const contentTokens = this.estimateTokens(message.content);
    const toolCallTokens = message.tool_calls
      ? this.estimateTokens(JSON.stringify(message.tool_calls))
      : 0;
    return roleOverhead + contentTokens + toolCallTokens;
  }

  private estimateMessageArrayTokens(
    messages: readonly ChatMessage[],
  ): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateMessageTokens(msg);
    }
    return total;
  }
}
