/**
 * JSON-RPC 2.0 transport over newline-delimited streams.
 * Used by the MCP client to communicate with MCP server subprocesses.
 */

import type { Readable, Writable } from "node:stream";
import type { McpTransport } from "./transport.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

type PendingRequest = {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

// ── Transport ────────────────────────────────────────────────────────────────

export class JsonRpcTransport implements McpTransport {
  private readonly writable: Writable;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private closed = false;
  private readonly timeoutMs: number;

  constructor(readable: Readable, writable: Writable, timeoutMs = 30_000) {
    this.writable = writable;
    this.timeoutMs = timeoutMs;

    readable.setEncoding("utf-8");
    readable.on("data", (chunk: string) => this.onData(chunk));
    readable.on("end", () => this.onClose());
    readable.on("error", () => this.onClose());
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  sendRequest(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("Transport is closed"));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.writable.write(JSON.stringify(request) + "\n");
    });
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.writable.write(JSON.stringify(notification) + "\n");
  }

  close(): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transport closed"));
      this.pending.delete(id);
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private onData(chunk: string): void {
    this.buffer += chunk;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) continue;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // skip malformed lines
      }

      if ("id" in msg && ("result" in msg || "error" in msg)) {
        this.handleResponse(msg as unknown as JsonRpcResponse);
      } else if ("method" in msg && !("id" in msg)) {
        this.handleNotification(msg as unknown as JsonRpcNotification);
      }
      // Ignore other messages (e.g., requests from server — not handled in client mode)
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    this.notificationHandler?.(
      notification.method,
      (notification.params ?? {}) as Record<string, unknown>,
    );
  }

  private onClose(): void {
    this.close();
  }
}
