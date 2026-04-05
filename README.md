# betterClaws

A lightweight, secure, self-hosted personal AI assistant gateway.

Text your computer from anywhere. It does stuff. Safely.

## What is this?

betterClaws is a message-to-action pipeline: you send a message from any platform (Telegram, Discord, Slack, etc.), it goes through an LLM, and the LLM can invoke tools on your machine — but only after passing through a capability gate that enforces explicit user approval.

The architecture assumes the LLM is adversarial. Every tool invocation requires capability grants, every action is logged, and the default posture is deny-all.

## Key principles

- **Zero external runtime dependencies.** TypeScript and Node stdlib only. No supply chain attack surface.
- **Sandboxed by default.** Nothing executes without explicit capability grants.
- **Transparent logging.** Every event is logged to append-only structured JSONL.
- **Local-first.** State is files. Config is files. No databases, no external services beyond the LLM endpoint.

## Architecture

```
Channel Adapters --> Message Router --> Session Manager --> LLM Client
                                                              |
                                                        Tool Registry
                                                              |
                                                        Capability Gate
                                                              |
                                                      Sandboxed Executor
```

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
src/
  index.ts              # Entry point + CLI adapter
  types.ts              # Shared type definitions
  config.ts             # Configuration loader
  logger/               # Append-only structured JSONL logger
  llm/                  # OpenAI-compatible LLM client with SSE streaming
  tools/                # Tool registry, capability gate, sandboxed executor
  sessions/             # Per-conversation state as filesystem-backed JSONL
  router/               # Core message-to-response pipeline
tools/                  # User-defined tool modules (drop-in directory)
config/                 # Configuration files
tests/                  # Unit and integration tests
```

## Configuration

Edit `config/betterclaws.json`. Secrets use `env:VAR_NAME` syntax — resolved at runtime, never stored in the config file.

```json
{
  "llm": {
    "baseUrl": "http://localhost:11434/v1",
    "model": "qwen3:8b",
    "apiKey": "env:LLM_API_KEY"
  },
  "security": {
    "defaultCapabilityPolicy": "deny"
  }
}
```

Works with any OpenAI-compatible endpoint: OpenAI, Anthropic (via proxy), Ollama, llama.cpp, vLLM, LM Studio.

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

## Testing

```bash
npm run build
npm test
```

150 tests covering types, config, logger, LLM client, tool registry, capability gate, executor, session manager, and message router.

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

## License

Private.
