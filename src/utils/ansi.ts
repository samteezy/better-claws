// ── ANSI terminal formatting — "Soft Clay" palette ───────────────────────────
//
// Zero-dependency color utilities using 24-bit RGB ANSI escape codes.
// Gracefully degrades to plain text when color is unsupported or disabled.

const DISABLED =
  "NO_COLOR" in process.env ||
  process.argv.includes("--no-color") ||
  !process.stdout.isTTY;

function wrap(open: string, close: string): (text: string) => string {
  if (DISABLED) return (text) => text;
  return (text) => open + text + close;
}

function rgb(r: number, g: number, b: number): (text: string) => string {
  return wrap(`\x1b[38;2;${r};${g};${b}m`, "\x1b[39m");
}

// ── Soft Clay palette ────────────────────────────────────────────────────────

/** Sage green — bot prefix, primary accent (#6b8f71) */
export const sage = rgb(107, 143, 113);

/** Warm clay — user prompt, warm highlights (#c4956a) */
export const clay = rgb(196, 149, 106);

/** Muted lavender — tool activity (#8b7ea8) */
export const lavender = rgb(139, 126, 168);

/** Soft rose — errors, warnings (#c27878) */
export const rose = rgb(194, 120, 120);

/** Warm stone — dim/meta text (#9a9590) */
export const stone = rgb(154, 149, 144);

// ── Modifiers ────────────────────────────────────────────────────────────────

export const bold = wrap("\x1b[1m", "\x1b[22m");
export const dim = wrap("\x1b[2m", "\x1b[22m");
export const italic = wrap("\x1b[3m", "\x1b[23m");

// ── Utilities ────────────────────────────────────────────────────────────────

/** Strip all ANSI escape sequences from a string. */
export function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Whether color output is enabled. */
export const enabled = !DISABLED;
