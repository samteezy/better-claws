/**
 * MCP Streamable HTTP transport client.
 *
 * Uses a single POST endpoint for all JSON-RPC communication. Responses
 * may arrive as `application/json` (single response) or `text/event-stream`
 * (SSE stream of responses).
 */

import http from "node:http";
import https from "node:https";
import { createErrorClass } from "../types.js";
import type { McpTransport } from "./transport.js";
import type { JsonRpcResponse } from "./json-rpc.js";

export const HttpTransportError = createErrorClass("HttpTransportError", "http-transport", "HTTP_TRANSPORT_ERROR");

function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  return typeof msg === "object" && msg !== null && "id" in msg && ("result" in msg || "error" in msg);
}

// ── Transport ────────────────────────────────────────────────────────────────

export class HttpTransport implements McpTransport {
  private readonly url: URL;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;

  private sessionId: string | null = null;
  private nextId = 1;
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

  sendRequest(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (this.closed) {
      return Promise.reject(new HttpTransportError("Transport is closed", "CLOSED"));
    }

    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return this.post(body);
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.post(body).catch(() => {
      // Notifications are fire-and-forget
    });
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  close(): void {
    this.closed = true;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private post(body: string): Promise<JsonRpcResponse> {
    const requestFn = this.url.protocol === "https:" ? https.request : http.request;

    const reqHeaders: Record<string, string> = {
      ...this.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": String(Buffer.byteLength(body)),
    };
    if (this.sessionId) {
      reqHeaders["Mcp-Session-Id"] = this.sessionId;
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`HTTP request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const req = requestFn(
        this.url,
        { method: "POST", headers: reqHeaders },
        (res) => {
          // Capture session ID
          const sid = res.headers["mcp-session-id"];
          if (typeof sid === "string") {
            this.sessionId = sid;
          }

          const contentType = res.headers["content-type"] ?? "";

          if (contentType.includes("text/event-stream")) {
            this.handleSseResponse(res, timer, resolve, reject);
          } else {
            this.handleJsonResponse(res, timer, resolve, reject);
          }
        },
      );

      req.on("error", (err) => {
        clearTimeout(timer);
        reject(new HttpTransportError(`HTTP request error: ${err.message}`, "REQUEST_ERROR"));
      });

      req.write(body);
      req.end();
    });
  }

  private handleJsonResponse(
    res: http.IncomingMessage,
    timer: NodeJS.Timeout,
    resolve: (r: JsonRpcResponse) => void,
    reject: (e: Error) => void,
  ): void {
    let data = "";
    res.setEncoding("utf-8");

    res.on("data", (chunk: string) => { data += chunk; });

    res.on("end", () => {
      clearTimeout(timer);

      if (res.statusCode && res.statusCode >= 400) {
        reject(new HttpTransportError(
          `HTTP ${res.statusCode}: ${data.slice(0, 500)}`,
          "HTTP_ERROR",
        ));
        return;
      }

      try {
        const parsed = JSON.parse(data) as JsonRpcResponse;
        resolve(parsed);
      } catch {
        reject(new HttpTransportError("Invalid JSON in response body", "PARSE_ERROR"));
      }
    });

    res.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  }

  private handleSseResponse(
    res: http.IncomingMessage,
    timer: NodeJS.Timeout,
    resolve: (r: JsonRpcResponse) => void,
    reject: (e: Error) => void,
  ): void {
    let buffer = "";
    let resolved = false;
    res.setEncoding("utf-8");

    res.on("data", (chunk: string) => {
      buffer += chunk;

      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        if (block.trim().length === 0) continue;

        const lines = block.split("\n");
        let data = "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            data += (data.length > 0 ? "\n" : "") + line.slice(5).trim();
          }
        }

        if (data.length === 0) continue;

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        // JSON-RPC response (has id + result/error)
        if (isJsonRpcResponse(msg)) {
          if (!resolved) {
            clearTimeout(timer);
            resolved = true;
            resolve(msg);
          }
        }
        // Server notification (has method, no id)
        else if ("method" in msg && !("id" in msg)) {
          this.notificationHandler?.(
            msg["method"] as string,
            (msg["params"] ?? {}) as Record<string, unknown>,
          );
        }
      }
    });

    res.on("end", () => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new HttpTransportError("SSE stream ended without a response", "NO_RESPONSE"));
      }
    });

    res.on("error", (err) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }
}
