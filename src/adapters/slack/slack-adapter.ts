import {
  BetterClawsError,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage,
} from "../../types.js";
import type { StructuredLogger } from "../../logger/structured-logger.js";

export class SlackError extends BetterClawsError {
  constructor(message: string, code: string = "SLACK_ERROR") {
    super(message, "slack", code);
    this.name = "SlackError";
  }
}

// ── Slack API types (minimal subset) ────────────────────────────────────────

interface SlackMessageEvent {
  readonly type: "message";
  readonly subtype?: string;
  readonly channel: string;
  readonly user: string;
  readonly text: string;
  readonly ts: string;
  readonly event_ts: string;
}

interface SlackSocketModePayload {
  readonly type: string;
  readonly envelope_id?: string;
  readonly payload?: {
    readonly event?: SlackMessageEvent;
    readonly event_id?: string;
  };
}

interface SlackApiResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly url?: string;
}

/** Maximum inbound message length in characters. Messages exceeding this are truncated. */
const MAX_MESSAGE_LENGTH = 32_768;

// ── Adapter ─────────────────────────────────────────────────────────────────

export interface SlackAdapterOptions {
  readonly token: string;
  readonly appToken: string;
  readonly logger: StructuredLogger;
  /** Override fetch for testing. */
  readonly fetchFn?: typeof fetch;
  /** Override WebSocket constructor for testing. */
  readonly WebSocketCtor?: typeof WebSocket;
}

interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export class SlackAdapter implements ChannelAdapter {
  readonly id = "slack";
  readonly name = "Slack";

  private readonly token: string;
  private readonly appToken: string;
  private readonly logger: StructuredLogger;
  private readonly fetchFn: typeof fetch;
  private readonly WebSocketCtor: typeof WebSocket;

  private callback: ((msg: InboundMessage) => void) | null = null;
  private ws: SocketLike | null = null;
  private running = false;
  private botUserId: string | null = null;

  constructor(options: SlackAdapterOptions) {
    if (!options.token || options.token.length === 0) {
      throw new SlackError("Slack bot token is required", "MISSING_TOKEN");
    }
    if (!options.appToken || options.appToken.length === 0) {
      throw new SlackError("Slack app-level token is required", "MISSING_APP_TOKEN");
    }
    this.token = options.token;
    this.appToken = options.appToken;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.WebSocketCtor = options.WebSocketCtor ?? WebSocket;
  }

  async start(): Promise<void> {
    this.running = true;

    // Get the bot's own user ID to filter self-messages
    await this.fetchBotUserId();

    // Open Socket Mode connection
    const wsUrl = await this.openSocketModeConnection();
    this.connectWebSocket(wsUrl);

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "slack",
      payload: { action: "start" },
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.ws) {
      this.ws.close(1000, "Shutting down");
      this.ws = null;
    }

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "slack",
      payload: { action: "stop" },
    });
  }

  onMessage(callback: (msg: InboundMessage) => void): void {
    this.callback = callback;
  }

  async send(channelId: string, message: OutboundMessage): Promise<void> {
    const url = "https://slack.com/api/chat.postMessage";

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          channel: channelId,
          text: message.text,
        }),
      });
    } catch (err) {
      throw new SlackError(
        `Network error sending message: ${err instanceof Error ? err.message : String(err)}`,
        "NETWORK_ERROR",
      );
    }

    let body: SlackApiResponse;
    try {
      body = (await response.json()) as SlackApiResponse;
    } catch {
      throw new SlackError(
        `Invalid JSON response from chat.postMessage (status ${response.status})`,
        "INVALID_RESPONSE",
      );
    }

    if (!body.ok) {
      throw new SlackError(
        `Slack API error: ${body.error ?? "unknown"}`,
        "API_ERROR",
      );
    }
  }

  // ── Socket Mode ─────────────────────────────────────────────────────────

  private async openSocketModeConnection(): Promise<string> {
    const url = "https://slack.com/api/apps.connections.open";

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${this.appToken}`,
        },
      });
    } catch (err) {
      throw new SlackError(
        `Network error opening Socket Mode connection: ${err instanceof Error ? err.message : String(err)}`,
        "NETWORK_ERROR",
      );
    }

    let body: SlackApiResponse;
    try {
      body = (await response.json()) as SlackApiResponse;
    } catch {
      throw new SlackError(
        "Invalid JSON response from apps.connections.open",
        "INVALID_RESPONSE",
      );
    }

    if (!body.ok || !body.url) {
      throw new SlackError(
        `Failed to open Socket Mode: ${body.error ?? "no URL returned"}`,
        "SOCKET_MODE_ERROR",
      );
    }

    return body.url;
  }

  private async fetchBotUserId(): Promise<void> {
    try {
      const response = await this.fetchFn("https://slack.com/api/auth.test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });
      const body = (await response.json()) as { ok: boolean; user_id?: string };
      if (body.ok && body.user_id) {
        this.botUserId = body.user_id;
      }
    } catch {
      // Non-fatal: we'll just process all messages
    }
  }

  private connectWebSocket(wsUrl: string): void {
    const ws = new this.WebSocketCtor(wsUrl) as unknown as SocketLike;
    this.ws = ws;

    ws.onmessage = (ev) => {
      this.handleSocketMessage(ev.data);
    };

    ws.onclose = (ev) => {
      this.logger.log({
        sessionId: null,
        eventType: "config:change",
        component: "slack",
        payload: { action: "socket_close", code: ev.code, reason: ev.reason },
      });

      if (this.running) {
        setTimeout(() => {
          void this.openSocketModeConnection()
            .then((url) => this.connectWebSocket(url))
            .catch((err) => {
              this.logger.log({
                sessionId: null,
                eventType: "message:inbound",
                component: "slack",
                payload: {
                  action: "reconnect_error",
                  error: err instanceof Error ? err.message : String(err),
                },
              });
            });
        }, 5000);
      }
    };

    ws.onerror = (ev) => {
      this.logger.log({
        sessionId: null,
        eventType: "message:inbound",
        component: "slack",
        payload: { action: "socket_error", error: String(ev) },
      });
    };
  }

  private handleSocketMessage(data: string): void {
    let payload: SlackSocketModePayload;
    try {
      payload = JSON.parse(data) as SlackSocketModePayload;
    } catch {
      return;
    }

    // Acknowledge envelope immediately
    if (payload.envelope_id) {
      this.ws?.send(JSON.stringify({ envelope_id: payload.envelope_id }));
    }

    if (
      payload.type === "events_api" &&
      payload.payload?.event?.type === "message"
    ) {
      this.handleMessageEvent(payload.payload.event);
    }
  }

  private handleMessageEvent(event: SlackMessageEvent): void {
    // Skip subtypes (edits, joins, bot messages, etc.)
    if (event.subtype) return;

    // Skip bot's own messages
    if (this.botUserId && event.user === this.botUserId) return;

    if (!event.text) return;

    const text = event.text.length > MAX_MESSAGE_LENGTH
      ? event.text.slice(0, MAX_MESSAGE_LENGTH)
      : event.text;

    const inbound: InboundMessage = {
      id: event.event_ts,
      adapterId: "slack",
      channelId: event.channel,
      senderId: event.user,
      text,
      timestamp: parseFloat(event.ts) * 1000,
      raw: event,
    };

    this.logger.log({
      sessionId: null,
      eventType: "message:inbound",
      component: "slack",
      payload: {
        eventTs: event.event_ts,
        channelId: event.channel,
        senderId: event.user,
        textLength: text.length,
      },
    });

    this.callback?.(inbound);
  }
}
