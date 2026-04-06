import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { BetterClawsError, type BetterClawsConfig } from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import type { SessionManager } from "../sessions/session-manager.js";

export class DashboardError extends BetterClawsError {
  constructor(message: string, code: string = "DASHBOARD_ERROR") {
    super(message, "dashboard", code);
    this.name = "DashboardError";
  }
}

// ── Types for API responses ─────────────────────────────────────────────────

export interface DashboardContext {
  readonly sessionManager: SessionManager;
  readonly logger: StructuredLogger;
  readonly config: BetterClawsConfig;
  readonly logsDirectory: string;
  readonly memoryDirectory?: string;
  readonly toolDescriptors?: readonly { name: string; description: string; capabilities: readonly string[] }[];
  readonly adapterStatuses?: ReadonlyMap<string, { connected: boolean; name: string }>;
}

export interface DashboardServerOptions {
  readonly host?: string;
  readonly port: number;
  readonly context: DashboardContext;
  readonly logger: StructuredLogger;
  /** Directory containing static HTML/CSS/JS files */
  readonly staticDir: string;
  /** Bearer token for API authentication. If omitted, API routes are open. */
  readonly authToken?: string;
}

// ── MIME types ──────────────────────────────────────────────────────────────

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── Server ──────────────────────────────────────────────────────────────────

export class DashboardServer {
  private readonly host: string;
  private readonly port: number;
  private readonly context: DashboardContext;
  private readonly logger: StructuredLogger;
  private readonly staticDir: string;
  private readonly authToken: string | undefined;
  private server: Server | null = null;

  constructor(options: DashboardServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port;
    this.context = options.context;
    this.logger = options.logger;
    this.staticDir = resolve(options.staticDir);
    this.authToken = options.authToken;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.on("error", (err) => {
        reject(new DashboardError(`Failed to start dashboard: ${err.message}`, "SERVER_ERROR"));
      });

      server.listen(this.port, this.host, () => {
        this.server = server;
        this.logger.log({
          sessionId: null,
          eventType: "config:change",
          component: "dashboard",
          payload: { action: "start", host: this.host, port: this.port },
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
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
          component: "dashboard",
          payload: { action: "stop" },
        });
        resolve();
      });
    });
  }

  // ── Request routing ─────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    try {
      // API routes — require authentication when a token is configured
      if (path.startsWith("/api/")) {
        if (!this.authenticate(req)) {
          this.logger.log({
            sessionId: null,
            eventType: "config:change",
            component: "dashboard",
            payload: { action: "auth_failure", path },
          });
          this.sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
        return await this.handleApi(req, res, path, url);
      }

      // Static files
      return await this.serveStatic(res, path);
    } catch (err) {
      this.sendJson(res, 500, {
        error: err instanceof Error ? err.message : "Internal error",
      });
    }
  }

  // ── API handlers ────────────────────────────────────────────────────────

  private async handleApi(
    _req: IncomingMessage,
    res: ServerResponse,
    path: string,
    url: URL,
  ): Promise<void> {
    switch (true) {
      // Sessions
      case path === "/api/sessions":
        return this.handleGetSessions(res);
      case path.startsWith("/api/sessions/") && path.endsWith("/history"):
        return await this.handleGetSessionHistory(res, path);
      case path.startsWith("/api/sessions/") && path.endsWith("/grants"):
        return this.handleGetSessionGrants(res, path);

      // Logs
      case path === "/api/logs":
        return await this.handleGetLogs(res, url);

      // Memory
      case path === "/api/memory":
        return await this.handleGetMemory(res, url);

      // System
      case path === "/api/status":
        return this.handleGetStatus(res);
      case path === "/api/tools":
        return this.handleGetTools(res);
      case path === "/api/config":
        return this.handleGetConfig(res);

      default:
        this.sendJson(res, 404, { error: "API endpoint not found" });
    }
  }

  // ── Session endpoints ─────────────────────────────────────────────────

  private handleGetSessions(res: ServerResponse): void {
    // SessionManager doesn't expose a list method on the interface,
    // but we can use checkIdleSessions to get session state indirectly.
    // For the dashboard, we access the internal sessions via the public API.
    const idle = this.context.sessionManager.checkIdleSessions();
    this.sendJson(res, 200, { sessions: idle, count: idle.length });
  }

  private async handleGetSessionHistory(res: ServerResponse, path: string): Promise<void> {
    // /api/sessions/:id/history
    const parts = path.split("/");
    const sessionId = parts[3];
    if (!sessionId) {
      this.sendJson(res, 400, { error: "Missing session ID" });
      return;
    }

    const history = await this.context.sessionManager.getHistory(sessionId);
    this.sendJson(res, 200, { sessionId, history, count: history.length });
  }

  private handleGetSessionGrants(res: ServerResponse, path: string): void {
    const parts = path.split("/");
    const sessionId = parts[3];
    if (!sessionId) {
      this.sendJson(res, 400, { error: "Missing session ID" });
      return;
    }

    const grants = this.context.sessionManager.getGrants(sessionId);
    const grantsObj: Record<string, string> = {};
    for (const [cap, scope] of grants) {
      grantsObj[cap] = scope;
    }
    this.sendJson(res, 200, { sessionId, grants: grantsObj });
  }

  // ── Log endpoints ───────────────────────────────────────────────────────

  private async handleGetLogs(res: ServerResponse, url: URL): Promise<void> {
    const eventType = url.searchParams.get("eventType");
    const sessionId = url.searchParams.get("sessionId");
    const component = url.searchParams.get("component");
    const search = url.searchParams.get("search");
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    // Read today's log file
    const today = new Date().toISOString().slice(0, 10);
    const logPath = join(this.context.logsDirectory, `${today}.jsonl`);

    let lines: string[];
    try {
      const content = await readFile(logPath, "utf-8");
      lines = content.trim().split("\n").filter(Boolean);
    } catch {
      lines = [];
    }

    // Parse and filter
    let entries: unknown[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;

        if (eventType && entry["eventType"] !== eventType) continue;
        if (sessionId && entry["sessionId"] !== sessionId) continue;
        if (component && entry["component"] !== component) continue;
        if (search) {
          const lineStr = line.toLowerCase();
          if (!lineStr.includes(search.toLowerCase())) continue;
        }

        entries.push(entry);
      } catch {
        continue;
      }
    }

    const total = entries.length;
    entries = entries.slice(offset, offset + limit);

    this.sendJson(res, 200, { logs: entries, total, limit, offset });
  }

  // ── Memory endpoints ──────────────────────────────────────────────────

  private async handleGetMemory(res: ServerResponse, url: URL): Promise<void> {
    if (!this.context.memoryDirectory) {
      this.sendJson(res, 200, { entries: [], total: 0 });
      return;
    }

    const category = url.searchParams.get("category");
    const minConfidence = parseFloat(url.searchParams.get("minConfidence") ?? "0");
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);

    const memoryPath = join(this.context.memoryDirectory, "entries.jsonl");

    let lines: string[];
    try {
      const content = await readFile(memoryPath, "utf-8");
      lines = content.trim().split("\n").filter(Boolean);
    } catch {
      lines = [];
    }

    let entries: unknown[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (category && entry["category"] !== category) continue;
        if (typeof entry["confidence"] === "number" && entry["confidence"] < minConfidence) continue;
        entries.push(entry);
      } catch {
        continue;
      }
    }

    const total = entries.length;
    entries = entries.slice(0, limit);

    this.sendJson(res, 200, { entries, total, limit });
  }

  // ── System endpoints ──────────────────────────────────────────────────

  private handleGetStatus(res: ServerResponse): void {
    const adapters: Record<string, { connected: boolean; name: string }> = {};
    if (this.context.adapterStatuses) {
      for (const [id, status] of this.context.adapterStatuses) {
        adapters[id] = status;
      }
    }

    this.sendJson(res, 200, {
      status: "running",
      uptime: process.uptime(),
      adapters,
      memoryUsage: process.memoryUsage(),
    });
  }

  private handleGetTools(res: ServerResponse): void {
    this.sendJson(res, 200, {
      tools: this.context.toolDescriptors ?? [],
    });
  }

  private handleGetConfig(res: ServerResponse): void {
    // Redact secrets from config before sending
    const config = JSON.parse(JSON.stringify(this.context.config)) as Record<string, unknown>;
    this.redactSecrets(config);
    this.sendJson(res, 200, { config });
  }

  // ── Static file serving ───────────────────────────────────────────────

  private async serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
    const filePath = urlPath === "/" ? "/index.html" : urlPath;

    // Prevent path traversal — resolve and verify the path stays within staticDir
    const fullPath = resolve(this.staticDir, filePath.slice(1));
    if (!fullPath.startsWith(this.staticDir)) {
      this.sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    const ext = extname(fullPath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    try {
      const content = await readFile(fullPath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch {
      // Fallback to index.html for SPA-style routing
      try {
        const index = await readFile(join(this.staticDir, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(index);
      } catch {
        this.sendJson(res, 404, { error: "Not found" });
      }
    }
  }

  // ── Authentication ────────────────────────────────────────────────

  private authenticate(req: IncomingMessage): boolean {
    if (!this.authToken) return true; // no token configured — open access

    const header = req.headers["authorization"];
    if (!header || !header.startsWith("Bearer ")) return false;

    const token = header.slice(7);
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(this.authToken);

    if (tokenBuf.byteLength !== expectedBuf.byteLength) return false;
    return timingSafeEqual(tokenBuf, expectedBuf);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private redactSecrets(obj: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string" && value.startsWith("env:")) {
        obj[key] = "[REDACTED]";
      } else if (
        typeof value === "string" &&
        /^(apikey|api_key|token|secret|password|credential)$/i.test(key)
      ) {
        obj[key] = "[REDACTED]";
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        this.redactSecrets(value as Record<string, unknown>);
      }
    }
  }
}
