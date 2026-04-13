import {
  createErrorClass,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage } from "../../types.js";
import type { StructuredLogger } from "../../logger/structured-logger.js";
import { toErrorMessage } from "../../utils/errors.js";

export const SignalError = createErrorClass("SignalError", "signal", "SIGNAL_ERROR");

// ── Signal CLI REST API types (minimal subset) ─────────────────────────────

interface SignalGroupInfo {
  readonly groupId: string;
  readonly type?: string;
}

interface SignalDataMessage {
  readonly message: string | null;
  readonly timestamp: number;
  readonly groupInfo?: SignalGroupInfo;
}

interface SignalEnvelope {
  readonly source: string;
  readonly sourceNumber?: string;
  readonly sourceName?: string;
  readonly dataMessage?: SignalDataMessage;
  readonly timestamp?: number;
}

interface SignalReceiveItem {
  readonly envelope: SignalEnvelope;
  readonly account: string;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export interface SignalAdapterOptions {
  readonly apiUrl: string;
  readonly number: string;
  readonly pollingIntervalMs?: number;
  readonly pollingTimeoutSecs?: number;
  readonly logger: StructuredLogger;
  /** Override fetch for testing. */
  readonly fetchFn?: typeof fetch;
}

const GROUP_PREFIX = "group:";

export class SignalAdapter implements ChannelAdapter {
  readonly id = "signal";
  readonly name = "Signal";

  private readonly apiUrl: string;
  private readonly number: string;
  private readonly pollingIntervalMs: number;
  private readonly pollingTimeoutSecs: number;
  private readonly logger: StructuredLogger;
  private readonly fetchFn: typeof fetch;

  private callback: ((msg: InboundMessage) => void) | null = null;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SignalAdapterOptions) {
    if (!options.apiUrl || options.apiUrl.length === 0) {
      throw new SignalError("Signal API URL is required", "MISSING_CONFIG");
    }
    if (!options.number || options.number.length === 0) {
      throw new SignalError(
        "Signal phone number is required",
        "MISSING_CONFIG",
      );
    }
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.number = options.number;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 3000;
    this.pollingTimeoutSecs = options.pollingTimeoutSecs ?? 10;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "signal",
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
      component: "signal",
      payload: { action: "stop" },
    });
  }

  onMessage(callback: (msg: InboundMessage) => void): void {
    this.callback = callback;
  }

  async send(channelId: string, message: OutboundMessage): Promise<void> {
    const isGroup = channelId.startsWith(GROUP_PREFIX);
    const recipientId = isGroup
      ? channelId.slice(GROUP_PREFIX.length)
      : channelId;

    await this.callApi("POST", `/v2/send`, {
      number: this.number,
      recipients: [recipientId],
      message: message.text,
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
      const items = await this.receiveMessages();
      for (const item of items) {
        this.processEnvelope(item);
      }
    } catch (err) {
      this.logger.log({
        sessionId: null,
        eventType: "message:inbound",
        component: "signal",
        payload: {
          error: toErrorMessage(err),
          action: "poll_error",
        },
      });
    }

    this.schedulePoll();
  }

  private async receiveMessages(): Promise<readonly SignalReceiveItem[]> {
    const encodedNumber = encodeURIComponent(this.number);
    const path = `/v1/receive/${encodedNumber}?timeout=${this.pollingTimeoutSecs}`;

    const result = await this.callApi<readonly SignalReceiveItem[]>(
      "GET",
      path,
    );

    return result ?? [];
  }

  private processEnvelope(item: SignalReceiveItem): void {
    const { envelope } = item;
    const data = envelope.dataMessage;

    if (!data?.message) return;
    if (envelope.source === this.number) return;

    const isGroup = data.groupInfo?.groupId != null;
    const channelId = isGroup
      ? `${GROUP_PREFIX}${data.groupInfo!.groupId}`
      : envelope.source;

    const inbound: InboundMessage = {
      id: String(data.timestamp),
      adapterId: "signal",
      channelId,
      senderId: envelope.source,
      text: data.message,
      timestamp: data.timestamp,
      raw: item,
    };

    this.logger.log({
      sessionId: null,
      eventType: "message:inbound",
      component: "signal",
      payload: {
        messageId: data.timestamp,
        channelId,
        senderId: envelope.source,
        senderName: envelope.sourceName ?? "unknown",
        textLength: data.message.length,
      },
    });

    this.callback?.(inbound);
  }

  // ── API helpers ──────────────────────────────────────────────────────────

  private async callApi<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T | undefined> {
    const url = `${this.apiUrl}${path}`;
    const timeoutMs = this.pollingTimeoutSecs * 1000 + 5000;

    let response: Response;
    try {
      const options: RequestInit = {
        method,
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (body) {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify(body);
      }
      response = await this.fetchFn(url, options);
    } catch (err) {
      throw new SignalError(
        `Network error calling ${method} ${path}: ${toErrorMessage(err)}`,
        "NETWORK_ERROR",
      );
    }

    if (response.status === 204) return undefined;

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new SignalError(
        `Invalid JSON response from ${method} ${path} (status ${response.status})`,
        "INVALID_RESPONSE",
      );
    }

    if (!response.ok) {
      const detail =
        typeof result === "object" && result !== null && "error" in result
          ? String((result as Record<string, unknown>)["error"])
          : `status ${response.status}`;
      throw new SignalError(
        `Signal API error: ${detail}`,
        "API_ERROR",
      );
    }

    return result as T;
  }
}
