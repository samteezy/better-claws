// ── Terminal Markdown Renderer ─────────────────────────────────────────────────
//
// Lightweight markdown-to-ANSI converter for CLI output. Handles the subset of
// markdown that LLMs commonly produce: bold, italic, inline code, code blocks,
// headings, and list items. Everything else passes through unchanged.
//
// Provides both a batch `renderMarkdown()` for complete text and a
// `StreamingMarkdownWriter` for rendering text-delta events as they arrive.

import { bold, dim, italic, sage, stone, glyphs } from "./ansi.js";

// ── Inline rendering ──────────────────────────────────────────────────────────

/**
 * Render inline markdown spans: bold, italic, inline code.
 * Processes in order: code (to prevent nested formatting inside backticks),
 * then bold, then italic.
 */
function renderInline(text: string): string {
  // Inline code: `code` — process first to protect contents
  let result = text.replace(/`([^`]+)`/g, (_match, code: string) => dim(code));

  // Bold+italic: ***text*** or ___text___
  result = result.replace(/\*{3}([^*]+)\*{3}/g, (_match, t: string) => bold(italic(t)));
  result = result.replace(/_{3}([^_]+)_{3}/g, (_match, t: string) => bold(italic(t)));

  // Bold: **text** or __text__
  result = result.replace(/\*{2}([^*]+)\*{2}/g, (_match, t: string) => bold(t));
  result = result.replace(/_{2}([^_]+)_{2}/g, (_match, t: string) => bold(t));

  // Italic: *text* or _text_ (but not inside words for underscore)
  result = result.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, (_match, t: string) => italic(t));
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, (_match, t: string) => italic(t));

  return result;
}

/**
 * Render a single complete line of markdown to ANSI output.
 * Returns the rendered line and whether we entered/exited a code block.
 */
function renderLine(line: string, inCodeBlock: boolean): { text: string; inCodeBlock: boolean; suppress: boolean } {
  // ── Fenced code blocks ──────────────────────────────────────────────────
  if (line.trimStart().startsWith("```")) {
    return { text: "", inCodeBlock: !inCodeBlock, suppress: true };
  }

  if (inCodeBlock) {
    return { text: dim("  " + line), inCodeBlock: true, suppress: false };
  }

  // ── Headings ────────────────────────────────────────────────────────────
  const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);
  if (headingMatch) {
    return { text: sage(bold(headingMatch[2]!)), inCodeBlock: false, suppress: false };
  }

  // ── List items ──────────────────────────────────────────────────────────
  const listMatch = /^(\s*)[*-]\s+(.+)$/.exec(line);
  if (listMatch) {
    return { text: listMatch[1] + stone(glyphs.bullet) + " " + renderInline(listMatch[2]!), inCodeBlock: false, suppress: false };
  }

  // ── Numbered list items ─────────────────────────────────────────────────
  const numListMatch = /^(\s*)\d+[.)]\s+(.+)$/.exec(line);
  if (numListMatch) {
    return { text: numListMatch[1] + stone(glyphs.bullet) + " " + renderInline(numListMatch[2]!), inCodeBlock: false, suppress: false };
  }

  // ── Regular line ────────────────────────────────────────────────────────
  return { text: renderInline(line), inCodeBlock: false, suppress: false };
}

// ── Batch renderer ────────────────────────────────────────────────────────────

/**
 * Render markdown text to ANSI-formatted terminal output.
 * Processes line-by-line for block elements, then inline spans within each line.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const result = renderLine(line, inCodeBlock);
    inCodeBlock = result.inCodeBlock;
    if (!result.suppress) {
      out.push(result.text);
    }
  }

  return out.join("\n");
}

// ── Streaming renderer ────────────────────────────────────────────────────────

/**
 * Buffers streaming text deltas and renders complete lines with markdown
 * formatting as they arrive. Partial lines are held until a newline is received.
 */
export class StreamingMarkdownWriter {
  private buffer = "";
  private inCodeBlock = false;
  private readonly write: (text: string) => void;

  constructor(write: (text: string) => void) {
    this.write = write;
  }

  /** Feed a text delta into the buffer. Complete lines are rendered and flushed. */
  push(delta: string): void {
    this.buffer += delta;

    // Process all complete lines (everything before the last newline)
    const lastNewline = this.buffer.lastIndexOf("\n");
    if (lastNewline === -1) return;

    const complete = this.buffer.slice(0, lastNewline);
    this.buffer = this.buffer.slice(lastNewline + 1);

    const lines = complete.split("\n");
    for (const line of lines) {
      const result = renderLine(line, this.inCodeBlock);
      this.inCodeBlock = result.inCodeBlock;
      if (!result.suppress) {
        this.write(result.text + "\n");
      }
    }
  }

  /** Flush any remaining buffered text. Call when the stream ends. */
  flush(): void {
    if (this.buffer.length > 0) {
      const result = renderLine(this.buffer, this.inCodeBlock);
      if (!result.suppress) {
        this.write(result.text);
      }
      this.buffer = "";
      this.inCodeBlock = false;
    }
  }
}
