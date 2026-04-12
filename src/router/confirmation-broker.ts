import type {
  ChannelAdapter,
  ConfirmationResult,
  ConfirmationVerdict,
  ToolCall,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";

interface PendingConfirmation {
  readonly toolName: string;
  readonly toolCall: ToolCall;
  readonly resolve: (result: ConfirmationResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly createdAt: number;
}

function parseReply(text: string): ConfirmationVerdict {
  const normalised = text.trim().toLowerCase();
  if (normalised === "yes" || normalised === "y") return "allow";
  if (normalised === "yes always" || normalised === "always") return "allow-session";
  return "deny";
}

function formatPrompt(toolName: string, toolCall: ToolCall): string {
  let paramSummary: string;
  try {
    const params = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    paramSummary = Object.entries(params)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join("\n");
  } catch {
    paramSummary = `  ${toolCall.function.arguments}`;
  }
  return [
    `⚠ Tool "${toolName}" requires confirmation.`,
    "",
    "Parameters:",
    paramSummary,
    "",
    "Reply YES to allow once, YES ALWAYS to allow for this session, or NO to deny.",
  ].join("\n");
}

export class ConfirmationBroker {
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly logger: StructuredLogger;
  private readonly timeoutMs: number;

  constructor(logger: StructuredLogger, timeoutMs = 120_000) {
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  async requestAndWait(
    adapter: ChannelAdapter,
    channelId: string,
    senderId: string,
    adapterId: string,
    toolName: string,
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ConfirmationResult> {
    const key = `${adapterId}:${channelId}:${senderId}`;

    const prompt = formatPrompt(toolName, toolCall);
    await adapter.send(channelId, { channelId, text: prompt });

    this.logger.log({
      sessionId: null,
      eventType: "confirmation:request",
      component: "confirmation",
      payload: { tool: toolName, key },
    });

    return new Promise<ConfirmationResult>((resolve) => {
      const settle = (result: ConfirmationResult): void => {
        clearTimeout(timer);
        this.pending.delete(key);
        if (signal) signal.removeEventListener("abort", onAbort);

        this.logger.log({
          sessionId: null,
          eventType: "confirmation:result",
          component: "confirmation",
          payload: {
            tool: toolName,
            key,
            verdict: result.verdict,
            reason: result.reason,
            durationMs: Date.now() - createdAt,
          },
        });

        resolve(result);
      };

      const createdAt = Date.now();

      const timer = setTimeout(() => {
        settle({ verdict: "deny", reason: "timeout" });
      }, this.timeoutMs);

      const onAbort = (): void => {
        settle({ verdict: "deny", reason: "aborted" });
      };

      if (signal) {
        if (signal.aborted) {
          settle({ verdict: "deny", reason: "aborted" });
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(key, {
        toolName,
        toolCall,
        resolve: settle,
        timer,
        createdAt,
      });
    });
  }

  resolve(key: string, messageText: string): boolean {
    const entry = this.pending.get(key);
    if (!entry) return false;

    const verdict = parseReply(messageText);
    const reason = verdict === "deny" ? "user denied" : "user approved";
    entry.resolve({ verdict, reason });
    return true;
  }

  hasPending(key: string): boolean {
    return this.pending.has(key);
  }

  cancelAll(filterFn?: (key: string) => boolean): void {
    for (const [key, entry] of this.pending) {
      if (!filterFn || filterFn(key)) {
        entry.resolve({ verdict: "deny", reason: "cancelled" });
      }
    }
  }
}
