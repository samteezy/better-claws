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

/** Amber — context warnings, warm highlights (#c49a5c) */
export const amber = rgb(196, 154, 92);

/** Soft rose — errors (#c27878) */
export const rose = rgb(194, 120, 120);

/** Warm stone — dim/meta text (#9a9590) */
export const stone = rgb(154, 149, 144);

// ── Modifiers ────────────────────────────────────────────────────────────────

export const bold = wrap("\x1b[1m", "\x1b[22m");
export const dim = wrap("\x1b[2m", "\x1b[22m");
export const italic = wrap("\x1b[3m", "\x1b[23m");

/** Strip all ANSI escape sequences from a string. */
export function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Whether color output is enabled. */
export const enabled = !DISABLED;

// ── Glyph fallback ───────────────────────────────────────────────────────────
//
// Some terminals (notably tmux's default `screen-256color` and the Linux
// console) silently substitute `_` for Unicode code points they consider
// unrenderable. Detect the unsafe cases and fall back to ASCII equivalents.

export interface Glyphs {
  /** Prompt arrow between speaker label and message (›) */
  prompt: string;
  /** Horizontal rule character (─) */
  hRule: string;
  /** Tool success (✓) */
  ok: string;
  /** Tool failure (✗) */
  fail: string;
  /** Tool start (⟡) */
  tool: string;
  /** Warning marker (⚠) */
  warn: string;
  /** Unordered list bullet (•) */
  bullet: string;
}

const UNICODE_GLYPHS: Glyphs = {
  prompt: "›",
  hRule: "─",
  ok: "✓",
  fail: "✗",
  tool: "⟡",
  warn: "⚠",
  bullet: "•",
};

const ASCII_GLYPHS: Glyphs = {
  prompt: ">",
  hRule: "-",
  ok: "[ok]",
  fail: "[x]",
  tool: "*",
  warn: "!",
  bullet: "*",
};

/** Returns true when the current terminal renders UTF-8 box/symbol glyphs cleanly. */
export function supportsUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BETTERCLAWS_ASCII === "1") return false;
  if (env.BETTERCLAWS_UNICODE === "1") return true;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  const utf8 = /UTF-?8/i.test(locale);
  const term = env.TERM || "";
  // screen* (tmux default) and the Linux console map U+203A → '_' even with UTF-8 locales.
  const limitedTerm = /^(screen|linux|dumb)/i.test(term);
  return utf8 && !limitedTerm;
}

/** Resolve a glyph set against the given environment (defaults to process.env). */
export function resolveGlyphs(env: NodeJS.ProcessEnv = process.env): Glyphs {
  return supportsUnicode(env) ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

/** Glyph set resolved once at module load against the current environment. */
export const glyphs: Glyphs = resolveGlyphs();
