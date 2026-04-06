import {
  BetterClawsError,
  type ChatMessage,
  type LlmResponse,
  type LlmStreamChunk,
  type ToolDescriptor,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import type { SecretManager } from "../secrets/secret-manager.js";

export class LlmError extends BetterClawsError {
  constructor(
    message: string,
    code: string = "LLM_ERROR",
    readonly statusCode?: number,
    readonly responseBody?: string,
  ) {
    super(message, "llm", code);
    this.name = "LlmError";
  }
}

export interface LlmClientOptions {
  readonly baseUrl: string;
  readonly secretManager: SecretManager;
  readonly secretKey?: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly logger: StructuredLogger;
}

interface OpenAIToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

interface OpenAIChoice {
  readonly message?: {
    readonly role?: string;
    readonly content?: string | null;
    readonly tool_calls?: readonly {
      readonly id: string;
      readonly type: "function";
      readonly function: { readonly name: string; readonly arguments: string };
    }[];
  };
  readonly delta?: {
    readonly role?: string;
    readonly content?: string | null;
    readonly tool_calls?: readonly {
      readonly index: number;
      readonly id?: string;
      readonly type?: "function";
      readonly function?: { readonly name?: string; readonly arguments?: string };
    }[];
  };
  readonly finish_reason?: string | null;
}

interface OpenAIResponse {
  readonly choices?: readonly OpenAIChoice[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class LlmClient {
  private readonly baseUrl: string;
  private readonly secretManager: SecretManager;
  private readonly secretKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly logger: StructuredLogger;

  constructor(options: LlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.secretManager = options.secretManager;
    this.secretKey = options.secretKey ?? "llm:apiKey";
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.temperature = options.temperature;
    this.logger = options.logger;
  }

  async chat(
    messages: readonly ChatMessage[],
    tools?: readonly ToolDescriptor[],
  ): Promise<LlmResponse> {
    const body = this.buildRequestBody(messages, tools, false);

    this.logger.log({
      sessionId: null,
      eventType: "llm:request",
      component: "llm",
      payload: { model: this.model, messageCount: messages.length },
    });

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      },
    );

    const raw = (await response.json()) as OpenAIResponse;
    const choice = raw.choices?.[0];

    if (!choice?.message) {
      throw new LlmError("No choice returned from LLM", "EMPTY_RESPONSE");
    }

    const message: ChatMessage = {
      role: (choice.message.role as ChatMessage["role"]) ?? "assistant",
      content: choice.message.content ?? "",
      ...(choice.message.tool_calls?.length
        ? { tool_calls: choice.message.tool_calls }
        : {}),
    };

    const result: LlmResponse = {
      message,
      usage: {
        promptTokens: raw.usage?.prompt_tokens ?? 0,
        completionTokens: raw.usage?.completion_tokens ?? 0,
      },
      raw,
    };

    this.logger.log({
      sessionId: null,
      eventType: "llm:response",
      component: "llm",
      payload: {
        role: message.role,
        contentLength: message.content.length,
        toolCalls: message.tool_calls?.length ?? 0,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      },
    });

    return result;
  }

  async *chatStream(
    messages: readonly ChatMessage[],
    tools?: readonly ToolDescriptor[],
  ): AsyncGenerator<LlmStreamChunk> {
    const body = this.buildRequestBody(messages, tools, true);

    this.logger.log({
      sessionId: null,
      eventType: "llm:request",
      component: "llm",
      payload: {
        model: this.model,
        messageCount: messages.length,
        stream: true,
      },
    });

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      },
    );

    if (!response.body) {
      throw new LlmError("No response body for stream", "STREAM_ERROR");
    }

    yield* parseSSEStream(response.body);
  }

  private buildRequestBody(
    messages: readonly ChatMessage[],
    tools: readonly ToolDescriptor[] | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.tool_calls) msg["tool_calls"] = m.tool_calls;
        if (m.tool_call_id) msg["tool_call_id"] = m.tool_call_id;
        return msg;
      }),
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream,
    };

    if (tools && tools.length > 0) {
      body["tools"] = tools.map(
        (t): OpenAIToolSchema => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters as Record<string, unknown>,
          },
        }),
      );
    }

    return body;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.secretManager.has(this.secretKey)) {
      headers["Authorization"] = `Bearer ${this.secretManager.get(this.secretKey)}`;
    }
    return headers;
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    attempt: number = 0,
  ): Promise<Response> {
    const response = await fetch(url, options);

    if (response.ok) return response;

    if (
      RETRYABLE_STATUS_CODES.has(response.status) &&
      attempt < MAX_RETRIES - 1
    ) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.fetchWithRetry(url, options, attempt + 1);
    }

    const body = await response.text().catch(() => "");
    throw new LlmError(
      `LLM request failed with status ${response.status}: ${body.slice(0, 500)}`,
      "HTTP_ERROR",
      response.status,
      body,
    );
  }
}

// ── SSE Parser ────────────────────────────────────────────────────────────────

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<LlmStreamChunk> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of streamToAsyncIterable(body)) {
    buffer += decoder.decode(chunk, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const lines = part.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          yield { delta: "", done: true };
          return;
        }

        let parsed: OpenAIResponse;
        try {
          parsed = JSON.parse(data) as OpenAIResponse;
        } catch {
          continue;
        }

        const choice = parsed.choices?.[0];
        if (!choice?.delta) continue;

        const toolCallDelta = choice.delta.tool_calls?.[0];
        yield {
          delta: choice.delta.content ?? "",
          ...(toolCallDelta
            ? {
                toolCallDelta: {
                  id: toolCallDelta.id,
                  type: toolCallDelta.type,
                  function: toolCallDelta.function
                    ? {
                        name: toolCallDelta.function.name ?? "",
                        arguments: toolCallDelta.function.arguments ?? "",
                      }
                    : undefined,
                },
              }
            : {}),
          done: choice.finish_reason !== null && choice.finish_reason !== undefined,
        };
      }
    }
  }
}

async function* streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
