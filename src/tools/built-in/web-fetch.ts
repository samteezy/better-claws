import { fileURLToPath } from "node:url";
import { toErrorMessage } from "../../utils/errors.js";
import type {
  ToolDescriptor,
  ToolHandler,
  ExecutionContext,
  ToolResult,
} from "../../types.js";

export const handlerPath = fileURLToPath(import.meta.url);

const DEFAULT_MAX_BYTES = 102400; // 100KB

/** Headers that must never be forwarded from LLM-generated requests. */
const BLOCKED_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie", "proxy-authorization"]);

/** @internal Exported for tests only. */
export interface FilteredHeaders {
  readonly headers: Record<string, string>;
  readonly blocked: readonly string[];
}

/** @internal Exported for tests only. */
export function filterHeaders(
  rawHeaders: Record<string, string>,
  blocklist: ReadonlySet<string> = BLOCKED_HEADERS,
): FilteredHeaders {
  const headers: Record<string, string> = {};
  const blocked: string[] = [];
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (blocklist.has(k.toLowerCase())) {
      blocked.push(k);
    } else {
      headers[k] = v;
    }
  }
  return { headers, blocked };
}

export const descriptor: ToolDescriptor = {
  name: "web-fetch",
  description:
    "Fetch a URL over HTTP/HTTPS. Supports GET, POST, HEAD, and custom headers.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      method: {
        type: "string",
        description: "HTTP method (default: GET)",
      },
      headers: {
        type: "object",
        description: "HTTP headers as key-value pairs",
      },
      body: {
        type: "string",
        description: "Request body (for POST/PUT/PATCH)",
      },
      maxBytes: {
        type: "number",
        description: "Maximum response bytes to return (default: 102400)",
      },
    },
    required: ["url"],
  },
  capabilities: ["net:outbound"],
};

export const handler: ToolHandler = {
  async execute(
    params: Record<string, unknown>,
    _context: ExecutionContext,
  ): Promise<ToolResult> {
    const start = Date.now();
    const url = params["url"];

    if (typeof url !== "string" || url.length === 0) {
      return {
        success: false,
        output: null,
        error: "Missing required parameter: url",
        durationMs: Date.now() - start,
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        success: false,
        output: null,
        error: `Invalid URL: ${url}`,
        durationMs: Date.now() - start,
      };
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        success: false,
        output: null,
        error: `Unsupported protocol: ${parsed.protocol}`,
        durationMs: Date.now() - start,
      };
    }

    // SSRF protection: block requests to private/internal IP ranges
    if (isPrivateHost(parsed.hostname)) {
      return {
        success: false,
        output: null,
        error: `Blocked request to private/internal address: ${parsed.hostname}`,
        durationMs: Date.now() - start,
      };
    }

    const method =
      typeof params["method"] === "string"
        ? params["method"].toUpperCase()
        : "GET";
    const rawHeaders =
      params["headers"] !== null && typeof params["headers"] === "object"
        ? (params["headers"] as Record<string, string>)
        : {};
    const { headers, blocked } = filterHeaders(rawHeaders);
    const body =
      typeof params["body"] === "string" ? params["body"] : undefined;
    const maxBytes =
      typeof params["maxBytes"] === "number"
        ? params["maxBytes"]
        : DEFAULT_MAX_BYTES;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method !== "GET" && method !== "HEAD" ? body : undefined,
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let responseBody: string;
      let truncated = false;

      if (method === "HEAD") {
        responseBody = "";
      } else {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes) {
          responseBody = new TextDecoder().decode(buffer.slice(0, maxBytes));
          truncated = true;
        } else {
          responseBody = new TextDecoder().decode(buffer);
        }
      }

      const warnings = blocked.map(h => `Blocked header: ${h}`);
      return {
        success: response.ok,
        output: {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: responseBody,
          truncated,
          byteLength: method === "HEAD" ? 0 : responseBody.length,
        },
        durationMs: Date.now() - start,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (err) {
      const warnings = blocked.map(h => `Blocked header: ${h}`);
      return {
        success: false,
        output: null,
        error: toErrorMessage(err),
        durationMs: Date.now() - start,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
  },
};

// ── SSRF protection ───────────────────────────────────────────────────────

const PRIVATE_IP_PREFIXES = [
  "10.",
  "172.16.", "172.17.", "172.18.", "172.19.",
  "172.20.", "172.21.", "172.22.", "172.23.",
  "172.24.", "172.25.", "172.26.", "172.27.",
  "172.28.", "172.29.", "172.30.", "172.31.",
  "192.168.",
  "169.254.",
  "127.",
  "0.",
];

function isPrivateHost(hostname: string): boolean {
  // Block localhost variants
  if (hostname === "localhost" || hostname === "[::1]") return true;

  // Block private IPv4 ranges
  for (const prefix of PRIVATE_IP_PREFIXES) {
    if (hostname.startsWith(prefix)) return true;
  }

  // Block IPv6 loopback and link-local
  if (hostname.startsWith("[fe80:") || hostname.startsWith("[fc") || hostname.startsWith("[fd")) {
    return true;
  }

  return false;
}
