import {
  createErrorClass,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage } from "../../types.js";
import type { StructuredLogger } from "../../logger/structured-logger.js";
import { toErrorMessage } from "../../utils/errors.js";

export const DiscordError = createErrorClass("DiscordError", "discord", "DISCORD_ERROR");

// ── Discord API types (minimal subset) ──────────────────────────────────────

interface DiscordUser {
  readonly id: string;
  readonly username: string;
  readonly discriminator: string;
}

interface DiscordMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly author: DiscordUser;
  readonly content: string;
  readonly timestamp: string;
}

interface DiscordGatewayPayload {
  readonly op: number;
  readonly d: unknown;
  readonly s?: number | null;
  readonly t?: string | null;
}

interface DiscordReadyEvent {
  readonly session_id: string;
  readonly user: DiscordUser;
}

interface DiscordHelloEvent {
  readonly heartbeat_interval: number;
}

// Gateway opcodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_HEARTBEAT_ACK = 11;
const OP_HELLO = 10;

import { truncateMessage } from "../../utils/text.js";

// ── Adapter ─────────────────────────────────────────────────────────────────

export interface DiscordAdapterOptions {
  readonly token: string;
  readonly logger: StructuredLogger;
  /** Override fetch for testing. */
  readonly fetchFn?: typeof fetch;
  /** Override WebSocket constructor for testing. */
  readonly WebSocketCtor?: typeof WebSocket;
  /** Gateway URL override for testing. */
  readonly gatewayUrl?: string;
}

/**
 * Minimal WebSocket-like interface for the Discord gateway.
 * Allows injection of mocks in tests.
 */
interface GatewaySocket {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = "discord";
  readonly name = "Discord";

  private readonly token: string;
  private readonly logger: StructuredLogger;
  private readonly fetchFn: typeof fetch;
  private readonly WebSocketCtor: typeof WebSocket;
  private readonly gatewayUrl: string;

  private callback: ((msg: InboundMessage) => void) | null = null;
  private ws: GatewaySocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sequenceNumber: number | null = null;
  private sessionId: string | null = null;
  private running = false;

  constructor(options: DiscordAdapterOptions) {
    if (!options.token || options.token.length === 0) {
      throw new DiscordError("Discord token is required", "MISSING_TOKEN");
    }
    this.token = options.token;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.WebSocketCtor = options.WebSocketCtor ?? WebSocket;
    this.gatewayUrl = options.gatewayUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
  }

  async start(): Promise<void> {
    this.running = true;
    this.connectGateway();

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "discord",
      payload: { action: "start" },
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close(1000, "Shutting down");
      this.ws = null;
    }

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "discord",
      payload: { action: "stop" },
    });
  }

  onMessage(callback: (msg: InboundMessage) => void): void {
    this.callback = callback;
  }

  async send(channelId: string, message: OutboundMessage): Promise<void> {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${this.token}`,
        },
        body: JSON.stringify({ content: message.text }),
      });
    } catch (err) {
      throw new DiscordError(
        `Network error sending message: ${toErrorMessage(err)}`,
        "NETWORK_ERROR",
      );
    }

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch { /* ignore */ }
      throw new DiscordError(
        `Discord API error (status ${response.status}): ${body.slice(0, 500)}`,
        "API_ERROR",
      );
    }
  }

  // ── Gateway ─────────────────────────────────────────────────────────────

  private connectGateway(): void {
    const ws = new this.WebSocketCtor(this.gatewayUrl) as unknown as GatewaySocket;
    this.ws = ws;

    ws.onmessage = (ev) => {
      this.handleGatewayMessage(ev.data);
    };

    ws.onclose = (ev) => {
      this.stopHeartbeat();
      this.logger.log({
        sessionId: null,
        eventType: "config:change",
        component: "discord",
        payload: { action: "gateway_close", code: ev.code, reason: ev.reason },
      });

      // Reconnect if still running
      if (this.running) {
        setTimeout(() => this.connectGateway(), 5000);
      }
    };

    ws.onerror = (ev) => {
      this.logger.log({
        sessionId: null,
        eventType: "message:inbound",
        component: "discord",
        payload: { action: "gateway_error", error: String(ev) },
      });
    };
  }

  private handleGatewayMessage(data: string): void {
    let payload: DiscordGatewayPayload;
    try {
      payload = JSON.parse(data) as DiscordGatewayPayload;
    } catch {
      return;
    }

    if (payload.s !== null && payload.s !== undefined) {
      this.sequenceNumber = payload.s;
    }

    switch (payload.op) {
      case OP_HELLO:
        this.handleHello(payload.d as DiscordHelloEvent);
        break;
      case OP_HEARTBEAT_ACK:
        // Heartbeat acknowledged, nothing to do
        break;
      case OP_DISPATCH:
        this.handleDispatch(payload.t ?? "", payload.d);
        break;
    }
  }

  private handleHello(data: DiscordHelloEvent): void {
    this.startHeartbeat(data.heartbeat_interval);
    this.sendIdentify();
  }

  private sendIdentify(): void {
    this.ws?.send(JSON.stringify({
      op: OP_IDENTIFY,
      d: {
        token: this.token,
        intents: 1 << 9 | 1 << 15, // GUILD_MESSAGES | MESSAGE_CONTENT
        properties: {
          os: "linux",
          browser: "betterclaws",
          device: "betterclaws",
        },
      },
    }));
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.ws?.send(JSON.stringify({
        op: OP_HEARTBEAT,
        d: this.sequenceNumber,
      }));
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleDispatch(event: string, data: unknown): void {
    switch (event) {
      case "READY": {
        const ready = data as DiscordReadyEvent;
        this.sessionId = ready.session_id;
        this.logger.log({
          sessionId: null,
          eventType: "config:change",
          component: "discord",
          payload: { action: "ready", botUser: ready.user.username },
        });
        break;
      }
      case "MESSAGE_CREATE": {
        this.handleMessageCreate(data as DiscordMessage);
        break;
      }
    }
  }

  private handleMessageCreate(msg: DiscordMessage): void {
    // Skip bot's own messages
    if (this.sessionId && msg.author.id === this.sessionId) return;

    if (!msg.content) return;

    const text = truncateMessage(msg.content);

    const inbound: InboundMessage = {
      id: msg.id,
      adapterId: "discord",
      channelId: msg.channel_id,
      senderId: msg.author.id,
      text,
      timestamp: new Date(msg.timestamp).getTime(),
      raw: msg,
    };

    this.logger.log({
      sessionId: null,
      eventType: "message:inbound",
      component: "discord",
      payload: {
        messageId: msg.id,
        channelId: msg.channel_id,
        senderId: msg.author.id,
        senderName: msg.author.username,
        textLength: text.length,
      },
    });

    this.callback?.(inbound);
  }
}
