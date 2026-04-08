import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  BetterClawsError,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage,
} from "../../types.js";
import type { StructuredLogger } from "../../logger/structured-logger.js";

export class WebChatError extends BetterClawsError {
  constructor(message: string, code: string = "WEBCHAT_ERROR") {
    super(message, "webchat", code);
    this.name = "WebChatError";
  }
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface WebChatAdapterOptions {
  readonly host?: string;
  readonly port: number;
  readonly logger: StructuredLogger;
  readonly authToken?: string;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export class WebChatAdapter implements ChannelAdapter {
  readonly id = "webchat";
  readonly name = "WebChat";

  private readonly host: string;
  private readonly port: number;
  private readonly logger: StructuredLogger;
  private readonly authToken: string | undefined;

  private callback: ((msg: InboundMessage) => void) | null = null;
  private server: Server | null = null;
  private messageCounter = 0;
  private readonly pendingResponses = new Map<string, {
    resolve: (response: OutboundMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /** Response timeout in milliseconds. */
  private readonly timeoutMs: number;

  constructor(options: WebChatAdapterOptions) {
    if (!options.port || options.port <= 0) {
      throw new WebChatError("WebChat port must be a positive number", "INVALID_PORT");
    }
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port;
    this.logger = options.logger;
    this.authToken = options.authToken;
    this.timeoutMs = 30_000;
  }

  async start(): Promise<void> {
    const isNetworkExposed = this.host !== "127.0.0.1" && this.host !== "localhost";
    if (isNetworkExposed && !this.authToken) {
      throw new WebChatError(
        "WebChat cannot bind to a non-loopback address without an authToken configured",
        "UNSAFE_CONFIG",
      );
    }

    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.on("error", (err) => {
        reject(new WebChatError(
          `Failed to start webchat server: ${err.message}`,
          "SERVER_ERROR",
        ));
      });

      server.listen(this.port, this.host, () => {
        this.server = server;
        this.logger.log({
          sessionId: null,
          eventType: "config:change",
          component: "webchat",
          payload: { action: "start", host: this.host, port: this.port },
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const [id, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
      pending.resolve({ channelId: id, text: "Server shutting down." });
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
          component: "webchat",
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
    const pending = this.pendingResponses.get(channelId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(message);
      this.pendingResponses.delete(channelId);
    }

    this.logger.log({
      sessionId: null,
      eventType: "message:outbound",
      component: "webchat",
      payload: { channelId, textLength: message.text.length },
    });
  }

  // ── HTTP handling ─────────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (method === "GET" && path === "/") {
      const html = this.authToken
        ? CHAT_HTML.replace("__AUTH_TOKEN__", this.authToken)
        : CHAT_HTML.replace("__AUTH_TOKEN__", "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (method === "POST" && path === "/chat") {
      if (!this.authenticate(req)) {
        this.logger.log({
          sessionId: null,
          eventType: "config:change",
          component: "webchat",
          payload: { action: "auth_failure", path },
        });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      return this.handleChat(req, res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let rawBody: string;
    try {
      rawBody = await this.readBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to read request body" }));
      return;
    }

    let payload: { text?: unknown; senderId?: unknown };
    try {
      payload = JSON.parse(rawBody) as { text?: unknown; senderId?: unknown };
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (!payload.text || typeof payload.text !== "string" || payload.text.trim().length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required field: text" }));
      return;
    }

    const senderId = typeof payload.senderId === "string" && payload.senderId.length > 0
      ? payload.senderId
      : "webchat-user";
    const messageId = `wc-${++this.messageCounter}`;

    const inbound: InboundMessage = {
      id: messageId,
      adapterId: "webchat",
      channelId: messageId,
      senderId,
      text: payload.text.trim(),
      timestamp: Date.now(),
    };

    this.logger.log({
      sessionId: null,
      eventType: "message:inbound",
      component: "webchat",
      payload: {
        messageId,
        senderId,
        textLength: inbound.text.length,
      },
    });

    const responsePromise = new Promise<OutboundMessage>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(messageId);
        this.logger.log({
          sessionId: null,
          eventType: "message:outbound",
          component: "webchat",
          payload: { messageId, action: "timeout" },
        });
        resolve({ channelId: messageId, text: "Request timed out — the LLM did not respond in time." });
      }, this.timeoutMs);

      this.pendingResponses.set(messageId, { resolve, timer });
    });

    this.callback?.(inbound);

    const response = await responsePromise;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: response.text, messageId }));
  }

  private authenticate(req: IncomingMessage): boolean {
    if (!this.authToken) return true;

    const header = req.headers["authorization"];
    if (!header || !header.startsWith("Bearer ")) return false;

    const token = header.slice(7);
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(this.authToken);

    if (tokenBuf.byteLength !== expectedBuf.byteLength) return false;
    return timingSafeEqual(tokenBuf, expectedBuf);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const maxSize = 1024 * 1024; // 1MB

      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxSize) {
          req.destroy();
          reject(new WebChatError("Request body too large", "BODY_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });

      req.on("error", reject);
    });
  }
}

// ── Embedded Chat HTML ──────────────────────────────────────────────────────

const CHAT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>betterClaws WebChat</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f5f5f5;
    display: flex;
    justify-content: center;
  }
  #app {
    width: 100%; max-width: 720px;
    height: 100vh;
    display: flex; flex-direction: column;
    background: #fff;
    box-shadow: 0 0 12px rgba(0,0,0,0.08);
  }
  header {
    padding: 14px 20px;
    background: #1a1a2e;
    color: #e0e0e0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.3px;
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .msg {
    max-width: 78%;
    padding: 10px 14px;
    border-radius: 16px;
    font-size: 14px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg.user {
    align-self: flex-end;
    background: #2563eb;
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .msg.assistant {
    align-self: flex-start;
    background: #e8e8e8;
    color: #1a1a1a;
    border-bottom-left-radius: 4px;
  }
  .msg.error {
    align-self: flex-start;
    background: #fee2e2;
    color: #991b1b;
    border-bottom-left-radius: 4px;
  }
  .typing {
    align-self: flex-start;
    padding: 10px 18px;
    background: #e8e8e8;
    border-radius: 16px;
    border-bottom-left-radius: 4px;
    font-size: 18px;
    letter-spacing: 3px;
    color: #888;
  }
  @keyframes blink { 50% { opacity: 0.3; } }
  .typing span { animation: blink 1.4s infinite; }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  #chat-form {
    display: flex;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid #e5e5e5;
    background: #fafafa;
  }
  #input {
    flex: 1;
    padding: 10px 14px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s;
  }
  #input:focus { border-color: #2563eb; }
  #input:disabled { background: #f3f4f6; }
  #send-btn {
    padding: 10px 20px;
    background: #2563eb;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }
  #send-btn:hover:not(:disabled) { background: #1d4ed8; }
  #send-btn:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<div id="app">
  <header>betterClaws WebChat</header>
  <div id="messages"></div>
  <form id="chat-form">
    <input id="input" type="text" placeholder="Type a message\u2026" autocomplete="off" />
    <button id="send-btn" type="submit">Send</button>
  </form>
</div>
<script>
(function() {
  var messages = [];
  var messagesEl = document.getElementById("messages");
  var form = document.getElementById("chat-form");
  var input = document.getElementById("input");
  var btn = document.getElementById("send-btn");
  var authToken = "__AUTH_TOKEN__";
  var busy = false;

  function render() {
    messagesEl.innerHTML = "";
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var div = document.createElement("div");
      div.className = "msg " + m.role;
      div.textContent = m.text;
      messagesEl.appendChild(div);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    var el = document.createElement("div");
    el.className = "typing";
    el.id = "typing";
    el.innerHTML = "<span>.</span><span>.</span><span>.</span>";
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    var el = document.getElementById("typing");
    if (el) el.remove();
  }

  function setEnabled(enabled) {
    busy = !enabled;
    input.disabled = !enabled;
    btn.disabled = !enabled;
    if (enabled) input.focus();
  }

  form.addEventListener("submit", function(e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;

    messages.push({ role: "user", text: text });
    input.value = "";
    render();
    showTyping();
    setEnabled(false);

    var hdrs = { "Content-Type": "application/json" };
    if (authToken) hdrs["Authorization"] = "Bearer " + authToken;

    fetch("/chat", {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ text: text })
    })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || "Request failed"); });
      return r.json();
    })
    .then(function(data) {
      hideTyping();
      messages.push({ role: "assistant", text: data.text });
      render();
    })
    .catch(function(err) {
      hideTyping();
      messages.push({ role: "error", text: err.message || "Something went wrong" });
      render();
    })
    .finally(function() {
      setEnabled(true);
    });
  });

  input.focus();
})();
</script>
</body>
</html>`;
