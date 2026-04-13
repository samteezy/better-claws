import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createErrorClass,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage } from "../../types.js";
import type { StructuredLogger } from "../../logger/structured-logger.js";
import { readBody } from "../../utils/http.js";

export const WebhookError = createErrorClass("WebhookError", "webhook", "WEBHOOK_ERROR");

// ── Webhook payload ─────────────────────────────────────────────────────────

interface WebhookPayload {
  readonly channelId: string;
  readonly senderId: string;
  readonly text: string;
  readonly messageId?: string;
  readonly timestamp?: number;
  readonly metadata?: Record<string, unknown>;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export interface WebhookAdapterOptions {
  readonly secret: string;
  readonly host?: string;
  readonly port: number;
  readonly logger: StructuredLogger;
  /** Path that accepts webhook POSTs. Default: /webhook */
  readonly path?: string;
}

/**
 * Generic HTTP webhook adapter for custom integrations.
 * Accepts POST requests authenticated with HMAC-SHA256 signature.
 *
 * Signature header: `X-Webhook-Signature: sha256=<hex digest>`
 * The digest is computed over the raw request body using the shared secret.
 */
export class WebhookAdapter implements ChannelAdapter {
  readonly id = "webhook";
  readonly name = "Webhook";

  private readonly secret: string;
  private readonly host: string;
  private readonly port: number;
  private readonly webhookPath: string;
  private readonly logger: StructuredLogger;

  private callback: ((msg: InboundMessage) => void) | null = null;
  private server: Server | null = null;
  private pendingResponses = new Map<string, {
    resolve: (response: OutboundMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private messageCounter = 0;

  constructor(options: WebhookAdapterOptions) {
    if (!options.secret || options.secret.length === 0) {
      throw new WebhookError("Webhook secret is required", "MISSING_SECRET");
    }
    this.secret = options.secret;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port;
    this.webhookPath = options.path ?? "/webhook";
    this.logger = options.logger;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.on("error", (err) => {
        reject(new WebhookError(
          `Failed to start webhook server: ${err.message}`,
          "SERVER_ERROR",
        ));
      });

      server.listen(this.port, this.host, () => {
        this.server = server;
        this.logger.log({
          sessionId: null,
          eventType: "config:change",
          component: "webhook",
          payload: { action: "start", host: this.host, port: this.port, path: this.webhookPath },
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Clean up pending responses
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
    }
    this.pendingResponses.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        this.server = null;
        this.logger.log({
          sessionId: null,
          eventType: "config:change",
          component: "webhook",
          payload: { action: "stop" },
        });
        resolve();
      });
    });
  }

  onMessage(callback: (msg: InboundMessage) => void): void {
    this.callback = callback;
  }

  async send(channelId: string, message: OutboundMessage): Promise<void> {
    // For webhook adapter, "sending" means resolving a pending HTTP response
    // if one exists for this channelId, or logging a fire-and-forget delivery
    const pending = this.pendingResponses.get(channelId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(message);
      this.pendingResponses.delete(channelId);
    }

    this.logger.log({
      sessionId: null,
      eventType: "message:outbound",
      component: "webhook",
      payload: { channelId, textLength: message.text.length },
    });
  }

  // ── HTTP handling ─────────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only accept POST to the webhook path
    if (req.method !== "POST" || req.url !== this.webhookPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    let rawBody: string;
    try {
      rawBody = await this.readBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to read request body" }));
      return;
    }

    // Verify signature
    const signature = req.headers["x-webhook-signature"];
    if (!signature || typeof signature !== "string") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing signature" }));
      return;
    }

    if (!this.verifySignature(rawBody, signature)) {
      this.logger.log({
        sessionId: null,
        eventType: "message:inbound",
        component: "webhook",
        payload: { action: "signature_invalid" },
      });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return;
    }

    // Parse payload
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody) as WebhookPayload;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (!payload.channelId || !payload.senderId || !payload.text) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: channelId, senderId, text" }));
      return;
    }

    const messageId = payload.messageId ?? `wh-${++this.messageCounter}`;

    const inbound: InboundMessage = {
      id: messageId,
      adapterId: "webhook",
      channelId: payload.channelId,
      senderId: payload.senderId,
      text: payload.text,
      timestamp: payload.timestamp ?? Date.now(),
      raw: payload,
    };

    this.logger.log({
      sessionId: null,
      eventType: "message:inbound",
      component: "webhook",
      payload: {
        messageId,
        channelId: payload.channelId,
        senderId: payload.senderId,
        textLength: payload.text.length,
      },
    });

    // Acknowledge receipt immediately, then process async
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, messageId }));

    this.callback?.(inbound);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return readBody(req);
  }

  private verifySignature(body: string, header: string): boolean {
    const prefix = "sha256=";
    if (!header.startsWith(prefix)) return false;

    const providedHex = header.slice(prefix.length);
    const expectedHex = createHmac("sha256", this.secret)
      .update(body)
      .digest("hex");

    try {
      const a = Buffer.from(providedHex, "hex");
      const b = Buffer.from(expectedHex, "hex");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
