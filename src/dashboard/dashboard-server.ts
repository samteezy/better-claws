import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { BetterClawsError, type BetterClawsConfig, type ToolPolicy } from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { saveConfig } from "../config.js";

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
  config: BetterClawsConfig;
  readonly logsDirectory: string;
  readonly memoryDirectory?: string;
  readonly toolDescriptors?: readonly { name: string; description: string; capabilities: readonly string[] }[];
  readonly adapterStatuses?: ReadonlyMap<string, { connected: boolean; name: string }>;
  /** Path to the config file on disk. Required for config save operations. */
  readonly configPath?: string;
  /** Raw config as read from disk (with env: references intact). Used for saving. */
  rawConfig?: Record<string, unknown>;
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
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    url: URL,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();

    switch (true) {
      // Sessions
      case path === "/api/sessions" && method === "GET":
        return this.handleGetSessions(res);
      case path.startsWith("/api/sessions/") && path.endsWith("/history") && method === "GET":
        return await this.handleGetSessionHistory(res, path);
      case path.startsWith("/api/sessions/") && path.endsWith("/grants") && method === "GET":
        return this.handleGetSessionGrants(res, path);

      // Logs
      case path === "/api/logs" && method === "GET":
        return await this.handleGetLogs(res, url);

      // Memory
      case path === "/api/memory" && method === "GET":
        return await this.handleGetMemory(res, url);

      // System
      case path === "/api/status" && method === "GET":
        return this.handleGetStatus(res);
      case path === "/api/tools" && method === "GET":
        return this.handleGetTools(res);
      case path === "/api/config" && method === "GET":
        return this.handleGetConfig(res);

      // Tool policy management
      case path === "/api/tools/policy" && method === "POST":
        return await this.handleSetToolPolicy(req, res);

      // Config editing
      case path === "/api/config" && method === "PUT":
        return await this.handleUpdateConfig(req, res);

      default:
        this.sendJson(res, 404, { error: "API endpoint not found" });
    }
  }

  // ── Session endpoints ─────────────────────────────────────────────────

  private handleGetSessions(res: ServerResponse): void {
    const sessions = this.context.sessionManager.list().map((s) => ({
      id: s.id,
      adapterId: s.state.adapterId,
      channelId: s.state.channelId,
      senderId: s.state.senderId,
      createdAt: s.state.createdAt,
      lastActivityAt: s.state.lastActivityAt,
    }));
    this.sendJson(res, 200, { sessions, count: sessions.length });
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
    const policies = this.context.config.tools?.toolPolicies ?? {};
    const tools = (this.context.toolDescriptors ?? []).map(t => ({
      ...t,
      policy: policies[t.name] ?? "auto",
    }));
    this.sendJson(res, 200, { tools });
  }

  private handleGetConfig(res: ServerResponse): void {
    // Redact secrets from config before sending
    const config = JSON.parse(JSON.stringify(this.context.config)) as Record<string, unknown>;
    this.redactSecrets(config);
    this.sendJson(res, 200, { config });
  }

  // ── Tool policy management ─────────────────────────────────────────────

  private async handleSetToolPolicy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readRequestBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const toolName = body["tool"];
    const policy = body["policy"];

    if (typeof toolName !== "string" || toolName.length === 0) {
      this.sendJson(res, 400, { error: 'Missing required field: "tool"' });
      return;
    }

    const validPolicies: readonly ToolPolicy[] = ["auto", "confirm", "disabled"];
    if (typeof policy !== "string" || !validPolicies.includes(policy as ToolPolicy)) {
      this.sendJson(res, 400, { error: `"policy" must be one of: ${validPolicies.join(", ")}` });
      return;
    }

    // Update in-memory config
    const currentPolicies = { ...(this.context.config.tools?.toolPolicies ?? {}) };
    if (policy === "auto") {
      // "auto" is the default — remove the entry to keep config clean
      delete currentPolicies[toolName];
    } else {
      currentPolicies[toolName] = policy as ToolPolicy;
    }

    this.context.config = {
      ...this.context.config,
      tools: {
        ...this.context.config.tools,
        toolPolicies: currentPolicies,
      },
    };

    // Persist to disk
    await this.persistConfig({ tools: { ...this.context.config.tools, toolPolicies: currentPolicies } });

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "dashboard",
      payload: { action: "set_tool_policy", tool: toolName, policy },
    });

    this.sendJson(res, 200, { tool: toolName, policy });
  }

  // ── Config editing ──────────────────────────────────────────────────────

  private async handleUpdateConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readRequestBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    // Validate it's a plain object
    if (typeof body !== "object" || Array.isArray(body)) {
      this.sendJson(res, 400, { error: "Config must be a JSON object" });
      return;
    }

    // Persist the full raw config to disk
    try {
      await this.persistConfig(body);
    } catch (err) {
      this.sendJson(res, 500, {
        error: `Failed to save config: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "dashboard",
      payload: { action: "config_updated" },
    });

    this.sendJson(res, 200, { saved: true, note: "Some changes may require a restart to take effect." });
  }

  // ── Config persistence helper ───────────────────────────────────────────

  private async persistConfig(updates: Record<string, unknown>): Promise<void> {
    if (!this.context.rawConfig) {
      throw new DashboardError("No raw config available for saving", "NO_RAW_CONFIG");
    }

    // Merge updates into raw config
    for (const [key, value] of Object.entries(updates)) {
      this.context.rawConfig[key] = value;
    }

    await saveConfig(this.context.rawConfig, this.context.configPath);
  }

  // ── Request body parsing ────────────────────────────────────────────────

  private readRequestBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const maxSize = 1024 * 1024; // 1MB

      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxSize) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf-8");
          const parsed = JSON.parse(raw) as unknown;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            resolve(parsed as Record<string, unknown>);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });

      req.on("error", () => resolve(null));
    });
  }

  // ── Static file serving ───────────────────────────────────────────────

  private async serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
    const filePath = urlPath === "/" ? "/index.html" : urlPath;

    // Prevent path traversal — resolve and verify the path stays within staticDir
    const fullPath = resolve(this.staticDir, filePath.slice(1));
    const safePrefix = this.staticDir.endsWith("/") ? this.staticDir : this.staticDir + "/";
    if (fullPath !== this.staticDir && !fullPath.startsWith(safePrefix)) {
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
        /(?:api_?key|token|secret|password|credential|auth)/i.test(key)
      ) {
        obj[key] = "[REDACTED]";
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        this.redactSecrets(value as Record<string, unknown>);
      }
    }
  }
}
