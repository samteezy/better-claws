import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { SLASH_COMMANDS } from "../../router/message-router.js";
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

    if (method === "GET" && path === "/commands") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(SLASH_COMMANDS));
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
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&family=Outfit:wght@500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f6f4f0;
    --bg-warm: #efece6;
    --surface: #ffffff;
    --surface-alt: #faf9f6;
    --border: #e6e2db;
    --text: #3a3632;
    --text-muted: #9e9891;
    --accent: #6b8f71;
    --accent-dark: #5a7d60;
    --accent-rgb: 107,143,113;
    --rose-soft: #fae8e8;
    --rose-text: #943e3e;
    --code-bg: #f0ece6;
    --thinking-bg: #f3f1ed;
    --thinking-text: #7a756d;
    --scrollbar: #ddd8d0;
    --placeholder: #b5b0a8;
    --app-shadow: rgba(0,0,0,0.04);
  }
  html[data-theme="dark"] {
    --bg: #1e1b18;
    --bg-warm: #262220;
    --surface: #2a2622;
    --surface-alt: #322e2a;
    --border: #3e3a35;
    --text: #e8e4df;
    --text-muted: #7a756f;
    --accent: #7fa386;
    --accent-dark: #6b9172;
    --accent-rgb: 42,58,44;
    --rose-soft: #3a2828;
    --rose-text: #d48282;
    --code-bg: #322e2a;
    --thinking-bg: #2a2622;
    --thinking-text: #b0aaa3;
    --scrollbar: #4a4540;
    --placeholder: #7a756f;
    --app-shadow: rgba(0,0,0,0.2);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    display: flex;
    justify-content: center;
    -webkit-font-smoothing: antialiased;
  }
  #app {
    width: 100%; max-width: 640px;
    height: 100dvh;
    display: flex; flex-direction: column;
    background: var(--surface-alt);
    box-shadow: 0 0 40px var(--app-shadow);
  }
  header {
    padding: 16px 20px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  header span.title {
    font-family: "Outfit", sans-serif;
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.2px;
  }
  header span.dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    opacity: 0.8;
    animation: pulse-dot 3s ease-in-out infinite;
  }
  #ctx-info {
    margin-left: auto;
    font-family: "DM Mono", monospace;
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .theme-toggle {
    margin-left: 8px;
    background: none;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 5px 7px;
    cursor: pointer;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    transition: color 0.2s, border-color 0.2s;
  }
  .theme-toggle:hover { color: var(--text); }
  .theme-toggle svg { width: 16px; height: 16px; }
  html[data-theme="dark"] .icon-sun { display: none; }
  html:not([data-theme="dark"]) .icon-moon { display: none; }
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
    background: var(--accent);
    color: #fff;
    border-bottom-right-radius: 6px;
  }
  .msg.assistant {
    align-self: flex-start;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-bottom-left-radius: 6px;
  }
  .msg.error {
    align-self: flex-start;
    background: var(--rose-soft);
    color: var(--rose-text);
    border-bottom-left-radius: 6px;
  }
  .msg.warning {
    align-self: center;
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    padding: 6px 14px;
    border: 1px dashed var(--border);
    border-radius: 10px;
    max-width: 90%;
  }
  .typing {
    align-self: flex-start;
    padding: 12px 20px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    border-bottom-left-radius: 6px;
    font-size: 16px;
    letter-spacing: 3px;
    color: var(--text-muted);
  }
  @keyframes blink { 50% { opacity: 0.25; } }
  .typing span { animation: blink 1.4s ease-in-out infinite; }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  #chat-form {
    display: flex;
    gap: 8px;
    padding: 12px 16px calc(env(safe-area-inset-bottom, 0px) + 12px);
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  #input {
    flex: 1;
    padding: 11px 16px;
    border: 1px solid var(--border);
    border-radius: 14px;
    font-size: 14px;
    font-family: inherit;
    color: var(--text);
    background: var(--surface-alt);
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  #input::placeholder { color: var(--placeholder); }
  #input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(var(--accent-rgb),0.12);
  }
  #input:disabled { background: var(--bg-warm); color: var(--text-muted); }
  #send-btn {
    padding: 11px 20px;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 14px;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s;
  }
  #send-btn:hover:not(:disabled) { background: var(--accent-dark); }
  #send-btn:active:not(:disabled) { transform: scale(0.96); }
  #send-btn:disabled { opacity: 0.4; cursor: default; }
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 3px; }
  ::selection { background: rgba(var(--accent-rgb),0.2); }
  .autocomplete-wrap { position: relative; flex: 1; }
  .autocomplete-wrap #input { width: 100%; }
  #ac-list {
    display: none;
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0; right: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.08);
    overflow: hidden;
    z-index: 10;
    max-height: 240px;
    overflow-y: auto;
  }
  #ac-list.show { display: block; }
  .ac-item {
    padding: 9px 14px;
    cursor: pointer;
    display: flex;
    align-items: baseline;
    gap: 10px;
    transition: background 0.1s;
  }
  .ac-item:hover, .ac-item.active {
    background: var(--bg-warm);
  }
  .ac-item .ac-name {
    font-family: "DM Mono", monospace;
    font-size: 13px;
    font-weight: 500;
    color: var(--accent);
    white-space: nowrap;
  }
  .ac-item .ac-args {
    font-family: "DM Mono", monospace;
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .ac-item .ac-desc {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .thinking {
    margin-bottom: 6px;
    padding: 8px 12px;
    background: var(--thinking-bg);
    border-radius: 10px;
    font-size: 13px;
    color: var(--thinking-text);
    border: 1px solid var(--border);
  }
  .thinking summary {
    cursor: pointer;
    font-weight: 500;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
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
    color: var(--text);
  }
  .md-content h4 { font-size: 1.1em; }
  .md-content h5 { font-size: 1em; }
  .md-content h6 { font-size: 0.95em; color: var(--text-muted); }
  .md-content strong { font-weight: 600; }
  .md-content code {
    font-family: "DM Mono", "SF Mono", monospace;
    font-size: 0.88em;
    background: var(--code-bg);
    padding: 0.15em 0.4em;
    border-radius: 5px;
  }
  .md-content pre {
    background: var(--code-bg);
    border: 1px solid var(--border);
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
    border-top: 1px solid var(--border);
    margin: 0.6em 0;
  }
</style>
</head>
<body>
<div id="app">
  <header>
    <span class="title">betterClaws</span>
    <span class="dot"></span>
    <span id="ctx-info"></span>
    <button class="theme-toggle" id="theme-toggle" aria-label="Toggle dark mode">
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
      <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    </button>
  </header>
  <div id="messages"></div>
  <form id="chat-form">
    <div class="autocomplete-wrap">
      <div id="ac-list"></div>
      <input id="input" type="text" placeholder="Type a message\u2026" autocomplete="off" />
    </div>
    <button id="send-btn" type="submit">Send</button>
  </form>
</div>
<script>__MARKDOWN_JS__</script>
<script>
(function() {
  var THEME_KEY = "bc_theme";
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem(THEME_KEY, t);
  }
  applyTheme(localStorage.getItem(THEME_KEY) || "light");
  document.getElementById("theme-toggle").addEventListener("click", function() {
    var c = document.documentElement.getAttribute("data-theme");
    applyTheme(c === "dark" ? "light" : "dark");
  });

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
              } else if (evt.type === "warning") {
                // Insert warning bubble before the current assistant message
                var warnMsg = { role: "warning", text: "\u26A0 " + evt.message };
                messages.splice(msgIdx, 0, warnMsg);
                msgIdx++;
                render();
                // Re-acquire the assistant element after render
                msgEl = messagesEl.lastElementChild;
                if (msgEl) {
                  textSpan = document.createElement("span");
                  msgEl.appendChild(textSpan);
                  msgEl.classList.add("md-content");
                  mdStream = window.BcMarkdown ? new BcMarkdown.StreamRenderer(textSpan) : null;
                }
              } else if (evt.type === "reset") {
                messages = [];
                render();
              } else if (evt.type === "done") {
                if (evt.context) {
                  var ctxEl = document.getElementById("ctx-info");
                  if (ctxEl) {
                    var used = evt.context.actualTokens != null ? evt.context.actualTokens : evt.context.estimatedTokens;
                    ctxEl.textContent = (used / 1000).toFixed(1) + "k / " + (evt.context.budget / 1000).toFixed(1) + "k context";
                  }
                }
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

  // ── Slash-command autocomplete ──────────────────────────────────────────
  var acList = document.getElementById("ac-list");
  var slashCmds = [];

  fetch("/commands")
    .then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function(cmds) { slashCmds = cmds; })
    .catch(function(err) { console.warn("Failed to load slash commands:", err); });

  var acIdx = -1;

  function esc(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function acRender(items) {
    acList.innerHTML = "";
    if (items.length === 0) { acList.classList.remove("show"); return; }
    for (var i = 0; i < items.length; i++) {
      var c = items[i];
      var div = document.createElement("div");
      div.className = "ac-item";
      div.dataset.name = c.name;
      div.innerHTML =
        '<span class="ac-name">' + esc(c.name) + '</span>' +
        (c.args ? '<span class="ac-args">' + esc(c.args) + '</span>' : '') +
        '<span class="ac-desc">' + esc(c.description) + '</span>';
      div.addEventListener("mousedown", function(ev) {
        ev.preventDefault();
        acSelect(this.dataset.name);
      });
      acList.appendChild(div);
    }
    acList.classList.add("show");
    acIdx = -1;
  }

  function acFilter() {
    var val = input.value;
    if (!val.startsWith("/") || val.includes(" ") || slashCmds.length === 0) {
      acList.classList.remove("show");
      return;
    }
    var q = val.toLowerCase();
    var matches = slashCmds.filter(function(c) { return c.name.startsWith(q); });
    acRender(matches);
  }

  function acSelect(name) {
    input.value = name + " ";
    acList.classList.remove("show");
    acIdx = -1;
    input.focus();
  }

  function acHighlight(idx) {
    var items = acList.querySelectorAll(".ac-item");
    for (var i = 0; i < items.length; i++) items[i].classList.remove("active");
    if (idx >= 0 && idx < items.length) {
      items[idx].classList.add("active");
      items[idx].scrollIntoView({ block: "nearest" });
    }
  }

  input.addEventListener("input", acFilter);
  input.addEventListener("blur", function() {
    setTimeout(function() { acList.classList.remove("show"); }, 120);
  });
  input.addEventListener("focus", acFilter);

  input.addEventListener("keydown", function(e) {
    if (!acList.classList.contains("show")) return;
    var items = acList.querySelectorAll(".ac-item");
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      acIdx = acIdx < items.length - 1 ? acIdx + 1 : 0;
      acHighlight(acIdx);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      acIdx = acIdx > 0 ? acIdx - 1 : items.length - 1;
      acHighlight(acIdx);
    } else if ((e.key === "Enter" || e.key === "Tab") && acIdx >= 0) {
      e.preventDefault();
      acSelect(items[acIdx].dataset.name);
    } else if (e.key === "Escape") {
      acList.classList.remove("show");
      acIdx = -1;
    }
  });

  input.focus();
})();
</script>
</body>
</html>`;
