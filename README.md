# betterClaws

A lightweight, secure, self-hosted personal AI assistant gateway.

Text your computer from anywhere. It does stuff. Safely.

## What is this?

betterClaws is a message-to-action pipeline: you send a message from any platform (Telegram, Discord, Slack, or a webhook), it goes through an LLM, and the LLM can invoke tools on your machine — but only after passing through a capability gate that enforces explicit user approval.

The architecture assumes the LLM is adversarial. Every tool invocation requires capability grants, every action is logged, and the default posture is deny-all.

## Key principles

- **Zero external runtime dependencies.** TypeScript and Node stdlib only. No supply chain attack surface.
- **Sandboxed by default.** Nothing executes without explicit capability grants.
- **Transparent logging.** Every event is logged to append-only structured JSONL.
- **Local-first.** State is files. Config is files. No databases, no external services beyond the LLM endpoint.

## Architecture

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
                                                        Forked Executor
                                                                  │
               Structured Logger ◄────────── (cross-cutting, all components emit)

                                    Background Curation Worker
                                       │            ▲
                             (reads)   │            │  (writes)
                                       ▼            │
                   Session Logs ──→ Long-Term Memory Store

                         Scheduler (cron-based background tasks)
                         Dashboard (web UI for session/log inspection)
```

## Components

**Channel Adapters** — Pluggable modules for messaging platforms. Each normalizes platform-specific formats into a common `InboundMessage` type. Implemented: Telegram, Discord, Slack, Webhook. A CLI adapter is included for local testing.

**Message Router** — Receives inbound messages from all adapters, resolves each to a session (by platform + sender identity), dispatches to the agent loop, and routes responses back through the originating adapter. The only component that touches multiple adapters.

**Session Manager** — Maintains per-conversation state: message history, working memory, tool approval grants, active context. State is stored as filesystem-backed JSONL (append-only log per session). Sessions are the unit of isolation.

**Prompt Builder** — Assembles the full LLM prompt for each turn: system prompt, retrieved long-term memory entries (relevance-scored), working memory snapshot, conversation history (configurable window), and the current user message. Enforces a token budget, truncating history from the middle when needed.

**LLM Client** — Thin wrapper around native `fetch` targeting `/v1/chat/completions` (OpenAI-compatible API). Handles streaming via `ReadableStream` SSE parsing, retry logic with exponential backoff, and token counting. Works with any OpenAI-compatible endpoint: OpenAI, Anthropic (via proxy), Ollama, llama.cpp, vLLM, LM Studio.

**Tool Registry** — Loads tool modules from `tools/<name>/` directories at startup. Each tool has a `descriptor.json` (name, description, JSON schema, required capabilities) and a `handler.js` (execute function). Validates definitions at load time.

**Capability Gate** — The key security component. Sits between tool invocation and execution. Every tool declares required capabilities; the gate checks if the session has approved grants. If not, the request is paused and surfaced to the user for explicit approval. Default posture: deny all. Grants are scoped to `session` (default) or `persistent` (opt-in).

**Forked Executor** — Tools run in `child_process.fork()` with stripped environment variables, `cwd` locked to a per-execution scratch directory, and configurable timeout enforcement (default: 30s). Returns structured `ToolResult` — never raw process output.

**Structured Logger** — Cross-cutting concern. Append-only JSONL files, one per day, rotated by date. Every entry includes timestamp, sessionId, eventType, component, and payload. Sensitive fields (API keys, tokens) are redacted.

**Memory System** — Three-tier design. Tier 1: raw JSONL session logs (full fidelity, never mutated). Tier 2: working memory (per-session distilled context injected into prompts, size-bounded). Tier 3: long-term memory (cross-session knowledge with categories, confidence scores, provenance tracking, and staleness decay). Retrieval uses TF-IDF scoring — no vector database, no embeddings service.

**Curation Worker** — Background timer-driven worker that distills idle sessions into long-term memory entries, consolidates overlapping entries, decays confidence on unaccessed entries, and prunes stale entries when the size budget is hit. The only component that makes unsupervised LLM calls, rate-limited and distinctly logged.

**Scheduler** — Cron-based task scheduler with a built-in cron expression parser. Runs background tasks on configurable schedules.

**Dashboard** — Web UI server for inspecting sessions and viewing structured logs. Serves static HTML/CSS/JS.

## Quick start

```bash
# Install (typescript is the only dependency)
npm install

# Build
npm run build

# Configure your LLM endpoint
# Default: Ollama at http://localhost:11434/v1
vim config/betterclaws.json

# Run (CLI adapter for local testing)
npm start
```

The CLI adapter reads from stdin and writes to stdout. Type a message, get a response.

## Project structure

```
betterClaws/
├── src/
│   ├── index.ts                   # entry point + CLI adapter
│   ├── types.ts                   # shared type definitions
│   ├── config.ts                  # configuration loader
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
│   │   ├── executor.ts
│   │   ├── forked-executor.ts
│   │   └── tool-worker.ts
│   ├── memory/
│   │   ├── working-memory.ts
│   │   ├── long-term-store.ts
│   │   ├── retrieval.ts           # TF-IDF + category filtering
│   │   └── curation-worker.ts
│   ├── adapters/
│   │   ├── telegram/
│   │   ├── discord/
│   │   ├── slack/
│   │   └── webhook/
│   ├── scheduler/
│   │   ├── scheduler.ts
│   │   └── cron-parser.ts
│   ├── dashboard/
│   │   ├── dashboard-server.ts
│   │   └── public/               # static HTML/CSS/JS
│   └── logger/
│       └── structured-logger.ts
├── tools/                         # user-defined tool modules
│   ├── shell/
│   ├── file-read/
│   ├── file-write/
│   ├── web-fetch/
│   └── memory-update/
├── data/                          # runtime data (gitignored)
│   ├── sessions/
│   ├── memory/
│   ├── logs/
│   └── scratch/
├── config/
│   └── betterclaws.json
└── tests/
    ├── unit/                      # per-module unit tests
    └── integration/               # full pipeline tests
```

## Configuration

Single JSON file at `config/betterclaws.json`. Secrets use `env:VAR_NAME` syntax — resolved at runtime from environment variables, never stored in the config file.

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

The gateway binds to **localhost only** by default. Exposing to the network requires a reverse proxy.

## Adding tools

Drop a directory in `tools/` with two files:

**`tools/my-tool/descriptor.json`**
```json
{
  "name": "my-tool",
  "description": "What the tool does",
  "parameters": { "type": "object", "properties": {} },
  "capabilities": ["fs:read"]
}
```

**`tools/my-tool/handler.js`**
```js
export async function execute(params, context) {
  return { success: true, output: "result", durationMs: 0 };
}
```

Tools must declare their capabilities. The capability gate blocks execution unless the session has matching grants.

## Built-in tools

| Tool | Capabilities | Description |
|---|---|---|
| `shell` | `exec:shell` | Execute shell commands via `execFile` |
| `file-read` | `fs:read` | Read file contents with optional line ranges |
| `file-write` | `fs:write` | Write files with automatic directory creation |
| `web-fetch` | `net:outbound` | HTTP requests with configurable response size limits |
| `memory-update` | `memory:write` | Update session working memory |

## Security model

### Trust boundaries

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
3. **Secrets never appear in LLM prompts.** Tool handlers receive credentials via the execution context.
4. **The gateway never binds to 0.0.0.0.**
5. **All state changes are logged.** No code path mutates state without emitting a log event.
6. **Memory writes are tool calls.** The LLM cannot silently modify what the system believes about the user.

### Limitations

- **Prompt injection is an unsolved industry problem.** The capability gate limits blast radius but cannot prevent a sufficiently clever injection from producing convincing-looking tool calls. The mitigation is deny-by-default + user approval for sensitive capabilities.
- **Local model quality varies.** Smaller local models may produce malformed tool calls or hallucinate capabilities. The registry's schema validation catches structural errors, but semantic misuse requires user judgment.

## Capability taxonomy

| Capability | Description |
|---|---|
| `fs:read` | Read files |
| `fs:write` | Create or modify files |
| `fs:delete` | Delete files |
| `net:outbound` | Outbound HTTP/network requests |
| `net:listen` | Bind to a network port |
| `exec:shell` | Execute shell commands |
| `exec:subprocess` | Spawn child processes |
| `browser:navigate` | Automated browser navigation |
| `browser:input` | Automated form filling |
| `memory:read` | Read from long-term memory |
| `memory:write` | Write to long-term memory |

## Testing

```bash
npm run build
npm test
```

362 tests across 23 test files covering: types, config, logger, LLM client, tool registry, capability gate, executor, forked executor, session manager, message router, working memory, long-term store, retrieval, curation worker, scheduler, cron parser, prompt builder, dashboard, all four adapters, built-in tools, and a full integration test for the Telegram message-to-response pipeline.

## License

Private.
