# betterClaws

A lightweight, secure, self-hosted personal AI assistant gateway.

Text your computer from anywhere. It does stuff. Safely.

## What is this?

betterClaws lets you send messages from Telegram, Discord, Slack, or a webhook to an LLM that can invoke tools on your machine — run shell commands, read and write files, fetch URLs, and more. Every tool invocation must pass through a capability gate that enforces explicit user approval before anything executes. The default posture is deny-all.

It runs entirely on your machine with zero external runtime dependencies (TypeScript + Node stdlib only). State is files, config is files, no databases required. Works with any OpenAI-compatible LLM endpoint: OpenAI, Anthropic (via proxy), Ollama, llama.cpp, vLLM, LM Studio.

## Key principles

- **Zero external runtime dependencies.** TypeScript and Node stdlib only. No supply chain attack surface.
- **Sandboxed by default.** Nothing executes without explicit capability grants.
- **Transparent logging.** Every event is logged to append-only structured JSONL.
- **Local-first.** No databases, no external services beyond your LLM endpoint.

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

## Docker

```bash
docker compose up
```

This builds the image and starts betterClaws with persistent storage. Pass secrets as environment variables:

```bash
BC_TELEGRAM_TOKEN=your-token BC_DASHBOARD_TOKEN=your-token docker compose up
```

The container uses `config/betterclaws.docker.json` with container-friendly defaults (`0.0.0.0` bindings, `host.docker.internal` for Ollama). To use your own config, uncomment the volume mount in `docker-compose.yml` — just ensure hosts are set to `0.0.0.0` instead of `127.0.0.1`.

The `data/` directory (logs, sessions, memory) is persisted in a named Docker volume.

## Connecting a chat platform

Enable adapters in `config/betterclaws.json` under the `adapters` key. Secrets use `env:VAR_NAME` syntax — resolved at runtime from environment variables, never stored in config.

```json
"adapters": {
  "telegram": { "enabled": true, "token": "env:BC_TELEGRAM_TOKEN" },
  "discord":  { "enabled": false },
  "slack":    { "enabled": false },
  "webhook":  { "enabled": true, "secret": "env:BC_WEBHOOK_SECRET" }
}
```

Set the corresponding environment variables before starting:

```bash
export BC_TELEGRAM_TOKEN="your-bot-token"
npm start
```

## Configuration

Single JSON file at `config/betterclaws.json`.

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

## System context

Customize the AI's personality and provide static information about yourself in the `systemContext` config section. These are injected into every system prompt alongside the current UTC date and time.

```json
"systemContext": {
  "persona": "You are a concise, no-nonsense assistant.",
  "userContext": "My name is Sam. I live in New York. I prefer metric units.",
  "timezone": "UTC"
}
```

- **`persona`** — Shapes the AI's personality and tone.
- **`userContext`** — Static facts about you that the AI should always know.
- **`timezone`** — Currently defaults to UTC; the current date/time is always included in the prompt.

### Adapter-specific prompts

Each adapter can include a `systemPrompt` field to tailor behavior per channel. This is useful for platform-specific formatting or length constraints:

```json
"adapters": {
  "telegram": {
    "enabled": true,
    "token": "env:BC_TELEGRAM_TOKEN",
    "systemPrompt": "Keep responses under 4096 characters. Use markdown formatting."
  },
  "webhook": {
    "enabled": true,
    "secret": "env:BC_WEBHOOK_SECRET",
    "systemPrompt": "Respond in plain text only. Keep responses under 160 characters."
  }
}
```

## Built-in tools

| Tool | Capabilities | Description |
|---|---|---|
| `shell` | `exec:shell` | Execute shell commands |
| `file-read` | `fs:read` | Read file contents with optional line ranges |
| `file-write` | `fs:write` | Write files with automatic directory creation |
| `web-fetch` | `net:outbound` | HTTP requests with configurable response size limits |
| `memory` | `memory:read`, `memory:write` | Manage working memory and search long-term memory |
| `schedule-list` | — | List all scheduled tasks |
| `schedule-add` | — | Create a new scheduled task |
| `schedule-edit` | — | Update an existing scheduled task |

## MCP and Skills

betterClaws can connect to remote [MCP](https://modelcontextprotocol.io/) servers over SSE/HTTP, making their tools available alongside built-in ones. Configure remote servers in `config/betterclaws.json`:

```json
"mcp": {
  "servers": [
    { "name": "my-server", "url": "https://my-mcp-server.example/sse" }
  ]
}
```

It also supports loading tools from [agentskills.io](https://agentskills.io/) via `SKILL.md` definitions. All remote tools pass through the same capability gate as local ones.

## Task scheduling

betterClaws can run prompts on a cron schedule. Each scheduled task fires through the normal message pipeline — including capability gate enforcement — so scheduled tasks have the same permissions as any user message.

Add schedules in `config/betterclaws.json`:

```json
"schedules": [
  {
    "id": "1",
    "name": "Daily Summary",
    "cron": "0 9 * * *",
    "prompt": "Summarize yesterday's activity",
    "enabled": true
  }
]
```

Cron expressions use the standard 5-field format: `minute hour day-of-month month day-of-week`.

### Managing schedules

There are three ways to manage scheduled tasks:

- **Dashboard** — The Schedules tab lets you add, edit, toggle, and delete tasks with a visual interface.
- **Chat commands** — Use `/schedule` to list tasks, and `/schedule enable|disable|remove <id|all>` to manage them inline.
- **Agent tools** — The AI can create and edit schedules using the `schedule-add` and `schedule-edit` tools. It cannot remove schedules — only disable them. Removal is a human-only action.

## Session commands

During a conversation, you can use these commands:

| Command | Description |
|---|---|
| `/new` | Start a fresh session |
| `/reset` | Clear the current session's working memory |
| `/compact` | Compact the conversation history to reclaim context |
| `/stop` | Immediately stop whatever the agent is doing — works mid-response, mid-tool-call, anytime |
| `/schedule` | List all scheduled tasks |
| `/schedule enable\|disable <id>` | Enable or disable a scheduled task |
| `/schedule enable\|disable all` | Enable or disable all scheduled tasks |
| `/schedule remove <id>` | Remove a scheduled task |

## Adding your own tools

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

## Tool policies

Each tool can be assigned a policy that controls how it executes:

| Policy | Behavior |
|---|---|
| `auto` | Executes immediately if capabilities are granted (default) |
| `confirm` | Pauses and asks the user for explicit approval before executing |
| `disabled` | Blocked entirely — the LLM is told the tool is unavailable |

Configure policies in `config/betterclaws.json`:

```json
"tools": {
  "toolPolicies": {
    "shell": "confirm",
    "file-write": "confirm",
    "web-fetch": "auto",
    "file-read": "auto"
  }
}
```

When a `confirm`-policy tool is invoked, betterClaws sends a confirmation prompt directly to you — the LLM never sees it. Reply **YES** to allow once, **YES ALWAYS** to allow for the rest of the session, or **NO** to deny. If you don't respond within the timeout (default: 120 seconds), the tool is automatically denied.

The confirmation exchange is handled entirely outside the LLM conversation. The LLM only sees whether the tool was allowed or denied — it cannot read, influence, or bypass the confirmation flow.

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

## Security model

betterClaws assumes the LLM is adversarial. The key invariants:

1. **LLM output never executes without passing through the capability gate.** Every tool call requires a matching grant.
2. **User confirmation is enforced outside the LLM loop.** Tools with `confirm` policy require explicit user approval. The confirmation exchange is handled by the router, not the LLM — the LLM cannot see, influence, or bypass it.
3. **Secrets never appear in LLM prompts.** Tool handlers receive credentials via the execution context, not prompt injection.
4. **Tools run sandboxed.** Each execution is forked into a child process with stripped environment variables, a locked working directory, and a configurable timeout (default: 30s).
5. **All state changes are logged.** No code path mutates state without emitting a structured log event.
6. **Memory writes are tool calls.** The LLM cannot silently modify what the system believes about you.

### Limitations

- **Prompt injection is an unsolved industry problem.** The capability gate limits blast radius but cannot prevent a sufficiently clever injection from producing convincing-looking tool calls. The mitigation is deny-by-default + user approval for sensitive capabilities.
- **Local model quality varies.** Smaller local models may produce malformed tool calls or hallucinate capabilities. Schema validation catches structural errors, but semantic misuse requires user judgment.

## Dashboard

betterClaws includes a web dashboard for inspecting active sessions, viewing structured logs, editing configuration, and managing tool policies. Configure the port in `config/betterclaws.json` under the `gateway` key.

## Memory

betterClaws maintains memory across conversations. Working memory (per-session context) is injected into prompts automatically. Long-term memory accumulates cross-session knowledge with confidence scores and staleness decay — a background curation worker distills sessions, consolidates entries, and prunes stale ones. Retrieval uses TF-IDF scoring with no external services required.

## License

Private.
