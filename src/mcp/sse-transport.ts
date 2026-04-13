/**
 * MCP SSE transport client.
 *
 * Connects to a remote MCP server using the SSE (Server-Sent Events) protocol:
 * - Client GETs the SSE endpoint; server holds the connection and pushes events.
 * - Server sends an `endpoint` event with the URL for posting JSON-RPC messages.
 * - Client POSTs JSON-RPC requests to the messages endpoint.
 * - Server pushes JSON-RPC responses back over the SSE stream.
 */

import http from "node:http";
import https from "node:https";
import { createErrorClass } from "../types.js";
import type { McpTransport } from "./transport.js";
import type { JsonRpcResponse } from "./json-rpc.js";

export const SseTransportError = createErrorClass("SseTransportError", "sse-transport", "SSE_TRANSPORT_ERROR");

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SseEvent {
  event: string;
  data: string;
}

// ── Transport ────────────────────────────────────────────────────────────────

export class SseTransport implements McpTransport {
  private readonly url: URL;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;

  private messagesUrl: URL | null = null;
  private sessionId: string | null = null;
  private sseRequest: http.ClientRequest | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private closed = false;

  constructor(
    url: string,
    headers: Readonly<Record<string, string>> = {},
    timeoutMs = 30_000,
  ) {
    this.url = new URL(url);
    this.headers = headers;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Opens the SSE connection and waits for the `endpoint` event that provides
   * the messages URL. Must be called before sendRequest/sendNotification.
   */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sseRequest?.destroy();
        reject(new SseTransportError("SSE connect timed out waiting for endpoint event", "CONNECT_TIMEOUT"));
      }, this.timeoutMs);

      const requestFn = this.url.protocol === "https:" ? https.get : http.get;

      const reqHeaders: Record<string, string> = {
        ...this.headers,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      };

      const req = requestFn(this.url, { headers: reqHeaders }, (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          reject(new SseTransportError(
            `SSE connection failed with status ${res.statusCode ?? 0}`,
            "CONNECT_ERROR",
          ));
          return;
        }

        // Capture session ID from response headers
        const sid = res.headers["mcp-session-id"];
        if (typeof sid === "string") {
          this.sessionId = sid;
        }

        res.setEncoding("utf-8");

        let buffer = "";
        let endpointResolved = false;

        res.on("data", (chunk: string) => {
          if (this.closed) return;
          buffer += chunk;
          const events = this.parseSseBuffer(buffer);
          buffer = events.remainder;

          for (const evt of events.events) {
            if (!endpointResolved && evt.event === "endpoint") {
              endpointResolved = true;
              try {
                // The endpoint may be absolute or relative to the SSE URL
                this.messagesUrl = new URL(evt.data.trim(), this.url);
              } catch {
                clearTimeout(timer);
                reject(new SseTransportError(`Invalid endpoint URL: ${evt.data}`, "INVALID_ENDPOINT"));
                return;
              }
              clearTimeout(timer);
              resolve();
            } else if (evt.event === "message" || evt.event === "") {
              this.handleSseMessage(evt.data);
            }
          }
        });

        res.on("end", () => {
          if (!endpointResolved) {
            clearTimeout(timer);
            reject(new SseTransportError("SSE connection closed before endpoint event", "CONNECT_ERROR"));
          }
          this.onClose();
        });

        res.on("error", (err) => {
          if (!endpointResolved) {
            clearTimeout(timer);
            reject(new SseTransportError(`SSE connection error: ${err.message}`, "CONNECT_ERROR"));
          }
          this.onClose();
        });
      });

      req.on("error", (err) => {
        clearTimeout(timer);
        reject(new SseTransportError(`SSE request error: ${err.message}`, "CONNECT_ERROR"));
      });

      this.sseRequest = req;
    });
  }

  sendRequest(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.messagesUrl) {
        reject(new SseTransportError("Transport is not connected", "NOT_CONNECTED"));
        return;
      }

      const id = this.nextId++;
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.postMessage(body).catch((err) => {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (this.closed || !this.messagesUrl) return;
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.postMessage(body).catch(() => {
      // Notifications are fire-and-forget
    });
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  close(): void {
    this.closed = true;
    this.sseRequest?.destroy();
    this.sseRequest = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transport closed"));
      this.pending.delete(id);
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async postMessage(body: string): Promise<void> {
    if (!this.messagesUrl) {
      throw new SseTransportError("No messages endpoint available", "NOT_CONNECTED");
    }

    const url = this.messagesUrl;
    const requestFn = url.protocol === "https:" ? https.request : http.request;

    const reqHeaders: Record<string, string> = {
      ...this.headers,
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    };
    if (this.sessionId) {
      reqHeaders["Mcp-Session-Id"] = this.sessionId;
    }

    return new Promise<void>((resolve, reject) => {
      const req = requestFn(
        url,
        { method: "POST", headers: reqHeaders },
        (res) => {
          // Capture session ID updates
          const sid = res.headers["mcp-session-id"];
          if (typeof sid === "string") {
            this.sessionId = sid;
          }

          let data = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => { data += chunk; });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new SseTransportError(
                `POST to messages endpoint failed with status ${res.statusCode}: ${data.slice(0, 500)}`,
                "POST_ERROR",
              ));
              return;
            }
            // Responses arrive via SSE stream, but some servers may also return
            // a JSON-RPC response directly in the POST response body.
            if (data.trim().length > 0) {
              try {
                const msg = JSON.parse(data) as Record<string, unknown>;
                if ("id" in msg && ("result" in msg || "error" in msg)) {
                  this.handleResponse(msg as unknown as JsonRpcResponse);
                }
              } catch {
                // Not JSON — that's fine, responses come via SSE
              }
            }
            resolve();
          });
          res.on("error", (err) => reject(err));
        },
      );

      req.on("error", (err) => reject(err));
      req.write(body);
      req.end();
    });
  }

  private handleSseMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    if ("id" in msg && ("result" in msg || "error" in msg)) {
      this.handleResponse(msg as unknown as JsonRpcResponse);
    } else if ("method" in msg && !("id" in msg)) {
      this.notificationHandler?.(
        msg["method"] as string,
        (msg["params"] ?? {}) as Record<string, unknown>,
      );
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  private parseSseBuffer(buffer: string): { events: SseEvent[]; remainder: string } {
    const events: SseEvent[] = [];
    const blocks = buffer.split("\n\n");
    const remainder = blocks.pop() ?? "";

    for (const block of blocks) {
      if (block.trim().length === 0) continue;

      let event = "";
      let data = "";
      const lines = block.split("\n");

      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data += (data.length > 0 ? "\n" : "") + line.slice(5).trim();
        }
        // Ignore id:, retry:, comments (:), etc.
      }

      if (data.length > 0 || event.length > 0) {
        events.push({ event, data });
      }
    }

    return { events, remainder };
  }

  private onClose(): void {
    this.close();
  }
}
