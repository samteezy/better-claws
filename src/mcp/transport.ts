/**
 * Transport interface for MCP client communication.
 *
 * Abstracts over the underlying protocol (stdio, SSE, streamable HTTP)
 * so that McpClient can operate transport-agnostically.
 */

import type { JsonRpcResponse } from "./json-rpc.js";

export interface McpTransport {
  sendRequest(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse>;
  sendNotification(method: string, params?: Record<string, unknown>): void;
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void;
  close(): void;
}
