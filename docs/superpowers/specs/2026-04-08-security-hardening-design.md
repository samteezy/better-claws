# Security Hardening Design

## Context

betterClaws allows LLMs to invoke tools (file read/write, shell, web fetch) through a capability gate. A security audit identified 8 vulnerabilities where untrusted LLM output can bypass intended boundaries — most critically, file tools accepting arbitrary absolute paths and an auto-grant mechanism that lets the LLM escalate its own capabilities. This spec addresses all 8 in two phases: surgical critical fixes (Phase A), then defense-in-depth (Phase B).

## Phase A: Critical Fixes

### A1. Path Containment for File Tools

**Vulnerability:** `file-read.ts:52-54` and `file-write.ts:58-60` accept absolute paths, allowing LLM to read/write any file on the system when `fs:read`/`fs:write` is granted.

**Fix:** After `path.resolve()`, verify the resolved path falls within `scratchDir` or an explicitly configured `allowedFsRoots` array. Reject with a clear error otherwise.

**Check logic:**
```typescript
function isPathAllowed(resolved: string, roots: readonly string[]): boolean {
  return roots.some(root => resolved === root || resolved.startsWith(root + "/"));
}
```

**Files:**
- `src/types.ts` — add `allowedFsRoots?: readonly string[]` to `SecurityConfig` and `ExecutionContext`
- `src/tools/built-in/file-read.ts` — add containment check after line 54
- `src/tools/built-in/file-write.ts` — add containment check after line 60
- `src/router/message-router.ts` — populate `context.allowedFsRoots` from `config.security.allowedFsRoots`, always including `scratchDir`

**Default behavior:** If `allowedFsRoots` is not configured, only `scratchDir` is allowed. Absolute paths outside scratch are rejected.

### A2. Auto-Grant Blocklist

**Vulnerability:** `message-router.ts:329-352` auto-grants any capability in `config.security.autoGrantCapabilities`, including dangerous ones like `fs:write`, `exec:shell`.

**Fix:** Hard-code a `NEVER_AUTO_GRANT` set. At line 333, if any missing capability is in the blocklist, auto-grant is denied for that tool call.

**Blocklist:** `fs:write`, `exec:shell`, `exec:subprocess`, `net:outbound`

**File:** `src/router/message-router.ts` — add constant + filter before `canAutoGrant` check.

### A3. Tool Result Redaction

**Vulnerability:** `message-router.ts:224` sends tool output into LLM context without redacting secrets.

**Fix:** Wrap through existing `redactSecrets()` from `src/utils/redact.ts`:
```typescript
content: redactSecrets(JSON.stringify(toolResult.output ?? toolResult.error)),
```

**File:** `src/router/message-router.ts` — one-line change at line 224.

### A4. Schema Validator Strictness

**Vulnerability:** `schema-validator.ts:113` returns `true` for unknown types. No `additionalProperties` rejection.

**Fix:**
1. Line 113: `default: return true` → `default: return false`
2. Object validation branch: after validating declared properties, reject keys not in `schema.properties` (unless `additionalProperties: true`)

**Pre-merge check:** Audit all tool schemas for type typos (`grep -r '"type":' src/tools/`).

**File:** `src/utils/schema-validator.ts`

## Phase B: Defense-in-Depth

### B1. PathPolicy Utility

**Purpose:** Replace inline path checks from A1 with a reusable, symlink-aware module.

**New file:** `src/utils/path-policy.ts` (~60 lines)

**Behavior:**
1. Resolve path with `fs.realpath()` (follows symlinks)
2. Check real path against allowed roots
3. Return typed result: `{ allowed: true, resolvedPath } | { allowed: false, reason }`

**Consumers:** `file-read.ts`, `file-write.ts`, `shell.ts` (for `cwd` parameter)

### B2. Output Sanitizer Pipeline

**Purpose:** Composable output sanitization replacing ad-hoc redaction in multiple places.

**New file:** `src/utils/output-sanitizer.ts` (~80 lines)

**Pipeline steps:**
1. `redactSecrets()` — existing regex-based redaction
2. Truncate to configurable max (default 10KB)
3. Strip sensitive JSON keys (`password`, `token`, `secret`, `api_key`, `authorization`) recursively

**Consumers:** `message-router.ts:224` (replaces A3 one-liner), `forked-executor.ts:275-276` (replaces current ad-hoc redaction)

### B3. Web-Fetch Header Blocklist

**Vulnerability:** `web-fetch.ts:93-95` passes LLM-supplied headers to `fetch()` without filtering.

**Fix:** Block `authorization`, `cookie`, `proxy-authorization` headers (case-insensitive). Log when blocked.

**File:** `src/tools/built-in/web-fetch.ts` — filter after header extraction at line 93-95.

### B4. Case-Insensitive Secret Keys

**Vulnerability:** Secret lookup is case-sensitive. Tool declaring `secrets: ["MY_API_KEY"]` won't find `my_api_key`.

**Fix:** Normalize all keys to lowercase in `register()`, `get()`, `has()`, `projectForTool()`.

**File:** `src/secrets/secret-manager.ts` — ~5 lines across 4-5 methods.

### B5. Enable Node Permission Flag by Default

**Vulnerability:** `forked-executor.ts:98` defaults `enablePermissionFlag` to `false`, leaving filesystem sandboxing off.

**Fix:** Check `parseInt(process.versions.node, 10) >= 20`. If true, default `enablePermissionFlag` to `true`. Catch child process errors from the flag and fall back to non-sandboxed execution with a warning log. Users can override via config (`security.enablePermissionFlag: false`).

**File:** `src/tools/forked-executor.ts`

## Test Plan

### Phase A tests:
- **Path containment:** Test absolute paths outside scratchDir are rejected; relative paths still work; configured `allowedFsRoots` are honored; prefix attacks like `/tmp/safe-attack/../etc/passwd` are caught
- **Auto-grant blocklist:** Test `fs:write`, `exec:shell` cannot be auto-granted; `fs:read`, `memory:read` can; mixed capabilities (some blocked, some not) deny the entire tool call
- **Tool result redaction:** Test tool output containing AWS keys, Bearer tokens, etc. is redacted before entering LLM messages
- **Schema strictness:** Test unknown types rejected; extra properties rejected; `additionalProperties: true` allows extras

### Phase B tests:
- **PathPolicy:** Symlink escape (link inside scratch pointing outside); double-dot after resolution; `realpath()` failure on nonexistent path; multiple allowed roots
- **Output sanitizer:** Pipeline ordering (redact → truncate → strip); truncation at boundary; sensitive key stripping in nested objects; non-object output passthrough
- **Header blocklist:** `Authorization` blocked; `Content-Type` allowed; case variations (`AUTHORIZATION`) blocked; log emitted on block
- **Secret keys:** Register as `MY_KEY`, retrieve as `my_key`; `projectForTool` matches case-insensitively
- **Permission flag:** Enabled on Node 20+; disabled on older; fallback on error

### End-to-end verification:
1. Run `npm test` — all 1074 existing tests pass
2. Manual test: send a message that triggers file-read with absolute path `/etc/passwd` — expect rejection
3. Manual test: configure auto-grant with `fs:write` — expect it's still denied
4. Manual test: trigger web-fetch with `Authorization` header — expect it's stripped
5. Check structured logs for new `gate:decision` and path rejection events

## Implementation Order

1. A1 (path containment) — highest blast radius if exploited
2. A2 (auto-grant blocklist) — prevents privilege escalation
3. A3 (tool result redaction) — one-line, immediate value
4. A4 (schema strictness) — audit schemas first
5. B1 (PathPolicy) — replaces A1 inline checks
6. B2 (output sanitizer) — replaces A3 one-liner
7. B3 (header blocklist)
8. B4 (case-insensitive secrets)
9. B5 (permission flag default)
