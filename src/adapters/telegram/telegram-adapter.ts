import {
  createErrorClass,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage } from "../../types.js";
import type { StructuredLogger } from "../../logger/structured-logger.js";

export const TelegramError = createErrorClass("TelegramError", "telegram", "TELEGRAM_ERROR");

// ── Telegram API types (minimal subset) ──────────────────────────────────────

interface TelegramUser {
  readonly id: number;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string;
}

interface TelegramChat {
  readonly id: number;
  readonly type: "private" | "group" | "supergroup" | "channel";
}

interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly chat: TelegramChat;
  readonly date: number;
  readonly text?: string;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
}

/** Maximum inbound message length in characters. Messages exceeding this are truncated. */
const MAX_MESSAGE_LENGTH = 32_768;

// ── Adapter ──────────────────────────────────────────────────────────────────

export interface TelegramAdapterOptions {
  readonly token: string;
  readonly pollingIntervalMs?: number;
  readonly pollingTimeoutSecs?: number;
  readonly logger: StructuredLogger;
  /** Override fetch for testing. */
  readonly fetchFn?: typeof fetch;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram";
  readonly name = "Telegram";

  private readonly token: string;
  private readonly pollingIntervalMs: number;
  private readonly pollingTimeoutSecs: number;
  private readonly logger: StructuredLogger;
  private readonly fetchFn: typeof fetch;

  private callback: ((msg: InboundMessage) => void) | null = null;
  private running = false;
  private lastUpdateId = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TelegramAdapterOptions) {
    if (!options.token || options.token.length === 0) {
      throw new TelegramError("Telegram token is required", "MISSING_TOKEN");
    }
    this.token = options.token;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 1000;
    this.pollingTimeoutSecs = options.pollingTimeoutSecs ?? 30;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "telegram",
      payload: { action: "start", pollingIntervalMs: this.pollingIntervalMs },
    });
    this.schedulePoll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "telegram",
      payload: { action: "stop" },
    });
  }

  onMessage(callback: (msg: InboundMessage) => void): void {
    this.callback = callback;
  }

  async send(channelId: string, message: OutboundMessage): Promise<void> {
    await this.callApi("sendMessage", {
      chat_id: channelId,
      text: message.text,
    });
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, this.pollingIntervalMs);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const updates = await this.getUpdates();
      for (const update of updates) {
        this.processUpdate(update);
      }
    } catch (err) {
      this.logger.log({
        sessionId: null,
        eventType: "message:inbound",
        component: "telegram",
        payload: {
          error: err instanceof Error ? err.message : String(err),
          action: "poll_error",
        },
      });
    }

    this.schedulePoll();
  }

  private async getUpdates(): Promise<readonly TelegramUpdate[]> {
    const params: Record<string, unknown> = {
      timeout: this.pollingTimeoutSecs,
      allowed_updates: ["message"],
    };

    if (this.lastUpdateId > 0) {
      params["offset"] = this.lastUpdateId + 1;
    }

    const response = await this.callApi<readonly TelegramUpdate[]>(
      "getUpdates",
      params,
    );

    return response ?? [];
  }

  private processUpdate(update: TelegramUpdate): void {
    if (update.update_id >= this.lastUpdateId) {
      this.lastUpdateId = update.update_id;
    }

    if (!update.message?.text) return;

    const msg = update.message;
    const rawText = msg.text as string;
    const text = rawText.length > MAX_MESSAGE_LENGTH
      ? rawText.slice(0, MAX_MESSAGE_LENGTH)
      : rawText;
    const senderId = msg.from
      ? String(msg.from.id)
      : "unknown";
    const senderName = msg.from
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ")
      : "unknown";

    const inbound: InboundMessage = {
      id: String(msg.message_id),
      adapterId: "telegram",
      channelId: String(msg.chat.id),
      senderId,
      text,
      timestamp: msg.date * 1000,
      raw: update,
    };

    this.logger.log({
      sessionId: null,
      eventType: "message:inbound",
      component: "telegram",
      payload: {
        messageId: msg.message_id,
        chatId: msg.chat.id,
        senderId,
        senderName,
        textLength: text.length,
      },
    });

    this.callback?.(inbound);
  }

  // ── API helpers ──────────────────────────────────────────────────────────

  private async callApi<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T | undefined> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
    } catch (err) {
      throw new TelegramError(
        `Network error calling ${method}: ${err instanceof Error ? err.message : String(err)}`,
        "NETWORK_ERROR",
      );
    }

    let body: TelegramApiResponse<T>;
    try {
      body = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      throw new TelegramError(
        `Invalid JSON response from ${method} (status ${response.status})`,
        "INVALID_RESPONSE",
      );
    }

    if (!body.ok) {
      throw new TelegramError(
        `Telegram API error: ${body.description ?? "unknown"} (code ${body.error_code ?? response.status})`,
        "API_ERROR",
      );
    }

    return body.result;
  }
}
