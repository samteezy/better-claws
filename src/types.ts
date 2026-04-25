// ── Capabilities ──────────────────────────────────────────────────────────────

export const CAPABILITIES = [
  "fs:read",
  "fs:write",
  "fs:delete",
  "net:outbound",
  "net:listen",
  "exec:shell",
  "exec:subprocess",
  "browser:navigate",
  "browser:input",
  "memory:read",
  "memory:write",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const capabilitySet: ReadonlySet<string> = new Set(CAPABILITIES);

export function isCapability(value: string): value is Capability {
  return capabilitySet.has(value);
}

// ── Messages ──────────────────────────────────────────────────────────────────

export interface InboundMessage {
  readonly id: string;
  readonly adapterId: string;
  readonly channelId: string;
  readonly senderId: string;
  readonly text: string;
  readonly timestamp: number;
  readonly raw?: unknown;
}

export interface OutboundMessage {
  readonly channelId: string;
  readonly text: string;
  readonly timestamp?: number;
  readonly metadata?: Record<string, unknown>;
}

// ── Channel Adapters ──────────────────────────────────────────────────────────

export interface ChannelAdapter {
  readonly id: string;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(callback: (msg: InboundMessage) => void): void;
  send(channelId: string, message: OutboundMessage): Promise<void>;
}

// ── LLM ───────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_calls?: readonly ToolCall[];
  readonly tool_call_id?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface LlmResponse {
  readonly message: ChatMessage;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
  };
  readonly raw: unknown;
}

export interface ToolCallStreamDelta {
  readonly index: number;
  readonly id?: string;
  readonly type?: "function";
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

export interface LlmStreamChunk {
  readonly delta: string;
  readonly reasoningDelta?: string;
  readonly toolCallDeltas?: readonly ToolCallStreamDelta[];
  readonly done: boolean;
  readonly usage?: { readonly promptTokens: number; readonly completionTokens: number };
}

// ── Streaming ────────────────────────────────────────────────────────────────

export type StreamEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "reasoning-delta"; readonly delta: string }
  | { readonly type: "tool-start"; readonly toolCall: ToolCall }
  | { readonly type: "tool-result"; readonly toolName: string; readonly output: unknown; readonly error?: string }
  | { readonly type: "confirmation-prompt"; readonly toolName: string; readonly params: string }
  | { readonly type: "warning"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "reset" }
  | { readonly type: "done"; readonly text: string; readonly reasoning?: string; readonly usage: { readonly promptTokens: number; readonly completionTokens: number }; readonly context?: { readonly estimatedTokens: number; readonly actualTokens?: number; readonly budget: number } };

export interface StreamableChannelAdapter extends ChannelAdapter {
  sendStream(channelId: string, response: StreamableResponse): Promise<void>;
}

export function isStreamableAdapter(adapter: ChannelAdapter): adapter is StreamableChannelAdapter {
  return "sendStream" in adapter && typeof (adapter as Record<string, unknown>)["sendStream"] === "function";
}

// Forward-declared to avoid circular imports; implementation in src/router/streamable-response.ts.
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface StreamableResponse {
  readonly stream: AsyncIterable<StreamEvent>;
  readonly text: Promise<string>;
  readonly reasoning: Promise<string | undefined>;
  readonly usage: Promise<{ readonly promptTokens: number; readonly completionTokens: number }>;
  readonly warnings: Promise<readonly string[]>;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly capabilities: readonly Capability[];
  readonly secrets?: readonly string[];
}

export interface ToolHandler {
  execute(
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult>;
}

export interface ToolResult {
  readonly success: boolean;
  readonly output: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly warnings?: readonly string[];
}

export interface ExecutionContext {
  readonly sessionId: string;
  readonly capabilities: readonly Capability[];
  readonly scratchDir: string;
  readonly timeout: number;
  readonly secrets: ReadonlyMap<string, string>;
  readonly allowedFsRoots?: readonly string[];
  readonly scheduler?: import("./scheduler/scheduler.js").Scheduler;
  readonly signal?: AbortSignal;
}

export interface BuiltInToolModule {
  readonly descriptor: ToolDescriptor;
  readonly handler: ToolHandler;
  /** Absolute path to the compiled handler file. When set, ForkedExecutor can run this tool in a child process. */
  readonly handlerPath?: string;
}

// ── Capability Gate ───────────────────────────────────────────────────────────

export type GrantScope = "session" | "persistent";

export interface GateDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly missingCapabilities: readonly Capability[];
  readonly grantScope?: GrantScope;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface SessionState {
  readonly id: string;
  readonly adapterId: string;
  readonly channelId: string;
  readonly senderId: string;
  readonly createdAt: number;
  lastActivityAt: number;
  readonly capabilityGrants: Map<string, GrantScope>;
  readonly toolPolicyOverrides: Map<string, ToolPolicy>;
}

// ── Confirmation ─────────────────────────────────────────────────────────────

export type ConfirmationVerdict = "allow" | "allow-session" | "deny";

export interface ConfirmationResult {
  readonly verdict: ConfirmationVerdict;
  readonly reason: string;
}

// ── Logging ───────────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
  "message:inbound",
  "message:outbound",
  "llm:request",
  "llm:response",
  "tool:invoke",
  "tool:warning",
  "tool:error",
  "gate:decision",
  "executor:start",
  "executor:result",
  "executor:timeout",
  "memory:read",
  "memory:write",
  "memory:curation",
  "session:create",
  "session:idle",
  "session:close",
  "session:destroy",
  "session:recover",
  "session:compaction",
  "session:fork",
  "session:list",
  "config:change",
  "suggestion:generated",
  "suggestion:status",
  "secret:access",
  "secret:register",
  "secret:revoke",
  "session:stop",
  "message:queue",
  "confirmation:request",
  "confirmation:result",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface LogEntry {
  readonly timestamp: string;
  readonly sessionId: string | null;
  readonly eventType: EventType;
  readonly component: string;
  readonly payload: Record<string, unknown>;
}

// ── JSON Schema (minimal recursive type) ──────────────────────────────────────

export interface JsonSchema {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly [key: string]: unknown;
}

// ── Configuration ─────────────────────────────────────────────────────────────

export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
}

export interface WeakLlmConfig {
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly weak?: WeakLlmConfig;
}

export interface AdapterConfig {
  readonly enabled: boolean;
  readonly token?: string;
  readonly secret?: string;
  // Signal
  readonly apiUrl?: string;
  readonly number?: string;
  // Webhook
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  /** Adapter-specific system prompt augmentation (e.g., formatting or length constraints). */
  readonly systemPrompt?: string;
}

export interface SecurityConfig {
  readonly defaultCapabilityPolicy: "deny" | "allow";
  readonly sandboxTimeout: number;
  readonly stripEnvironment: boolean;
  readonly allowPersistentGrants: boolean;
  readonly maxMemoryMb?: number;
  readonly autoGrantCapabilities?: readonly string[];
  readonly allowedFsRoots?: readonly string[];
  readonly confirmationTimeoutMs?: number;
  /** Run file-backed tools in isolated child processes via ForkedExecutor. Default: true. */
  readonly useForkedExecution?: boolean;
}

export interface MemoryConfig {
  readonly maxLongTermEntries: number;
  readonly confidenceDecayRate: number;
  readonly staleThreshold: number;
  readonly curationIntervalMinutes: number;
  readonly curationEnabled: boolean;
  readonly workingMemoryBudgetChars: number;
}

export interface LoggingConfig {
  readonly directory: string;
  readonly redactSensitive: boolean;
  readonly retentionDays: number;
}

export interface DashboardConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly authToken?: string;
}

/** Per-tool access policy: auto-execute, require user confirmation, or fully disabled. */
export type ToolPolicy = "auto" | "confirm" | "disabled";

export interface McpServerStdioConfig {
  readonly transport?: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly capabilities?: readonly Capability[];
  readonly defaultPolicy?: ToolPolicy;
}

export interface McpServerHttpConfig {
  readonly transport: "sse" | "streamable-http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly capabilities?: readonly Capability[];
  readonly defaultPolicy?: ToolPolicy;
}

export type McpServerConfig = McpServerStdioConfig | McpServerHttpConfig;

export interface SkillConfig {
  readonly path: string;
  readonly enabled?: boolean;
  readonly defaultPolicy?: ToolPolicy;
}

export interface ToolsConfig {
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly skills?: Readonly<Record<string, SkillConfig>>;
  readonly toolPolicies?: Readonly<Record<string, ToolPolicy>>;
}


export interface CompactionConfig {
  readonly enabled: boolean;
  /** Total context budget to measure against. Should match llm.maxTokens or less. */
  readonly tokenBudget: number;
  /** Tokens of headroom to reserve before triggering auto-compaction. Default: 512. */
  readonly reserveTokens: number;
  /** Tokens of recent history to preserve during compaction. Default: 1000. */
  readonly keepRecentTokens: number;
}

export interface SystemContextConfig {
  /** AI personality / soul text, always injected into the system prompt. */
  readonly persona?: string;
  /** Static information about the user (name, location, preferences, etc.). */
  readonly userContext?: string;
  /** IANA timezone string. Defaults to "UTC". */
  readonly timezone?: string;
}

export interface SuggestionsConfig {
  readonly enabled: boolean;
  /** How often to run the suggestion worker, in minutes. */
  readonly intervalMinutes: number;
  /** Maximum LLM calls per suggestion cycle. */
  readonly maxLlmCallsPerCycle: number;
}

export type SuggestionCategory =
  | "persona"
  | "user-context"
  | "tools"
  | "integration"
  | "workflow"
  | "general";

export type SuggestionStatus = "pending" | "accepted" | "dismissed";

export interface Suggestion {
  readonly id: string;
  readonly category: SuggestionCategory;
  readonly title: string;
  readonly body: string;
  status: SuggestionStatus;
  readonly createdAt: number;
  updatedAt: number;
}

export interface BetterClawsConfig {
  readonly gateway: GatewayConfig;
  readonly llm: LlmConfig;
  readonly adapters: Readonly<Record<string, AdapterConfig>>;
  readonly security: SecurityConfig;
  readonly memory: MemoryConfig;
  readonly logging: LoggingConfig;
  readonly dashboard?: DashboardConfig;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly tools?: ToolsConfig;
  readonly compaction?: CompactionConfig;
  readonly systemContext?: SystemContextConfig;
  readonly suggestions?: SuggestionsConfig;
  readonly schedules?: readonly import("./scheduler/scheduler.js").ScheduleDefinition[];
}

// ── Memory ────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  readonly id: string;
  readonly category: "fact" | "preference" | "project" | "entity" | "procedure";
  readonly content: string;
  readonly sourceSessions: readonly string[];
  readonly created: number;
  lastAccessed: number;
  confidence: number;
  readonly supersedes?: string;
  readonly tags: readonly string[];
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class BetterClawsError extends Error {
  constructor(
    message: string,
    readonly component: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BetterClawsError";
  }
}

/**
 * Factory for creating standard BetterClawsError subclasses.
 * Each produced class has a fixed component name and default error code.
 */
export function createErrorClass(
  name: string,
  component: string,
  defaultCode: string,
): new (message: string, code?: string) => BetterClawsError {
  const cls = class extends BetterClawsError {
    constructor(message: string, code: string = defaultCode) {
      super(message, component, code);
      this.name = name;
    }
  };
  return cls;
}

// ── Session Log Entries ───────────────────────────────────────────────────────

export type SessionLogEntry =
  | { readonly type: "inbound"; readonly message: InboundMessage }
  | { readonly type: "outbound"; readonly message: OutboundMessage }
  | { readonly type: "toolCall"; readonly toolCall: ToolCall }
  | { readonly type: "toolResult"; readonly toolName: string; readonly result: ToolResult }
  | {
      readonly type: "compaction";
      readonly summary: string;
      readonly compressedTurnCount: number;
      readonly createdAt: number;
    }
  | {
      readonly type: "fork";
      readonly sourceSessionId: string;
      readonly forkTimestamp: number;
      readonly sourceLineCount: number;
    }
  | {
      readonly type: "memorySnapshot";
      readonly entries: readonly {
        readonly key: string;
        readonly category: "fact" | "goal" | "correction" | "decision";
        readonly content: string;
        readonly createdAt: number;
        readonly updatedAt: number;
      }[];
      readonly snapshotAt: number;
    };
