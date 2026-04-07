/**
 * Minimal YAML frontmatter parser for agentskills.io SKILL.md files.
 *
 * Parses the constrained frontmatter schema defined by the agentskills.io
 * specification without requiring an external YAML library.
 */

import { BetterClawsError } from "../types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: readonly string[];
}

export interface ParsedSkillMd {
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
}

export class FrontmatterParseError extends BetterClawsError {
  constructor(message: string) {
    super(message, "frontmatter-parser", "PARSE_ERROR");
    this.name = "FrontmatterParseError";
  }
}

// ── Parser ───────────────────────────────────────────────────────────────────

export function parseSkillMd(content: string): ParsedSkillMd {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    throw new FrontmatterParseError("SKILL.md must begin with --- frontmatter delimiter");
  }

  // Find the closing ---
  const afterOpening = trimmed.slice(3);
  const closingIdx = afterOpening.indexOf("\n---");
  if (closingIdx === -1) {
    throw new FrontmatterParseError("SKILL.md missing closing --- frontmatter delimiter");
  }

  const frontmatterBlock = afterOpening.slice(0, closingIdx).trim();
  // Body starts after the closing --- and its trailing newline
  const afterClosing = afterOpening.slice(closingIdx + 4);
  const body = afterClosing.startsWith("\n") ? afterClosing.slice(1) : afterClosing;

  const raw = parseFrontmatterBlock(frontmatterBlock);

  // Validate required fields
  const name = expectString(raw, "name");
  const description = expectString(raw, "description");

  const frontmatter: SkillFrontmatter = {
    name,
    description,
    ...(raw["license"] !== undefined ? { license: String(raw["license"]) } : {}),
    ...(raw["compatibility"] !== undefined ? { compatibility: String(raw["compatibility"]) } : {}),
    ...(raw["metadata"] !== undefined ? { metadata: raw["metadata"] as Readonly<Record<string, string>> } : {}),
    ...(raw["allowed-tools"] !== undefined
      ? { allowedTools: parseSpaceDelimitedList(String(raw["allowed-tools"])) }
      : {}),
  };

  return { frontmatter, body: body.trimEnd() };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function parseFrontmatterBlock(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = block.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines and comments
    if (line === undefined || line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const valueAfterColon = line.slice(colonIdx + 1).trim();

    // Check if this is a nested block (value is empty and next lines are indented)
    if (valueAfterColon === "") {
      const nested: Record<string, string> = {};
      i++;
      while (i < lines.length) {
        const nestedLine = lines[i];
        if (nestedLine === undefined || nestedLine.trim() === "") {
          i++;
          continue;
        }
        // Check indentation (at least 2 spaces)
        if (nestedLine.startsWith("  ") || nestedLine.startsWith("\t")) {
          const nestedColonIdx = nestedLine.indexOf(":");
          if (nestedColonIdx !== -1) {
            const nestedKey = nestedLine.slice(0, nestedColonIdx).trim();
            const nestedValue = unquote(nestedLine.slice(nestedColonIdx + 1).trim());
            nested[nestedKey] = nestedValue;
          }
          i++;
        } else {
          break;
        }
      }
      result[key] = nested;
    } else {
      result[key] = unquote(valueAfterColon);
      i++;
    }
  }

  return result;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function expectString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (value === undefined || value === null || typeof value !== "string" || value.length === 0) {
    throw new FrontmatterParseError(`SKILL.md frontmatter missing required field: "${key}"`);
  }
  return value;
}

function parseSpaceDelimitedList(value: string): readonly string[] {
  return value
    .split(/\s+/)
    .filter((s) => s.length > 0);
}
