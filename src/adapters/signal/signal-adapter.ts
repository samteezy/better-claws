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

interface SignalSyncMessage {
  readonly sentMessage?: SignalDataMessage;
}

interface SignalEnvelope {
  readonly source: string;
  readonly sourceNumber?: string;
  readonly sourceName?: string;
  readonly dataMessage?: SignalDataMessage;
  readonly syncMessage?: SignalSyncMessage;
  readonly timestamp?: number;
}

// Both HTTP and WebSocket responses share the envelope shape; account is optional.
interface SignalMessage {
  readonly envelope: SignalEnvelope;
  readonly account?: string;
}

function isSignalMessage(data: unknown): data is SignalMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "envelope" in data &&
    typeof (data as Record<string, unknown>)["envelope"] === "object" &&
    (data as Record<string, unknown>)["envelope"] !== null
  );
}

// ── Adapter ────────────────────────────────────────────────────────────────

export interface SignalAdapterOptions {
  readonly apiUrl: string;
  readonly number: string;
  /**
   * "http"      — long-poll via GET /v1/receive (default; works in normal mode)
   * "websocket" — persistent WebSocket stream (requires JSON-RPC mode)
   */
  readonly mode?: "http" | "websocket";
  /** HTTP mode: interval between polls. WebSocket mode: base reconnect delay. Default: 3000. */
  readonly pollingIntervalMs?: number;
  /** HTTP mode: server-side long-poll timeout in seconds. Default: 10. */
  readonly pollingTimeoutSecs?: number;
  readonly logger: StructuredLogger;
  /** Override fetch for testing. */
  readonly fetchFn?: typeof fetch;
  /** Override WebSocket constructor for testing (websocket mode only). */
  readonly wsFactory?: (url: string) => WebSocket;
}

const GROUP_PREFIX = "group:";
const MAX_RECONNECT_DELAY_MS = 60_000;
const SEND_TIMEOUT_MS = 30_000;

export class SignalAdapter implements ChannelAdapter {
  readonly id = "signal";
  readonly name = "Signal";

  private readonly apiUrl: string;
  private readonly number: string;
  private readonly mode: "http" | "websocket";
  private readonly pollingIntervalMs: number;
  private readonly pollingTimeoutSecs: number;
  private readonly logger: StructuredLogger;
  private readonly fetchFn: typeof fetch;
  private readonly wsFactory: (url: string) => WebSocket;

  private callback: ((msg: InboundMessage) => void) | null = null;
  private running = false;
  private pollCount = 0;

  // HTTP polling state
  private pollTimer: NodeJS.Timeout | null = null;

  // WebSocket state
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay: number;

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
    this.wsUrl = this.apiUrl.replace(/^http/, "ws");
    this.number = options.number;
    this.mode = options.mode ?? "http";
    this.pollingIntervalMs = options.pollingIntervalMs ?? 3000;
    this.pollingTimeoutSecs = options.pollingTimeoutSecs ?? 10;
    this.reconnectDelay = this.pollingIntervalMs;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.wsFactory = options.wsFactory ?? ((url: string) => new WebSocket(url));
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "signal",
      payload: { action: "start", mode: this.mode },
    });
    if (this.mode === "websocket") {
      this.connect();
    } else {
      this.schedulePoll();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    // HTTP mode cleanup
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    // WebSocket mode cleanup
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
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
    const recipient = isGroup
      ? `group.${channelId.slice(GROUP_PREFIX.length)}`
      : channelId;

    await this.callApi("POST", `/v2/send`, {
      number: this.number,
      recipients: [recipient],
      message: message.text,
    });
  }

  // ── HTTP polling ──────────────────────────────────────────────────────────

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, this.pollingIntervalMs);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    this.pollCount++;
    if (this.pollCount % 20 === 0) {
      this.logger.log({
        sessionId: null,
        eventType: "config:change",
        component: "signal",
        payload: { action: "poll_heartbeat", pollCount: this.pollCount },
      });
    }

    try {
      const items = await this.receiveMessages();
      for (const item of items) {
        this.processMessage(item);
      }
    } catch (err) {
      this.logger.log({
        sessionId: null,
        eventType: "message:inbound",
        component: "signal",
        payload: { error: toErrorMessage(err), action: "poll_error" },
      });
    }

    this.schedulePoll();
  }

  private async receiveMessages(): Promise<readonly SignalMessage[]> {
    const encodedNumber = encodeURIComponent(this.number);
    const path = `/v1/receive/${encodedNumber}?timeout=${this.pollingTimeoutSecs}`;
    const url = `${this.apiUrl}${path}`;
    // 2× server timeout gives enough buffer for signal-cli processing overhead.
    const abortMs = this.pollingTimeoutSecs * 2 * 1000;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "GET",
        signal: AbortSignal.timeout(abortMs),
      });
    } catch (err) {
      throw new SignalError(
        `Network error calling GET ${path}: ${toErrorMessage(err)}`,
        "NETWORK_ERROR",
      );
    }

    if (response.status === 204) return [];

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      return [];
    }

    if (!Array.isArray(result)) return [];
    return result as SignalMessage[];
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private connect(): void {
    if (!this.running) return;

    const encodedNumber = encodeURIComponent(this.number);
    const url = `${this.wsUrl}/v1/receive/${encodedNumber}`;
    const ws = this.wsFactory(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = this.pollingIntervalMs;
      this.logger.log({
        sessionId: null,
        eventType: "config:change",
        component: "signal",
        payload: { action: "ws_connected" },
      });
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let data: unknown;
      try {
        data = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      if (isSignalMessage(data)) {
        this.processMessage(data);
      }
    };

    ws.onerror = () => {
      this.logger.log({
        sessionId: null,
        eventType: "message:inbound",
        component: "signal",
        payload: { action: "ws_error" },
      });
    };

    ws.onclose = () => {
      this.ws = null;
      if (!this.running) return;
      this.logger.log({
        sessionId: null,
        eventType: "message:inbound",
        component: "signal",
        payload: { action: "ws_closed", reconnectDelayMs: this.reconnectDelay },
      });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ── Shared message processing ─────────────────────────────────────────────

  private processMessage(item: SignalMessage): void {
    const { envelope } = item;
    // Regular inbound messages use dataMessage; messages sent from the registered
    // device are delivered back as syncMessage.sentMessage.
    const data = envelope.dataMessage ?? envelope.syncMessage?.sentMessage;

    if (!data?.message) return;

    const isGroup = data.groupInfo?.groupId != null;
    if (!isGroup && envelope.source === this.number) return;
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

    let response: Response;
    try {
      const options: RequestInit = {
        method,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
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
