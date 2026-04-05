# CLAUDE.md — betterClaws

> A lightweight, secure, self-hosted personal AI assistant gateway.
> Text your computer from anywhere. It does stuff. Safely.

---

## Philosophy

This project exists because OpenClaw proved the concept but got the trust model backwards. An AI agent with system-level permissions is a weapon pointed at its owner unless the architecture assumes the model is adversarial. betterClaws treats LLM output as untrusted input at every boundary.

### Core Precepts

- **Zero external runtime dependencies.** TypeScript, Node stdlib, nothing else. No supply chain attack surface.
- **Full test coverage.** Every module has unit tests. Integration tests cover the full message→inference→action→response loop.
- **Sandboxed by default.** Nothing executes without explicit capability grants. Default posture is deny-all.
- **Modular and extendable.** Every component implements a typed interface. Swap, extend, or replace any layer.
- **Transparent logging.** Every event — inbound message, LLM call, tool invocation, capability decision — is logged to append-only structured JSONL. Nothing happens silently.
- **Local-first.** State is files. Config is files. Memory is files. No databases, no external services beyond the LLM endpoint.

---

## Architecture Overview

The system is a **message → inference → action → response** pipeline with a capability gate between "what the LLM wants to do" and "what actually happens."

```
Channel Adapters ──→ Message Router ──→ Session Manager ──→ Prompt Builder
                                                                  │
                                              (injects working memory +
                                               retrieved long-term memories)
                                                                  │
                                                                  ▼
                                                             LLM Client
                                                                  │
                                                                  ▼
                                                           Tool Registry
                                                                  │
                                                                  ▼
                                                          Capability Gate
                                                                  │
                                                                  ▼
                                                        Sandboxed Executor
                                                                  │
               Structured Logger ◄────────── (cross-cutting, all components emit)

                                    Background Curation Worker
                                       │            ▲
                             (reads)   │            │  (writes)
                                       ▼            │
                   Session Logs ──→ Long-Term Memory Store
```

---

## Components

### 1. Channel Adapters

Pluggable modules, one per messaging platform. Each implements:

```typescript
interface ChannelAdapter {
  readonly id: string;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(callback: (msg: InboundMessage) => void): void;
  send(channelId: string, message: OutboundMessage): Promise<void>;
}
```

- WhatsApp, Telegram, Discord, Slack, Signal, etc. are all HTTP/WebSocket APIs — native `fetch` handles all of them.
- Each adapter runs as an isolated module loaded via dynamic `import()`.
- No adapter has access to another adapter's credentials or state.
- Adapters normalize platform-specific message formats into a common `InboundMessage` type.

### 2. Message Router

- Receives inbound messages from all adapters.
- Resolves each message to a session (by platform + sender identity).
- Dispatches to the agent loop.
- Handles outbound delivery back through the originating adapter.
- This is the **only** component that touches multiple adapters.

### 3. Session Manager

- Maintains per-conversation state: message history, working memory, tool approval grants, active context.
- State stored as filesystem-backed JSONL (append-only log per session).
- Sessions are the unit of isolation — one session cannot read another's state.
- Sessions have a configurable idle timeout for cleanup and memory distillation.

### 4. Prompt Builder

- Assembles the full LLM prompt for each turn:
  - System prompt (static project instructions + tool declarations)
  - Retrieved long-term memory entries (relevance-scored)
  - Working memory snapshot (current session context)
  - Conversation history (from session log, with configurable window)
  - Current user message
- Enforces a token budget, truncating history from the middle when needed.

### 5. LLM Client

- Thin wrapper around native `fetch` targeting `/v1/chat/completions` (OpenAI-compatible API).
- Config: `{ baseUrl: string; apiKey: string; model: string; }`.
- Supports: OpenAI, Anthropic (via compatible proxy), Ollama, llama.cpp, vLLM, LM Studio, any OpenAI-compatible endpoint.
- Handles streaming via `ReadableStream` parsing of SSE.
- Retry logic with exponential backoff.
- Token counting for budget enforcement.
- All requests and responses logged in full to the structured logger.

### 6. Tool Registry

- Tools are TypeScript modules in a known directory structure (`tools/<name>/`).
- Each tool exports a descriptor and handler:

```typescript
interface ToolDescriptor {
  name: string;
  description: string;
  parameters: JSONSchema;
  capabilities: Capability[];  // e.g., ["fs:read", "fs:write", "net:outbound", "exec:shell"]
}

interface ToolHandler {
  execute(params: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult>;
}
```

- Registry validates tool definitions at load time (schema validation, capability declaration completeness).
- **No remote registry.** Tools are local files you control. Add by dropping a module in the directory.
- Tools are loaded once at startup and hot-reloaded on file change in development mode.

### 7. Capability Gate

The key security differentiator. Sits between tool invocation and execution.

- Every tool declares required capabilities (e.g., `fs:read`, `fs:write`, `net:outbound`, `exec:shell`).
- Before execution, the gate checks if the session has approved grants for the tool's capability set.
- If not, the request is **paused and surfaced to the user** via the originating channel for explicit approval.
- Grants are scoped:
  - `session` — valid for this conversation only (default)
  - `persistent` — remembered across sessions for this tool (opt-in)
- **Default posture: deny all.** No tool runs without a grant.
- All gate decisions (grant, deny, prompt, timeout) are logged.

#### Capability Taxonomy

```
fs:read          — read files from the filesystem
fs:write         — create or modify files
fs:delete        — delete files
net:outbound     — make outbound HTTP/network requests
net:listen       — bind to a network port
exec:shell       — execute shell commands
exec:subprocess  — spawn child processes
browser:navigate — automated browser navigation
browser:input    — automated form filling / interaction
memory:read      — read from long-term memory store
memory:write     — write/update long-term memory entries
```

### 8. Sandboxed Executor

- Tools run in `child_process.fork()` with:
  - Stripped environment variables (no leaked API keys, secrets)
  - `cwd` locked to a per-execution scratch directory
  - Configurable timeout enforcement (default: 30s)
  - stdout/stderr captured to structured logger
- Optional hardening (when host supports it):
  - Node `--experimental-permission` flag for filesystem/network policy
  - Linux `unshare` for namespace isolation
  - `seccomp` profile for syscall filtering
- Executor returns a structured `ToolResult` — never raw process output.

### 9. Structured Logger

- Cross-cutting concern. Every component emits events.
- Append-only JSONL files, one per day, rotated by date.
- Every entry includes: `timestamp`, `sessionId`, `eventType`, `component`, `payload`.
- Event types:

```
message:inbound      — raw message received from adapter
message:outbound     — response sent to adapter
llm:request          — full prompt sent to LLM
llm:response         — full LLM response (including tool calls)
tool:invoke          — tool call requested by LLM
gate:decision        — capability gate grant/deny/prompt
executor:start       — sandboxed execution began
executor:result      — execution completed (with output)
executor:timeout     — execution killed due to timeout
memory:read          — memory retrieval performed
memory:write         — memory entry created/updated
memory:curation      — background worker action
session:create       — new session started
session:idle         — session went idle
config:change        — configuration modified
```

- Sensitive fields (API keys, tokens) are redacted in log output but preserved in a separate encrypted audit log if configured.

---

## Memory System

Three tiers serving different retrieval patterns.

### Tier 1: Conversation Log

- The raw JSONL session files.
- Full fidelity, append-only, never summarized, never mutated.
- Source of truth for provenance.

### Tier 2: Working Memory

- Per-session distilled context injected into the LLM system prompt.
- Structured JSON: key facts, active goals, user corrections, decisions.
- Updated synchronously at end of each agent turn via `memory:update` tool call through the capability gate.
- Size-bounded to stay within prompt budget.

### Tier 3: Long-Term Memory

- Cross-session knowledge. The "knows you" layer.
- Stored as typed entries in a JSONL file:

```typescript
interface MemoryEntry {
  id: string;
  category: "fact" | "preference" | "project" | "entity" | "procedure";
  content: string;
  sourceSessions: string[];    // provenance back to raw logs
  created: number;             // unix timestamp
  lastAccessed: number;
  confidence: number;          // 0-1, decays over time, boosted on re-confirmation
  supersedes?: string;         // id of entry this corrects/replaces
  tags: string[];
}
```

### Memory Retrieval

Prompt builder retrieves relevant long-term memories for each turn using:

1. **Category filtering.** Narrow by category based on message content heuristics.
2. **TF-IDF scoring.** ~100 lines of TypeScript — tokenize, compute term frequencies, rank against inbound message. Fully deterministic, inspectable, zero dependencies.
3. **LLM-assisted re-ranking (optional).** If local scoring yields weak matches, pass top-N candidates to the LLM for semantic ranking. Costs a small inference call.

No vector database. No embeddings service. TF-IDF handles hundreds to low thousands of entries effectively. Upgrade path to local ONNX embeddings exists if needed later without adding runtime deps.

### Background Curation Worker

A timer-driven loop (or separate process) that runs asynchronously:

1. **Session distillation.** When a session goes idle, reads the raw JSONL log and makes an LLM call to extract durable facts, preferences, and decisions as structured memory entries. Links `sourceSessions` for provenance.
2. **Consolidation.** Periodically scans the memory store for overlapping or contradictory entries. Newer entries with higher confidence supersede older ones via the `supersedes` field. Edit history is preserved, never silently mutated.
3. **Confidence decay.** Entries not accessed or re-confirmed decay over time. Below a threshold they're flagged stale and excluded from retrieval (but never deleted).
4. **Size budget enforcement.** Configurable max entry count. When hit, lowest-confidence stale entries are pruned.

The curation worker is the **only** process that makes unsupervised LLM calls. These are:
- Logged distinctly from user-initiated calls (event type `memory:curation`)
- Rate-limited to prevent runaway API cost
- Configurable to run on a schedule or disabled entirely

---

## Directory Structure

```
betterClaws/
├── CLAUDE.md                  # this file
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts               # entry point, wires components
│   ├── config.ts              # configuration loader
│   ├── types.ts               # shared type definitions
│   ├── router/
│   │   └── message-router.ts
│   ├── sessions/
│   │   └── session-manager.ts
│   ├── prompt/
│   │   └── prompt-builder.ts
│   ├── llm/
│   │   └── llm-client.ts
│   ├── tools/
│   │   ├── registry.ts
│   │   ├── capability-gate.ts
│   │   └── executor.ts
│   ├── memory/
│   │   ├── working-memory.ts
│   │   ├── long-term-store.ts
│   │   ├── retrieval.ts       # TF-IDF + category filtering
│   │   └── curation-worker.ts
│   ├── adapters/
│   │   ├── adapter.ts         # base interface
│   │   ├── telegram/
│   │   ├── discord/
│   │   ├── slack/
│   │   └── webhook/           # generic webhook adapter for custom integrations
│   └── logger/
│       └── structured-logger.ts
├── tools/                      # user-defined tool modules
│   ├── shell/
│   │   ├── descriptor.json
│   │   └── handler.ts
│   ├── file-read/
│   │   ├── descriptor.json
│   │   └── handler.ts
│   └── web-fetch/
│       ├── descriptor.json
│       └── handler.ts
├── data/                       # runtime data (gitignored)
│   ├── sessions/              # per-session JSONL logs
│   ├── memory/                # long-term memory store
│   ├── logs/                  # structured event logs
│   └── scratch/               # per-execution sandboxed scratch dirs
├── config/
│   └── betterclaws.json        # user configuration
└── tests/
    ├── unit/
    └── integration/
```

---

## Configuration

Single JSON file at `config/betterclaws.json`:

```json
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 18700
  },
  "llm": {
    "baseUrl": "http://localhost:11434/v1",
    "apiKey": "",
    "model": "qwen3:8b",
    "maxTokens": 4096,
    "temperature": 0.7
  },
  "adapters": {
    "telegram": { "enabled": true, "token": "env:BC_TELEGRAM_TOKEN" },
    "discord": { "enabled": false },
    "webhook": { "enabled": true, "secret": "env:BC_WEBHOOK_SECRET" }
  },
  "security": {
    "defaultCapabilityPolicy": "deny",
    "sandboxTimeout": 30000,
    "stripEnvironment": true,
    "allowPersistentGrants": false
  },
  "memory": {
    "maxLongTermEntries": 2000,
    "confidenceDecayRate": 0.01,
    "staleThreshold": 0.2,
    "curationIntervalMinutes": 60,
    "curationEnabled": true
  },
  "logging": {
    "directory": "data/logs",
    "redactSensitive": true,
    "retentionDays": 90
  }
}
```

- Secrets use `env:VAR_NAME` syntax — resolved at runtime from environment variables, never stored in the config file.
- Gateway binds to **localhost only** by default.

---

## Security Model

### Trust Boundaries

```
UNTRUSTED                          TRUSTED
─────────────────────────────────────────────────
Inbound messages                   Config files
LLM output (tool calls, text)      Tool source code (local)
Network responses                  Capability gate logic
                                   User approval decisions
```

### Invariants

1. **LLM output never executes without passing through the capability gate.**
2. **No tool can exceed its declared capabilities.** The executor enforces this independently of the gate.
3. **Secrets never appear in LLM prompts.** Tool handlers receive credentials via the execution context, not via prompt injection.
4. **The gateway never binds to 0.0.0.0.** Exposing to the network requires explicit reverse proxy configuration by the operator.
5. **All state changes are logged.** There is no code path that mutates state without emitting a log event.
6. **Memory writes are tool calls.** The LLM cannot silently modify what the system believes about the user.

### What This Doesn't Solve

- **Prompt injection is an unsolved industry problem.** The capability gate limits blast radius but cannot prevent a sufficiently clever injection from producing convincing-looking tool calls. The mitigation is deny-by-default + user approval for sensitive capabilities.
- **Local model quality varies.** Smaller local models may produce malformed tool calls or hallucinate capabilities. The registry's schema validation catches structural errors, but semantic misuse requires user judgment.

---

## Development Guidelines

### No External Dependencies

This is a hard rule. The `node_modules` directory should contain only `typescript` and test tooling (`node:test` is built-in, prefer it). If you need functionality that would normally come from a package:

1. Check if Node stdlib provides it (`crypto`, `fs`, `path`, `child_process`, `http`, `net`, etc.)
2. If not, implement it. Most utility code (TF-IDF, JSON schema validation, SSE parsing, retry logic) is <200 lines.
3. Document why in a comment linking to the relevant implementation.

### Testing

- Unit tests for every module using `node:test`.
- Integration tests for the full pipeline: message in → tool execution → message out.
- Capability gate tests are **security-critical** — test every deny path, every grant scope, every timeout.
- Memory retrieval tests with known corpora to verify ranking quality.
- Run with `node --test`.

### Code Style

- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`).
- No `any`. Use `unknown` and narrow with type guards.
- Prefer `interface` over `type` for component contracts.
- All async code uses `async/await`, no raw Promise chains.
- Error handling: typed error classes per component, never throw strings.

---

## Repository

- **GitHub:** https://github.com/samteezy/better-claws
- **Issues:** https://github.com/samteezy/better-claws/issues

---

## Workflow

- **Issues as source of truth:** Work is tracked as GitHub issues at https://github.com/samteezy/better-claws/issues. Check open issues with `gh issue list` before starting work.
- **Commits:** When a commit relates to a GitHub issue, reference it in the commit message (e.g., `Implement prompt builder (#1)`). Use `Fixes #N` or `Closes #N` in the final commit for an issue to auto-close it.
- **Issue comments:** When the work for an issue is complete (code written, tests passing, committed), add a comment to the issue summarizing what was done using `gh issue comment <number> --body "..."`.