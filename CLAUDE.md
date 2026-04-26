# CLAUDE.md — betterClaws

Development guide for working in this repo.

## Build & Run

```bash
npm run build        # compile TypeScript
npm test             # build + node --test 'dist/tests/**/*.test.js'
npm run dev          # tsc --watch
npm start            # node dist/src/index.js (CLI adapter)
```

Tests must build before running — `npm test` handles both steps.

### Docker

```bash
docker build -t betterclaws .     # build image
docker compose up                  # run with docker-compose
```

The Dockerfile is a multi-stage build: compile TS in `node:22-alpine`, then copy compiled JS to a slim runtime image (no `npm install` needed at runtime — zero deps). `config/betterclaws.docker.json` has container-friendly defaults (`0.0.0.0` bindings, `host.docker.internal` for Ollama).

## Workflow

- Work is tracked as GitHub issues. Check `gh issue list` before starting.
- Branch from `main` per issue. **Never merge feature branches into each other.**
- Reference issues in commits: `Implement foo (#N)`. Use `Fixes #N` or `Closes #N` in the final commit to auto-close.
- When done: push the branch and comment on the issue with `gh issue comment <N> --body "..."`.

## Writing Tests

- Use the **ts-unit-test-writer** subagent to write tests.
- All tests use `node:test` (built-in). No test frameworks.
- Every module gets a unit test in `tests/unit/`. Integration tests go in `tests/integration/`.
- Capability gate tests are **security-critical** — test every deny path, grant scope, and timeout.
- Memory retrieval tests use known corpora to verify ranking quality.

## Code Style

- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`).
- No `any`. Use `unknown` and narrow with type guards.
- Prefer `interface` over `type` for component contracts.
- All async uses `async/await`. No raw Promise chains.
- Typed error classes per component (`BetterClawsError` subclasses). Never throw strings.

## Hard Constraints

- **Zero external runtime dependencies.** Only `typescript` and `@types/node` in devDependencies. Use Node stdlib (`crypto`, `fs`, `path`, `child_process`, `http`, `net`, etc.) for everything. If you'd normally reach for a package, implement it — most utilities are <200 lines.
- **Include `createdAt` + `updatedAt`** on any entity subject to decay or staleness tracking.
- **LLM output is untrusted input.** It never executes without passing through the capability gate.
- **Secrets never appear in LLM prompts.** Tools receive credentials via `ExecutionContext`, not prompt injection.
- **All state changes are logged.** No code path mutates state without emitting a structured log event.

## Network Exposure

`gateway.host` is the default bind address for HTTP-serving components (WebChat, Dashboard, Webhook). Each can override with its own `host` field. When the resolved bind address is non-loopback (anything other than `127.0.0.1` / `localhost`), an auth token is required:

- WebChat: `adapters.webchat.secret`
- Dashboard: `dashboard.authToken`
- Webhook already requires `adapters.webhook.secret` (HMAC), so it's covered.

The check fires at adapter `start()` (runtime), not at config load — startup will fatal-exit if a non-loopback host is set without the token.

## Architecture (quick reference)

```
Adapter → Router → Session → PromptBuilder → LlmClient → ToolRegistry → CapabilityGate → ForkedExecutor
```

Cross-cutting: `StructuredLogger` (all components emit), `WorkingMemory`, `LongTermStore` + TF-IDF retrieval.
Background: `CurationWorker` (distillation, consolidation, confidence decay), `Scheduler` (cron jobs).
Dashboard: HTTP server at configurable port for session inspection and log viewing.

## Key Directories

- `src/` — source (adapters/, dashboard/, llm/, logger/, mcp/, memory/, prompt/, router/, scheduler/, secrets/, sessions/, skills/, tools/, utils/)
- `tests/` — `unit/` and `integration/`
- `tools/` — user-defined tool modules: shell, file-read, file-write, web-fetch, memory-update
- `config/betterclaws.json` — runtime config; secrets use `env:VAR_NAME` syntax resolved at runtime
- `config/betterclaws.local.json` — gitignored deployment overrides; deep-merged on top of the base config at load time (arrays replace, objects merge). Use for server-specific settings (API keys, model, adapter tokens) so `git pull` never conflicts. Derive local path from `--config` too: `foo.json` → `foo.local.json`.
  - **Array caveat**: to add one schedule locally, copy the full `schedules` array and append your entry — arrays replace, they do not concatenate.
  - **Migration**: `cp config/betterclaws.json config/betterclaws.local.json && git checkout config/betterclaws.json`, then trim the local file to only your overrides.
- `data/` — gitignored runtime data (sessions/, memory/, logs/, scratch/)

## Adapters (implemented)

Telegram, Discord, Slack, Webhook. CLI adapter in `src/index.ts` for local testing.

## Design Language — "Soft Clay"

All user-facing surfaces share a cohesive warm, light aesthetic.

**Palette** (CSS vars in `src/dashboard/public/style.css`):

| Token | Hex | Role |
|-------|-----|------|
| `--accent` | `#6b8f71` | Sage green — primary accent, bot identity |
| `--text` | `#3a3632` | Warm dark — body text |
| `--text-muted` | `#9e9891` | Stone — secondary/meta text |
| `--bg` | `#f6f4f0` | Warm off-white — backgrounds |
| `--surface` | `#ffffff` | White — cards, inputs |
| `--border` | `#e6e2db` | Warm gray — borders |
| `--purple` | `#8b7fbe` | Lavender — tool activity, accents |
| `--amber` | `#c49a5c` | Clay — warm highlights |
| `--rose` | `#c77272` | Soft rose — errors, warnings |

**Typography**: Outfit (headings), DM Sans (body), DM Mono (code). In terminal contexts, use ANSI 24-bit RGB equivalents of the palette.

**Principles**: Mobile-first, soft shadows over hard borders, generous radius (14px web / 20px bubbles), subtle animations. Dark mode available via sun/moon toggle in header; uses warm charcoal palette preserving earthy identity. Theme stored in localStorage key `bc_theme` (default: light).

## README

The README is end-user focused. Keep it that way when updating. It should cover: what betterClaws is, how to set it up, how to configure it, how to connect chat platforms, built-in and custom tools, capabilities, security model (user-facing invariants), dashboard, and memory. Do not add internal architecture, project structure, component deep-dives, or test details — those belong here in CLAUDE.md.

## Repository

- **GitHub:** https://github.com/samteezy/better-claws
- **Issues:** https://github.com/samteezy/better-claws/issues
