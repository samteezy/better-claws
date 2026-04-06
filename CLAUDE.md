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

- **Zero external runtime dependencies.** Only `typescript` in devDependencies. Use Node stdlib (`crypto`, `fs`, `path`, `child_process`, `http`, `net`, etc.) for everything. If you'd normally reach for a package, implement it — most utilities are <200 lines.
- **Include `createdAt` + `updatedAt`** on any entity subject to decay or staleness tracking.
- **LLM output is untrusted input.** It never executes without passing through the capability gate.
- **Secrets never appear in LLM prompts.** Tools receive credentials via `ExecutionContext`, not prompt injection.
- **All state changes are logged.** No code path mutates state without emitting a structured log event.

## Architecture (quick reference)

```
Adapter → Router → Session → PromptBuilder → LlmClient → ToolRegistry → CapabilityGate → ForkedExecutor
```

Cross-cutting: `StructuredLogger` (all components emit), `WorkingMemory`, `LongTermStore` + TF-IDF retrieval.
Background: `CurationWorker` (distillation, consolidation, confidence decay), `Scheduler` (cron jobs).
Dashboard: HTTP server at configurable port for session inspection and log viewing.

## Key Directories

- `src/` — source (adapters/, dashboard/, llm/, logger/, memory/, prompt/, router/, scheduler/, sessions/, tools/)
- `tests/` — `unit/` and `integration/` (362 tests)
- `tools/` — user-defined tool modules: shell, file-read, file-write, web-fetch, memory-update
- `config/betterclaws.json` — runtime config; secrets use `env:VAR_NAME` syntax resolved at runtime
- `data/` — gitignored runtime data (sessions/, memory/, logs/, scratch/)

## Adapters (implemented)

Telegram, Discord, Slack, Webhook. CLI adapter in `src/index.ts` for local testing.

## Repository

- **GitHub:** https://github.com/samteezy/better-claws
- **Issues:** https://github.com/samteezy/better-claws/issues
