// ── Error utilities ──────────────────────────────────────────────────────────

/** Extract a human-readable message from an unknown caught value. */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Check whether an unknown caught value is a Node.js ENOENT (file-not-found). */
export function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
