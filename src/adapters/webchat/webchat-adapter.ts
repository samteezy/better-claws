import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  BetterClawsError,
  type InboundMessage,
  type OutboundMessage,
  type StreamableChannelAdapter,
  type StreamableResponse,
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

export class WebChatAdapter implements StreamableChannelAdapter {
  readonly id = "webchat";
  readonly name = "WebChat";

  private readonly host: string;
  private readonly port: number;
  private readonly logger: StructuredLogger;
  private readonly authToken: string | undefined;

  private callback: ((msg: InboundMessage) => void) | null = null;
  private server: Server | null = null;
  private messageCounter = 0;
  private markdownJs = "";
  private readonly pendingResponses = new Map<string, {
    resolve: (response: OutboundMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly pendingStreamResponses = new Map<string, {
    res: ServerResponse;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /** Response timeout in milliseconds. */
  private readonly timeoutMs: number;
  /** Stream timeout — longer to accommodate tool call loops. */
  private readonly streamTimeoutMs: number;

  constructor(options: WebChatAdapterOptions) {
    if (!options.port || options.port <= 0) {
      throw new WebChatError("WebChat port must be a positive number", "INVALID_PORT");
    }
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port;
    this.logger = options.logger;
    this.authToken = options.authToken;
    this.timeoutMs = 30_000;
    this.streamTimeoutMs = 120_000;
  }

  async start(): Promise<void> {
    const isNetworkExposed = this.host !== "127.0.0.1" && this.host !== "localhost";
    if (isNetworkExposed && !this.authToken) {
      throw new WebChatError(
        "WebChat cannot bind to a non-loopback address without an authToken configured",
        "UNSAFE_CONFIG",
      );
    }

    const mdPath = join(process.cwd(), "src", "dashboard", "public", "markdown.js");
    try {
      this.markdownJs = await readFile(mdPath, "utf-8");
    } catch {
      this.logger.log({
        sessionId: null,
        eventType: "config:change",
        component: "webchat",
        payload: { action: "markdown_load_failed", path: mdPath },
      });
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

    for (const [, pending] of this.pendingStreamResponses) {
      clearTimeout(pending.timer);
      pending.res.write(`data: ${JSON.stringify({ type: "error", message: "Server shutting down." })}\n\n`);
      pending.res.end();
    }
    this.pendingStreamResponses.clear();

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

  async sendStream(channelId: string, response: StreamableResponse): Promise<void> {
    const pending = this.pendingStreamResponses.get(channelId);
    if (!pending) {
      // Fallback: no stream endpoint was used — collect and send as regular response
      const text = await response.text;
      return this.send(channelId, { channelId, text });
    }

    const { res, timer } = pending;
    clearTimeout(timer);
    this.pendingStreamResponses.delete(channelId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    try {
      for await (const event of response.stream) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: "error", message: err instanceof Error ? err.message : "Stream failed" })}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();

    this.logger.log({
      sessionId: null,
      eventType: "message:outbound",
      component: "webchat",
      payload: { channelId, streaming: true },
    });
  }

  // ── HTTP handling ─────────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (method === "GET" && path === "/") {
      let html = this.authToken
        ? CHAT_HTML.replace("__AUTH_TOKEN__", () => this.authToken!)
        : CHAT_HTML.replace("__AUTH_TOKEN__", "");
      html = html.replace("__MARKDOWN_JS__", () => this.markdownJs);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (method === "POST" && (path === "/chat" || path === "/chat/stream")) {
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
      if (path === "/chat/stream") {
        return this.handleChatStream(req, res);
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

  private async handleChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      payload: { messageId, senderId, textLength: inbound.text.length, streaming: true },
    });

    const timer = setTimeout(() => {
      this.pendingStreamResponses.delete(messageId);
      this.logger.log({
        sessionId: null,
        eventType: "message:outbound",
        component: "webchat",
        payload: { messageId, action: "stream_timeout" },
      });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "error", message: "Request timed out — the LLM did not respond in time." })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, this.streamTimeoutMs);

    this.pendingStreamResponses.set(messageId, { res, timer });

    this.callback?.(inbound);
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
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>betterClaws WebChat</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&family=Outfit:wght@500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif;
    background: #f6f4f0;
    display: flex;
    justify-content: center;
    -webkit-font-smoothing: antialiased;
  }
  #app {
    width: 100%; max-width: 640px;
    height: 100dvh;
    display: flex; flex-direction: column;
    background: #faf9f6;
    box-shadow: 0 0 40px rgba(0,0,0,0.04);
  }
  header {
    padding: 16px 20px;
    background: #ffffff;
    border-bottom: 1px solid #e6e2db;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  header span.title {
    font-family: "Outfit", sans-serif;
    font-size: 16px;
    font-weight: 600;
    color: #3a3632;
    letter-spacing: -0.2px;
  }
  header span.dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #6b8f71;
    opacity: 0.8;
    animation: pulse-dot 3s ease-in-out infinite;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 0.8; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.85); }
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    -webkit-overflow-scrolling: touch;
  }
  .msg {
    max-width: 82%;
    padding: 11px 16px;
    border-radius: 20px;
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    animation: msgIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes msgIn {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .msg.user {
    align-self: flex-end;
    background: #6b8f71;
    color: #fff;
    border-bottom-right-radius: 6px;
  }
  .msg.assistant {
    align-self: flex-start;
    background: #ffffff;
    color: #3a3632;
    border: 1px solid #e6e2db;
    border-bottom-left-radius: 6px;
  }
  .msg.error {
    align-self: flex-start;
    background: #fae8e8;
    color: #943e3e;
    border-bottom-left-radius: 6px;
  }
  .typing {
    align-self: flex-start;
    padding: 12px 20px;
    background: #ffffff;
    border: 1px solid #e6e2db;
    border-radius: 20px;
    border-bottom-left-radius: 6px;
    font-size: 16px;
    letter-spacing: 3px;
    color: #9e9891;
  }
  @keyframes blink { 50% { opacity: 0.25; } }
  .typing span { animation: blink 1.4s ease-in-out infinite; }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  #chat-form {
    display: flex;
    gap: 8px;
    padding: 12px 16px calc(env(safe-area-inset-bottom, 0px) + 12px);
    border-top: 1px solid #e6e2db;
    background: #ffffff;
  }
  #input {
    flex: 1;
    padding: 11px 16px;
    border: 1px solid #e6e2db;
    border-radius: 14px;
    font-size: 14px;
    font-family: inherit;
    color: #3a3632;
    background: #faf9f6;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  #input::placeholder { color: #b5b0a8; }
  #input:focus {
    border-color: #6b8f71;
    box-shadow: 0 0 0 3px rgba(107,143,113,0.12);
  }
  #input:disabled { background: #efece6; color: #9e9891; }
  #send-btn {
    padding: 11px 20px;
    background: #6b8f71;
    color: #fff;
    border: none;
    border-radius: 14px;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
  }
  #send-btn:hover:not(:disabled) { background: #5a7d60; }
  #send-btn:active:not(:disabled) { transform: scale(0.96); }
  #send-btn:disabled { opacity: 0.4; cursor: default; }
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #ddd8d0; border-radius: 3px; }
  ::selection { background: rgba(107,143,113,0.2); }
  .thinking {
    margin-bottom: 6px;
    padding: 8px 12px;
    background: #f3f1ed;
    border-radius: 10px;
    font-size: 13px;
    color: #7a756d;
    border: 1px solid #e6e2db;
  }
  .thinking summary {
    cursor: pointer;
    font-weight: 500;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #9e9891;
  }
  .thinking-content {
    margin-top: 6px;
    white-space: pre-wrap;
    line-height: 1.45;
  }
  .md-content { white-space: normal; }
  .md-content p { margin: 0 0 0.5em; }
  .md-content p:last-child { margin-bottom: 0; }
  .md-content h4, .md-content h5, .md-content h6 {
    margin: 0.8em 0 0.3em;
    font-family: "Outfit", sans-serif;
    color: #3a3632;
  }
  .md-content h4 { font-size: 1.1em; }
  .md-content h5 { font-size: 1em; }
  .md-content h6 { font-size: 0.95em; color: #9e9891; }
  .md-content strong { font-weight: 600; }
  .md-content code {
    font-family: "DM Mono", "SF Mono", monospace;
    font-size: 0.88em;
    background: #f0ece6;
    padding: 0.15em 0.4em;
    border-radius: 5px;
  }
  .md-content pre {
    background: #f0ece6;
    border: 1px solid #e6e2db;
    border-radius: 10px;
    padding: 12px 14px;
    overflow-x: auto;
    margin: 0.5em 0;
  }
  .md-content pre code {
    background: none;
    padding: 0;
    font-size: 0.85em;
    border-radius: 0;
  }
  .md-content ul, .md-content ol {
    margin: 0.3em 0 0.5em;
    padding-left: 1.4em;
  }
  .md-content li { margin: 0.15em 0; }
  .md-content hr {
    border: none;
    border-top: 1px solid #e6e2db;
    margin: 0.6em 0;
  }
</style>
</head>
<body>
<div id="app">
  <header>
    <span class="title">betterClaws</span>
    <span class="dot"></span>
  </header>
  <div id="messages"></div>
  <form id="chat-form">
    <input id="input" type="text" placeholder="Type a message\u2026" autocomplete="off" />
    <button id="send-btn" type="submit">Send</button>
  </form>
</div>
<script>__MARKDOWN_JS__</script>
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
      if (m.role === "assistant" && window.BcMarkdown) {
        div.classList.add("md-content");
        div.innerHTML = BcMarkdown.render(m.text);
      } else {
        div.textContent = m.text;
      }
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
    setEnabled(false);

    var hdrs = { "Content-Type": "application/json" };
    if (authToken) hdrs["Authorization"] = "Bearer " + authToken;

    // Stream response via SSE
    fetch("/chat/stream", {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ text: text })
    })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || "Request failed"); });
      // Create assistant bubble immediately for streaming
      messages.push({ role: "assistant", text: "" });
      render();
      var msgIdx = messages.length - 1;
      var msgEl = messagesEl.lastElementChild;
      // Add a text-content span so thinking block and text can coexist
      var textSpan = document.createElement("span");
      if (msgEl) { msgEl.appendChild(textSpan); msgEl.classList.add("md-content"); }
      var mdStream = window.BcMarkdown ? new BcMarkdown.StreamRenderer(textSpan) : null;
      var reader = r.body.getReader();
      var decoder = new TextDecoder();
      var buf = "";

      function pump() {
        return reader.read().then(function(result) {
          if (result.done) {
            if (mdStream) mdStream.flush();
            // Collapse thinking block when stream ends
            if (msgEl) {
              var thinkEl = msgEl.querySelector(".thinking");
              if (thinkEl) thinkEl.open = false;
            }
            return;
          }
          buf += decoder.decode(result.value, { stream: true });
          var parts = buf.split("\\n\\n");
          buf = parts.pop() || "";
          for (var i = 0; i < parts.length; i++) {
            var line = parts[i].trim();
            if (!line.startsWith("data: ")) continue;
            var data = line.slice(6);
            if (data === "[DONE]") {
              if (mdStream) mdStream.flush();
              // Collapse thinking block on completion
              if (msgEl) {
                var thinkEl = msgEl.querySelector(".thinking");
                if (thinkEl) thinkEl.open = false;
              }
              return;
            }
            try {
              var evt = JSON.parse(data);
              if (evt.type === "reasoning-delta") {
                if (msgEl) {
                  var thinkEl = msgEl.querySelector(".thinking");
                  if (!thinkEl) {
                    thinkEl = document.createElement("details");
                    thinkEl.className = "thinking";
                    thinkEl.open = true;
                    var summary = document.createElement("summary");
                    summary.textContent = "Thinking\u2026";
                    thinkEl.appendChild(summary);
                    var thinkContent = document.createElement("div");
                    thinkContent.className = "thinking-content";
                    thinkEl.appendChild(thinkContent);
                    msgEl.insertBefore(thinkEl, textSpan);
                  }
                  var tc = thinkEl.querySelector(".thinking-content");
                  if (tc) tc.textContent += evt.delta;
                  messagesEl.scrollTop = messagesEl.scrollHeight;
                }
              } else if (evt.type === "text-delta") {
                messages[msgIdx].text += evt.delta;
                if (mdStream) {
                  mdStream.push(evt.delta);
                } else {
                  textSpan.textContent = messages[msgIdx].text;
                }
                messagesEl.scrollTop = messagesEl.scrollHeight;
              } else if (evt.type === "error") {
                messages[msgIdx].role = "error";
                messages[msgIdx].text = evt.message;
                render();
              }
            } catch(ignored) {}
          }
          return pump();
        });
      }

      return pump();
    })
    .catch(function(err) {
      // If there's already a streaming bubble, convert it to error
      var last = messages[messages.length - 1];
      if (last && last.role === "assistant" && last.text === "") {
        last.role = "error";
        last.text = err.message || "Something went wrong";
      } else {
        messages.push({ role: "error", text: err.message || "Something went wrong" });
      }
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
