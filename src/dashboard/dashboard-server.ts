import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { createErrorClass, type BetterClawsConfig, type ToolPolicy } from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { saveConfig } from "../config.js";
import { authenticateBearer, readBody } from "../utils/http.js";
import { workingMemoryRegistry } from "../tools/built-in/memory.js";

export const DashboardError = createErrorClass("DashboardError", "dashboard", "DASHBOARD_ERROR");

// ── Types for API responses ─────────────────────────────────────────────────

export interface DashboardAdapterInfo {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly type: "polling" | "websocket" | "http-server" | "internal";
  readonly connected: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly url?: string;
}

export interface DashboardToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly source: "built-in" | "plugin" | "mcp" | "skill";
}

export interface DashboardContext {
  readonly sessionManager: SessionManager;
  readonly logger: StructuredLogger;
  config: BetterClawsConfig;
  readonly logsDirectory: string;
  readonly memoryDirectory?: string;
  readonly toolDescriptors?: readonly DashboardToolDescriptor[];
  readonly adapterStatuses?: ReadonlyMap<string, { connected: boolean; name: string }>;
  readonly adapterInfos?: readonly DashboardAdapterInfo[];
  /** Path to the config file on disk. Required for config save operations. */
  readonly configPath?: string;
  /** Raw config as read from disk (with env: references intact). Used for saving. */
  rawConfig?: Record<string, unknown>;
  /** Scheduler instance for schedule management. */
  readonly scheduler?: import("../scheduler/scheduler.js").Scheduler;
  /** Long-term memory store instance for memory management. */
  readonly longTermStore?: import("../memory/long-term-store.js").LongTermStore;
  /** Suggestion store for managing auto-suggestions. */
  readonly suggestionStore?: import("../suggestions/suggestion-store.js").SuggestionStore;
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

// ── Config schema metadata ────────────────────────────────────────────────

interface ConfigFieldSchema {
  readonly key: string;
  readonly label: string;
  readonly type: "text" | "number" | "boolean" | "select" | "textarea" | "password";
  readonly description: string;
  readonly options?: readonly string[];
  readonly placeholder?: string;
  readonly restart?: boolean;
}

interface ConfigSectionSchema {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly fields: readonly ConfigFieldSchema[];
}

const CONFIG_SCHEMA_SECTIONS: readonly ConfigSectionSchema[] = [
  {
    key: "gateway",
    label: "Gateway",
    description: "Network binding for the internal gateway server.",
    fields: [
      { key: "host", label: "Host", type: "text", description: "IP address to bind to.", placeholder: "127.0.0.1", restart: true },
      { key: "port", label: "Port", type: "number", description: "Port for the gateway server.", placeholder: "18700", restart: true },
    ],
  },
  {
    key: "llm",
    label: "Language Model",
    description: "Primary LLM connection settings. Changes require a restart.",
    fields: [
      { key: "baseUrl", label: "Base URL", type: "text", description: "OpenAI-compatible API endpoint.", placeholder: "http://localhost:11434/v1", restart: true },
      { key: "apiKey", label: "API Key", type: "password", description: "API key for authentication. Use env:VAR_NAME to reference environment variables.", restart: true },
      { key: "model", label: "Model", type: "text", description: "Model identifier to use for inference.", placeholder: "qwen3:8b", restart: true },
      { key: "maxTokens", label: "Max Tokens", type: "number", description: "Maximum tokens per LLM response.", placeholder: "4096" },
      { key: "temperature", label: "Temperature", type: "number", description: "Sampling temperature (0\u20132). Lower = more deterministic.", placeholder: "0.7" },
    ],
  },
  {
    key: "systemContext",
    label: "System Context",
    description: "Personality, user context, and timezone injected into every conversation.",
    fields: [
      { key: "persona", label: "Persona", type: "textarea", description: "AI personality text injected into every system prompt. Defines how the bot speaks and behaves.", placeholder: "You are a helpful assistant..." },
      { key: "userContext", label: "User Context", type: "textarea", description: "Static information about the user (name, preferences, location) included in prompts.", placeholder: "The user is..." },
      { key: "timezone", label: "Timezone", type: "text", description: "IANA timezone string for time-aware tasks.", placeholder: "UTC" },
    ],
  },
  {
    key: "security",
    label: "Security",
    description: "Capability gate and sandbox settings controlling what the bot can do.",
    fields: [
      { key: "defaultCapabilityPolicy", label: "Default Policy", type: "select", description: "Default action when no specific capability grant exists.", options: ["deny", "allow"] },
      { key: "sandboxTimeout", label: "Sandbox Timeout (ms)", type: "number", description: "Maximum execution time for sandboxed tool calls.", placeholder: "30000" },
      { key: "stripEnvironment", label: "Strip Environment", type: "boolean", description: "Remove environment variables from sandboxed processes for security." },
      { key: "allowPersistentGrants", label: "Allow Persistent Grants", type: "boolean", description: "Whether capability grants can persist across sessions." },
      { key: "maxMemoryMb", label: "Max Memory (MB)", type: "number", description: "Memory limit for sandboxed processes.", placeholder: "128" },
    ],
  },
  {
    key: "memory",
    label: "Memory",
    description: "Long-term memory storage, confidence decay, and curation settings.",
    fields: [
      { key: "maxLongTermEntries", label: "Max Entries", type: "number", description: "Maximum number of long-term memory entries to retain.", placeholder: "2000" },
      { key: "confidenceDecayRate", label: "Decay Rate", type: "number", description: "Rate at which memory confidence decays over time (0\u20131).", placeholder: "0.01" },
      { key: "staleThreshold", label: "Stale Threshold", type: "number", description: "Confidence level below which entries are considered stale.", placeholder: "0.2" },
      { key: "curationIntervalMinutes", label: "Curation Interval (min)", type: "number", description: "How often the background curation worker runs.", placeholder: "60" },
      { key: "curationEnabled", label: "Curation Enabled", type: "boolean", description: "Enable automatic memory curation (distillation, consolidation, decay)." },
    ],
  },
  {
    key: "logging",
    label: "Logging",
    description: "Structured logging output and retention settings.",
    fields: [
      { key: "directory", label: "Log Directory", type: "text", description: "Directory for structured log files.", placeholder: "data/logs", restart: true },
      { key: "redactSensitive", label: "Redact Sensitive", type: "boolean", description: "Automatically redact sensitive values in log output." },
      { key: "retentionDays", label: "Retention (days)", type: "number", description: "Number of days to keep log files before cleanup.", placeholder: "90" },
    ],
  },
  {
    key: "compaction",
    label: "Compaction",
    description: "Context window compaction to manage long conversations.",
    fields: [
      { key: "enabled", label: "Enabled", type: "boolean", description: "Enable automatic context compaction when nearing token limits." },
      { key: "tokenBudget", label: "Token Budget", type: "number", description: "Total context budget. Should match or be less than llm.maxTokens.", placeholder: "3584" },
      { key: "reserveTokens", label: "Reserve Tokens", type: "number", description: "Headroom to reserve before triggering compaction.", placeholder: "512" },
      { key: "keepRecentTokens", label: "Keep Recent Tokens", type: "number", description: "Tokens of recent history to preserve during compaction.", placeholder: "1000" },
    ],
  },
];

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
    const isNetworkExposed = this.host !== "127.0.0.1" && this.host !== "localhost";
    if (isNetworkExposed && !this.authToken) {
      throw new DashboardError(
        "Dashboard cannot bind to a non-loopback address without an authToken configured",
        "UNSAFE_CONFIG",
      );
    }

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
      case path === "/api/sessions/archived" && method === "GET":
        return await this.handleGetArchivedSessions(res);
      case path.startsWith("/api/sessions/") && path.endsWith("/history") && method === "GET":
        return await this.handleGetSessionHistory(res, path);
      case path.startsWith("/api/sessions/") && path.endsWith("/grants") && method === "GET":
        return this.handleGetSessionGrants(res, path);
      case path.startsWith("/api/sessions/") && path.endsWith("/memory") && method === "GET":
        return await this.handleGetSessionMemory(res, path);

      // Logs
      case path === "/api/logs" && method === "GET":
        return await this.handleGetLogs(res, url);

      // Memory
      case path === "/api/memory" && method === "GET":
        return await this.handleGetMemory(res, url);
      case path.startsWith("/api/memory/") && method === "PUT":
        return await this.handleUpdateMemory(req, res, path);
      case path.startsWith("/api/memory/") && method === "DELETE":
        return await this.handleDeleteMemory(res, path);

      // System
      case path === "/api/status" && method === "GET":
        return this.handleGetStatus(res);
      case path === "/api/adapters" && method === "GET":
        return this.handleGetAdapters(res);
      case path === "/api/tools" && method === "GET":
        return this.handleGetTools(res);
      case path === "/api/config" && method === "GET":
        return this.handleGetConfig(res);
      case path === "/api/config/schema" && method === "GET":
        return this.handleGetConfigSchema(res);

      // Tool policy management
      case path === "/api/tools/policy" && method === "POST":
        return await this.handleSetToolPolicy(req, res);

      // Config editing
      case path === "/api/config" && method === "PUT":
        return await this.handleUpdateConfig(req, res);
      case path.startsWith("/api/config/section/") && method === "PUT":
        return await this.handleUpdateConfigSection(req, res, path);

      // Restart
      case path === "/api/restart" && method === "POST":
        return this.handleRestart(res);

      // Schedules
      case path === "/api/schedules" && method === "GET":
        return this.handleGetSchedules(res);
      case path === "/api/schedules" && method === "POST":
        return await this.handleCreateSchedule(req, res);
      case path.startsWith("/api/schedules/") && method === "PUT":
        return await this.handleUpdateSchedule(req, res, path);
      case path.startsWith("/api/schedules/") && method === "DELETE":
        return await this.handleDeleteSchedule(res, path);

      // Suggestions
      case path === "/api/suggestions" && method === "GET":
        return this.handleGetSuggestions(res);
      case path.startsWith("/api/suggestions/") && method === "PUT":
        return await this.handleUpdateSuggestion(req, res, path);
      case path.startsWith("/api/suggestions/") && method === "DELETE":
        return this.handleDeleteSuggestion(res, path);

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

  private async handleGetArchivedSessions(res: ServerResponse): Promise<void> {
    const archived = await this.context.sessionManager.listArchived();
    this.sendJson(res, 200, { sessions: archived, count: archived.length });
  }

  private async handleGetSessionHistory(res: ServerResponse, path: string): Promise<void> {
    // /api/sessions/:id/history
    const parts = path.split("/");
    const sessionId = parts[3];
    if (!sessionId) {
      this.sendJson(res, 400, { error: "Missing session ID" });
      return;
    }

    const history = await this.context.sessionManager.getDetailedHistory(sessionId);
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

  private async handleGetSessionMemory(
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    const parts = path.split("/");
    const sessionId = parts[3];
    if (!sessionId) {
      this.sendJson(res, 400, { error: "Missing session ID" });
      return;
    }

    const wm = workingMemoryRegistry.get(sessionId);
    if (wm) {
      this.sendJson(res, 200, { sessionId, entries: wm.getAll(), live: true });
      return;
    }

    const snapshot = await this.context.sessionManager.getMemorySnapshot(sessionId);
    this.sendJson(res, 200, {
      sessionId,
      entries: snapshot ?? [],
      live: false,
    });
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
    entries.reverse(); // newest first
    entries = entries.slice(offset, offset + limit);

    this.sendJson(res, 200, { logs: entries, total, limit, offset });
  }

  // ── Memory endpoints ──────────────────────────────────────────────────

  private async handleGetMemory(res: ServerResponse, url: URL): Promise<void> {
    const category = url.searchParams.get("category");
    const minConfidence = parseFloat(url.searchParams.get("minConfidence") ?? "0");
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);

    // Prefer live store when available so mutations are immediately visible
    if (this.context.longTermStore) {
      const searchOpts: { category?: string; minConfidence?: number } = {};
      if (category) searchOpts.category = category;
      if (minConfidence > 0) searchOpts.minConfidence = minConfidence;

      const all = this.context.longTermStore.search(
        searchOpts as Parameters<typeof this.context.longTermStore.search>[0],
      );
      const entries = all.slice(0, limit);
      this.sendJson(res, 200, { entries, total: all.length, limit });
      return;
    }

    // Fallback: read from JSONL file on disk
    if (!this.context.memoryDirectory) {
      this.sendJson(res, 200, { entries: [], total: 0 });
      return;
    }

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

  private async handleUpdateMemory(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    if (!this.context.longTermStore) {
      this.sendJson(res, 400, { error: "Memory store is not configured" });
      return;
    }

    const id = path.split("/api/memory/")[1];
    if (!id) {
      this.sendJson(res, 400, { error: "Missing memory entry ID" });
      return;
    }

    const body = await this.readRequestBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    try {
      const patch: Record<string, unknown> = {};
      if (body["content"] !== undefined) patch["content"] = String(body["content"]);
      if (body["confidence"] !== undefined) patch["confidence"] = Number(body["confidence"]);
      if (body["tags"] !== undefined) patch["tags"] = body["tags"];

      const updated = await this.context.longTermStore.update(
        id,
        patch as Partial<Pick<import("../types.js").MemoryEntry, "content" | "confidence" | "tags">>,
      );

      this.sendJson(res, 200, updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes("not found") ? 404 : 400;
      this.sendJson(res, status, { error: msg });
    }
  }

  private async handleDeleteMemory(
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    if (!this.context.longTermStore) {
      this.sendJson(res, 400, { error: "Memory store is not configured" });
      return;
    }

    const id = path.split("/api/memory/")[1];
    if (!id) {
      this.sendJson(res, 400, { error: "Missing memory entry ID" });
      return;
    }

    const removed = await this.context.longTermStore.delete(id);
    if (!removed) {
      this.sendJson(res, 404, { error: `Memory entry "${id}" not found` });
      return;
    }

    this.sendJson(res, 200, { success: true });
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

  private handleGetAdapters(res: ServerResponse): void {
    this.sendJson(res, 200, { adapters: this.context.adapterInfos ?? [] });
  }

  private handleGetTools(res: ServerResponse): void {
    const policies = this.context.config.tools?.toolPolicies ?? {};
    const tools = (this.context.toolDescriptors ?? []).map(t => ({
      ...t,
      policy: policies[t.name] ?? "auto",
    }));
    this.sendJson(res, 200, { tools });
  }

  private handleGetConfigSchema(_res: ServerResponse): void {
    this.sendJson(_res, 200, { sections: CONFIG_SCHEMA_SECTIONS });
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

  private async handleUpdateConfigSection(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const sectionKey = path.replace("/api/config/section/", "");
    if (!sectionKey || sectionKey.includes("/")) {
      this.sendJson(res, 400, { error: "Invalid section key" });
      return;
    }

    const body = await this.readRequestBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      this.sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    // Merge section into config
    const currentSection = (this.context.config as unknown as Record<string, unknown>)[sectionKey];
    const merged = typeof currentSection === "object" && currentSection !== null && !Array.isArray(currentSection)
      ? { ...currentSection as Record<string, unknown>, ...body }
      : body;

    try {
      await this.persistConfig({ [sectionKey]: merged });
    } catch (err) {
      this.sendJson(res, 500, {
        error: `Failed to save config: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    // Update in-memory config
    (this.context.config as unknown as Record<string, unknown>)[sectionKey] = merged;

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "dashboard",
      payload: { action: "config_section_updated", section: sectionKey },
    });

    this.sendJson(res, 200, { saved: true, section: sectionKey, note: "Some changes may require a restart to take effect." });
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

  // ── Restart endpoint ─────────────────────────────────────────────────

  private handleRestart(res: ServerResponse): void {
    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "dashboard",
      payload: { action: "restart_requested" },
    });

    this.sendJson(res, 200, { restarting: true });

    // Give the response time to flush before exiting
    setTimeout(() => process.exit(0), 500);
  }

  // ── Schedule endpoints ────────────────────────────────────────────────

  private handleGetSchedules(res: ServerResponse): void {
    if (!this.context.scheduler) {
      this.sendJson(res, 200, []);
      return;
    }

    const schedules = this.context.scheduler.getAll().map((s) => {
      const nextFire = s.id ? this.context.scheduler!.getNextFireTime(s.id) : null;
      return {
        id: s.id,
        name: s.name,
        cron: s.cron,
        prompt: s.prompt,
        enabled: s.enabled !== false,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        nextFireTime: nextFire?.toISOString() ?? null,
      };
    });

    this.sendJson(res, 200, schedules);
  }

  private async handleCreateSchedule(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.context.scheduler) {
      this.sendJson(res, 400, { error: "Scheduling is not configured" });
      return;
    }

    const body = await this.readRequestBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: "Invalid request body" });
      return;
    }

    const { name, cron, prompt, enabled } = body as {
      name?: string; cron?: string; prompt?: string; enabled?: boolean;
    };

    if (!name || !cron || !prompt) {
      this.sendJson(res, 400, { error: "Missing required fields: name, cron, prompt" });
      return;
    }

    try {
      const id = await this.context.scheduler.addSchedule({
        name: String(name),
        cron: String(cron),
        prompt: String(prompt),
        enabled: enabled !== false,
      });

      const created = this.context.scheduler.getSchedule(id);
      this.sendJson(res, 201, { id, ...created });
    } catch (err) {
      this.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleUpdateSchedule(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    if (!this.context.scheduler) {
      this.sendJson(res, 400, { error: "Scheduling is not configured" });
      return;
    }

    const id = path.split("/api/schedules/")[1];
    if (!id) {
      this.sendJson(res, 400, { error: "Missing schedule ID" });
      return;
    }

    const body = await this.readRequestBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: "Invalid request body" });
      return;
    }

    try {
      const updated = await this.context.scheduler.updateSchedule(id, {
        ...(body["name"] !== undefined ? { name: String(body["name"]) } : {}),
        ...(body["cron"] !== undefined ? { cron: String(body["cron"]) } : {}),
        ...(body["prompt"] !== undefined ? { prompt: String(body["prompt"]) } : {}),
        ...(body["enabled"] !== undefined ? { enabled: Boolean(body["enabled"]) } : {}),
      });
      this.sendJson(res, 200, updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes("not found") ? 404 : 400;
      this.sendJson(res, status, { error: msg });
    }
  }

  private async handleDeleteSchedule(res: ServerResponse, path: string): Promise<void> {
    if (!this.context.scheduler) {
      this.sendJson(res, 400, { error: "Scheduling is not configured" });
      return;
    }

    const id = path.split("/api/schedules/")[1];
    if (!id) {
      this.sendJson(res, 400, { error: "Missing schedule ID" });
      return;
    }

    const removed = await this.context.scheduler.removeSchedule(id);
    if (!removed) {
      this.sendJson(res, 404, { error: `Schedule "${id}" not found` });
      return;
    }

    this.sendJson(res, 200, { success: true });
  }

  // ── Suggestion endpoints ───────────────────────────────────────────────

  private handleGetSuggestions(res: ServerResponse): void {
    if (!this.context.suggestionStore) {
      this.sendJson(res, 200, { suggestions: [] });
      return;
    }

    const suggestions = this.context.suggestionStore.getAll()
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt);

    this.sendJson(res, 200, { suggestions });
  }

  private async handleUpdateSuggestion(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!this.context.suggestionStore) {
      this.sendJson(res, 400, { error: "Suggestions not configured" });
      return;
    }

    const id = path.split("/api/suggestions/")[1];
    if (!id) {
      this.sendJson(res, 400, { error: "Missing suggestion ID" });
      return;
    }

    const body = await this.readRequestBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: "Invalid request body" });
      return;
    }

    const status = body["status"] as string | undefined;
    const validStatuses = ["pending", "accepted", "dismissed"];
    if (!status || !validStatuses.includes(status)) {
      this.sendJson(res, 400, { error: `"status" must be one of: ${validStatuses.join(", ")}` });
      return;
    }

    const updated = this.context.suggestionStore.updateStatus(id, status as "pending" | "accepted" | "dismissed");
    if (!updated) {
      this.sendJson(res, 404, { error: `Suggestion "${id}" not found` });
      return;
    }

    await this.context.suggestionStore.persist();
    this.sendJson(res, 200, { suggestion: updated });
  }

  private handleDeleteSuggestion(res: ServerResponse, path: string): void {
    if (!this.context.suggestionStore) {
      this.sendJson(res, 400, { error: "Suggestions not configured" });
      return;
    }

    const id = path.split("/api/suggestions/")[1];
    if (!id) {
      this.sendJson(res, 400, { error: "Missing suggestion ID" });
      return;
    }

    const deleted = this.context.suggestionStore.delete(id);
    if (!deleted) {
      this.sendJson(res, 404, { error: `Suggestion "${id}" not found` });
      return;
    }

    void this.context.suggestionStore.persist();
    this.sendJson(res, 200, { success: true });
  }

  // ── Request body parsing ────────────────────────────────────────────────

  private async readRequestBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
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
    return authenticateBearer(req, this.authToken);
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
