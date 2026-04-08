import { realpath } from "node:fs/promises";
import { resolve, isAbsolute, dirname, basename } from "node:path";

/**
 * Result of a path containment check.
 * Either the path is allowed (with the real resolved path), or denied with a reason.
 */
export type PathCheckResult =
  | { readonly allowed: true; readonly resolvedPath: string }
  | { readonly allowed: false; readonly reason: string };

/**
 * Check whether a path falls within one of the allowed roots.
 * Resolves symlinks via `realpath()` to prevent escape-via-symlink attacks.
 *
 * @param inputPath  The raw path (absolute or relative to `baseDir`)
 * @param baseDir    Base directory used to resolve relative paths
 * @param allowedRoots  List of directories the path must fall within
 */
export async function checkPath(
  inputPath: string,
  baseDir: string,
  allowedRoots: readonly string[],
): Promise<PathCheckResult> {
  const resolved = resolve(
    isAbsolute(inputPath) ? inputPath : resolve(baseDir, inputPath),
  );

  // Canonicalize allowed roots (e.g. on macOS /var → /private/var)
  const canonicalRoots = await Promise.all(
    allowedRoots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return resolve(root);
      }
    }),
  );

  // Resolve the real path by walking up to the nearest existing ancestor.
  // This handles write operations where the target file/dir doesn't exist yet.
  const real = await resolveRealPath(resolved);

  return checkResolved(real, canonicalRoots);
}

/**
 * Walk up the path tree until an existing ancestor is found, realpath it,
 * then re-append the remaining segments. This handles paths where the
 * target and/or parent directories don't exist yet (e.g., write operations).
 */
async function resolveRealPath(resolved: string): Promise<string> {
  try {
    return await realpath(resolved);
  } catch {
    // Path doesn't exist — try parent
    const parent = dirname(resolved);
    if (parent === resolved) {
      // Reached filesystem root without finding an existing ancestor
      return resolved;
    }
    const realParent = await resolveRealPath(parent);
    return resolve(realParent, basename(resolved));
  }
}

function checkResolved(
  resolved: string,
  allowedRoots: readonly string[],
): PathCheckResult {
  const allowed = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + "/"),
  );

  if (allowed) {
    return { allowed: true, resolvedPath: resolved };
  }

  return {
    allowed: false,
    reason: `Path "${resolved}" is outside all allowed roots`,
  };
}
