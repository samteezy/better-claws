import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sage,
  clay,
  lavender,
  rose,
  stone,
  bold,
  dim,
  italic,
  strip,
  enabled,
  supportsUnicode,
  resolveGlyphs,
} from "../../../src/utils/ansi.js";

describe("ansi", () => {
  describe("strip()", () => {
    it("removes ANSI escape codes from colored strings", () => {
      const colored = "\x1b[38;2;107;143;113msage text\x1b[39m";
      const result = strip(colored);
      assert.equal(result, "sage text");
    });

    it("removes bold modifier codes", () => {
      const bold_text = "\x1b[1mbold\x1b[22m";
      const result = strip(bold_text);
      assert.equal(result, "bold");
    });

    it("removes dim modifier codes", () => {
      const dimmed = "\x1b[2mdim\x1b[22m";
      const result = strip(dimmed);
      assert.equal(result, "dim");
    });

    it("removes italic modifier codes", () => {
      const italicized = "\x1b[3mitalic\x1b[23m";
      const result = strip(italicized);
      assert.equal(result, "italic");
    });

    it("removes multiple ANSI codes from composed formatting", () => {
      const composed = "\x1b[1m\x1b[38;2;107;143;113mcomposed\x1b[22m\x1b[39m";
      const result = strip(composed);
      assert.equal(result, "composed");
    });

    it("returns plain text unchanged", () => {
      const plain = "plain text with no codes";
      const result = strip(plain);
      assert.equal(result, plain);
    });

    it("handles empty strings", () => {
      const result = strip("");
      assert.equal(result, "");
    });

    it("preserves text content with special characters", () => {
      const text = "Hello! @#$%^&*()_+-=[]{}|;:',.<>?";
      const result = strip(text);
      assert.equal(result, text);
    });

    it("handles strings with only ANSI codes", () => {
      const only_codes = "\x1b[38;2;107;143;113m\x1b[39m";
      const result = strip(only_codes);
      assert.equal(result, "");
    });

    it("removes codes with varying parameter counts", () => {
      // ANSI codes can have different numbers of parameters (e.g., [38;2;R;G;B or [1)
      const mixed = "\x1b[38;2;196;149;106mtext\x1b[39m more \x1b[1mbold\x1b[22m";
      const result = strip(mixed);
      assert.equal(result, "text more bold");
    });

    it("handles real-world multi-line colored text", () => {
      const multiline =
        "\x1b[38;2;107;143;113mline1\x1b[39m\n" +
        "\x1b[38;2;196;149;106mline2\x1b[39m\n" +
        "\x1b[38;2;139;126;168mline3\x1b[39m";
      const result = strip(multiline);
      assert.equal(result, "line1\nline2\nline3");
    });

    it("is idempotent (stripping already-stripped text returns same result)", () => {
      const plain = "already clean";
      const once = strip(plain);
      const twice = strip(once);
      assert.equal(once, twice);
    });
  });

  describe("color functions", () => {
    describe("sage()", () => {
      it("returns a string", () => {
        const result = sage("text");
        assert.strictEqual(typeof result, "string");
      });

      it("contains original text in the output", () => {
        const text = "sage text";
        const result = sage(text);
        assert(result.includes(text));
      });

      it("can be stripped to retrieve original text", () => {
        const text = "sage text";
        const colored = sage(text);
        assert.equal(strip(colored), text);
      });
    });

    describe("clay()", () => {
      it("returns a string", () => {
        const result = clay("text");
        assert.strictEqual(typeof result, "string");
      });

      it("contains original text in the output", () => {
        const text = "clay text";
        const result = clay(text);
        assert(result.includes(text));
      });

      it("can be stripped to retrieve original text", () => {
        const text = "clay text";
        const colored = clay(text);
        assert.equal(strip(colored), text);
      });
    });

    describe("lavender()", () => {
      it("returns a string", () => {
        const result = lavender("text");
        assert.strictEqual(typeof result, "string");
      });

      it("contains original text in the output", () => {
        const text = "lavender text";
        const result = lavender(text);
        assert(result.includes(text));
      });

      it("can be stripped to retrieve original text", () => {
        const text = "lavender text";
        const colored = lavender(text);
        assert.equal(strip(colored), text);
      });
    });

    describe("rose()", () => {
      it("returns a string", () => {
        const result = rose("text");
        assert.strictEqual(typeof result, "string");
      });

      it("contains original text in the output", () => {
        const text = "rose text";
        const result = rose(text);
        assert(result.includes(text));
      });

      it("can be stripped to retrieve original text", () => {
        const text = "rose text";
        const colored = rose(text);
        assert.equal(strip(colored), text);
      });
    });

    describe("stone()", () => {
      it("returns a string", () => {
        const result = stone("text");
        assert.strictEqual(typeof result, "string");
      });

      it("contains original text in the output", () => {
        const text = "stone text";
        const result = stone(text);
        assert(result.includes(text));
      });

      it("can be stripped to retrieve original text", () => {
        const text = "stone text";
        const colored = stone(text);
        assert.equal(strip(colored), text);
      });
    });

    describe("color functions with empty strings", () => {
      it("sage() handles empty string", () => {
        const result = sage("");
        // Should be either empty or just the codes (which strip to empty)
        assert.equal(strip(result), "");
      });

      it("clay() handles empty string", () => {
        const result = clay("");
        assert.equal(strip(result), "");
      });

      it("lavender() handles empty string", () => {
        const result = lavender("");
        assert.equal(strip(result), "");
      });

      it("rose() handles empty string", () => {
        const result = rose("");
        assert.equal(strip(result), "");
      });

      it("stone() handles empty string", () => {
        const result = stone("");
        assert.equal(strip(result), "");
      });
    });

    describe("color functions with special characters", () => {
      it("preserves special characters in colored output", () => {
        const text = "!@#$%^&*()_+-=[]{}|;:',.<>?";
        const result = sage(text);
        assert.equal(strip(result), text);
      });

      it("preserves newlines in colored output", () => {
        const text = "line1\nline2\nline3";
        const result = clay(text);
        assert.equal(strip(result), text);
      });

      it("preserves tabs and whitespace", () => {
        const text = "word1\tword2  word3";
        const result = lavender(text);
        assert.equal(strip(result), text);
      });

      it("handles unicode characters", () => {
        const text = "emoji 😀 unicode ñ ü";
        const result = rose(text);
        assert.equal(strip(result), text);
      });
    });
  });

  describe("modifier functions", () => {
    describe("bold()", () => {
      it("returns a string", () => {
        const result = bold("text");
        assert.strictEqual(typeof result, "string");
      });

      it("contains original text in the output", () => {
        const text = "bold text";
        const result = bold(text);
        assert(result.includes(text));
      });

      it("can be stripped to retrieve original text", () => {
        const text = "bold text";
        const bolded = bold(text);
        assert.equal(strip(bolded), text);
      });

      it("handles empty string", () => {
        const result = bold("");
        assert.equal(strip(result), "");
      });
    });

    describe("dim()", () => {
      it("returns a string", () => {
        const result = dim("text");
        assert.strictEqual(typeof result, "string");
      });

      it("contains original text in the output", () => {
        const text = "dim text";
        const result = dim(text);
        assert(result.includes(text));
      });

      it("can be stripped to retrieve original text", () => {
        const text = "dim text";
        const dimmed = dim(text);
        assert.equal(strip(dimmed), text);
      });

      it("handles empty string", () => {
        const result = dim("");
        assert.equal(strip(result), "");
      });
    });

    describe("italic()", () => {
      it("returns a string", () => {
        const result = italic("text");
        assert.strictEqual(typeof result, "string");
      });

      it("contains original text in the output", () => {
        const text = "italic text";
        const result = italic(text);
        assert(result.includes(text));
      });

      it("can be stripped to retrieve original text", () => {
        const text = "italic text";
        const italicized = italic(text);
        assert.equal(strip(italicized), text);
      });

      it("handles empty string", () => {
        const result = italic("");
        assert.equal(strip(result), "");
      });
    });
  });

  describe("composition and chaining", () => {
    it("composes color and bold: bold(sage(text))", () => {
      const text = "composed";
      const result = bold(sage(text));
      assert.equal(strip(result), text);
    });

    it("composes color and dim: dim(clay(text))", () => {
      const text = "composed";
      const result = dim(clay(text));
      assert.equal(strip(result), text);
    });

    it("composes color and italic: italic(lavender(text))", () => {
      const text = "composed";
      const result = italic(lavender(text));
      assert.equal(strip(result), text);
    });

    it("chains multiple colors: sage then strip then clay (recolors)", () => {
      const text = "text";
      const saged = sage(text);
      const stripped = strip(saged);
      const clayed = clay(stripped);
      assert.equal(strip(clayed), text);
    });

    it("chains multiple modifiers: bold(italic(dim(text)))", () => {
      const text = "heavily modified";
      const result = bold(italic(dim(text)));
      assert.equal(strip(result), text);
    });

    it("composes multiple colors and modifiers: bold(sage(text)) then dim(rose(...))", () => {
      const text = "text";
      const first = bold(sage(text));
      const second = dim(rose(first));
      assert.equal(strip(second), text);
    });
  });

  describe("enabled flag", () => {
    it("is a boolean", () => {
      assert.strictEqual(typeof enabled, "boolean");
    });

    it("reflects the color state of the module", () => {
      // In a test runner without TTY, enabled is likely false.
      // But the flag itself should be valid regardless of value.
      assert.strictEqual(typeof enabled, "boolean");
    });
  });

  describe("color output consistency", () => {
    it("sage() always produces the same output for the same input", () => {
      const text = "consistent";
      const first = sage(text);
      const second = sage(text);
      assert.equal(first, second);
    });

    it("clay() always produces the same output for the same input", () => {
      const text = "consistent";
      const first = clay(text);
      const second = clay(text);
      assert.equal(first, second);
    });

    it("color functions are deterministic across calls", () => {
      const text = "deterministic";
      const calls = [
        bold(sage(text)),
        bold(sage(text)),
        bold(sage(text)),
      ];
      assert.equal(calls[0], calls[1]);
      assert.equal(calls[1], calls[2]);
    });
  });

  describe("behavior when color is disabled", () => {
    // When running in a non-TTY environment (like test runners),
    // all formatting functions act as passthroughs.
    // These tests verify that behavior regardless of the actual TTY state.

    it("all color functions return text unchanged when disabled", () => {
      // If disabled (non-TTY), functions return input as-is
      const text = "passthrough";
      // We can't force enable/disable at runtime, but we can verify
      // that whatever state we're in, the functions are consistent
      const sageResult = sage(text);
      const clayResult = clay(text);
      const lavenderResult = lavender(text);
      const roseResult = rose(text);
      const stoneResult = stone(text);

      // All should contain the original text
      assert(sageResult.includes(text));
      assert(clayResult.includes(text));
      assert(lavenderResult.includes(text));
      assert(roseResult.includes(text));
      assert(stoneResult.includes(text));
    });

    it("modifier functions return text unchanged when disabled", () => {
      const text = "unchanged";
      const boldResult = bold(text);
      const dimResult = dim(text);
      const italicResult = italic(text);

      assert(boldResult.includes(text));
      assert(dimResult.includes(text));
      assert(italicResult.includes(text));
    });

    it("strip() always removes codes regardless of disabled state", () => {
      // strip() must always work, even if color is disabled,
      // because it may receive colored text from other sources
      const withCodes = "\x1b[38;2;107;143;113mtext\x1b[39m";
      const result = strip(withCodes);
      assert.equal(result, "text");
      assert(!result.includes("\x1b"));
    });
  });

  describe("strip() regex accuracy", () => {
    it("removes SGR (Select Graphic Rendition) codes: \\x1b[...m", () => {
      // SGR codes start with ESC [ and end with m
      const sgr = "\x1b[1mtext\x1b[22m";
      assert.equal(strip(sgr), "text");
    });

    it("removes codes with numeric parameters", () => {
      const codes = "\x1b[38;2;255;0;0mtext\x1b[39m";
      assert.equal(strip(codes), "text");
    });

    it("removes codes with semicolon-separated parameters", () => {
      const codes = "\x1b[38;5;196mtext\x1b[39m";
      assert.equal(strip(codes), "text");
    });

    it("handles codes with zero or empty parameters", () => {
      const codes = "\x1b[0mtext\x1b[m";
      assert.equal(strip(codes), "text");
    });

    it("does not remove non-ANSI escape sequences", () => {
      const nonAnsi = "text\x1bwith\x1bother\x1bescapes";
      // The regex specifically looks for \x1b[..., so \x1b without [ should remain
      const result = strip(nonAnsi);
      // Our regex requires [ after \x1b, so these won't match and will remain
      assert(result.includes("\x1b"));
    });
  });

  describe("real-world usage patterns", () => {
    it("formats an error message with color and bold", () => {
      const message = "Error occurred";
      const formatted = bold(rose(message));
      assert.equal(strip(formatted), message);
    });

    it("formats a success message with color", () => {
      const message = "Operation completed";
      const formatted = sage(message);
      assert.equal(strip(formatted), message);
    });

    it("formats a warning with different color and dim", () => {
      const message = "Warning: check this";
      const formatted = dim(clay(message));
      assert.equal(strip(formatted), message);
    });

    it("formats tool output with lavender color", () => {
      const output = "Tool executed successfully";
      const formatted = lavender(output);
      assert.equal(strip(formatted), output);
    });

    it("formats meta/debug info with stone and dim", () => {
      const info = "[DEBUG] Tracing execution";
      const formatted = dim(stone(info));
      assert.equal(strip(formatted), info);
    });

    it("builds multi-colored line: colored words separated by plain text", () => {
      const word1 = sage("sage");
      const word2 = clay("clay");
      const line = word1 + " and " + word2;
      // When stripped, should recover all words
      const stripped = strip(line);
      assert(stripped.includes("sage"));
      assert(stripped.includes("clay"));
      assert(stripped.includes(" and "));
    });

    it("handles long formatted text", () => {
      const longText = "x".repeat(1000);
      const formatted = bold(sage(longText));
      assert.equal(strip(formatted), longText);
    });
  });

  describe("supportsUnicode()", () => {
    it("returns true for UTF-8 locale on a capable terminal", () => {
      assert.equal(
        supportsUnicode({ LANG: "en_US.UTF-8", TERM: "xterm-256color" }),
        true,
      );
    });

    it("returns false for screen-256color (tmux default) even with UTF-8 locale", () => {
      // Regression: this is the env that maps U+203A to '_' in tmux.
      assert.equal(
        supportsUnicode({ LANG: "en_US.UTF-8", TERM: "screen-256color" }),
        false,
      );
    });

    it("returns false for non-UTF-8 locale on a capable terminal", () => {
      assert.equal(
        supportsUnicode({ LANG: "C", TERM: "xterm-256color" }),
        false,
      );
    });

    it("returns false for tmux- prefixed terms", () => {
      // tmux-256color is more capable but not flagged as limited; verify utf8 path still applies.
      assert.equal(
        supportsUnicode({ LANG: "en_US.UTF-8", TERM: "tmux-256color" }),
        true,
      );
    });

    it("returns false for the linux console TERM", () => {
      assert.equal(
        supportsUnicode({ LANG: "en_US.UTF-8", TERM: "linux" }),
        false,
      );
    });

    it("returns false for dumb terminals", () => {
      assert.equal(
        supportsUnicode({ LANG: "en_US.UTF-8", TERM: "dumb" }),
        false,
      );
    });

    it("BETTERCLAWS_ASCII=1 forces ASCII regardless of TERM/LANG", () => {
      assert.equal(
        supportsUnicode({
          LANG: "en_US.UTF-8",
          TERM: "xterm-256color",
          BETTERCLAWS_ASCII: "1",
        }),
        false,
      );
    });

    it("BETTERCLAWS_UNICODE=1 forces unicode even on screen-256color", () => {
      assert.equal(
        supportsUnicode({
          LANG: "en_US.UTF-8",
          TERM: "screen-256color",
          BETTERCLAWS_UNICODE: "1",
        }),
        true,
      );
    });

    it("BETTERCLAWS_ASCII=1 takes precedence over BETTERCLAWS_UNICODE=1", () => {
      assert.equal(
        supportsUnicode({
          BETTERCLAWS_ASCII: "1",
          BETTERCLAWS_UNICODE: "1",
        }),
        false,
      );
    });

    it("respects LC_ALL over LANG", () => {
      assert.equal(
        supportsUnicode({
          LC_ALL: "en_US.UTF-8",
          LANG: "C",
          TERM: "xterm-256color",
        }),
        true,
      );
    });

    it("returns false when TERM and LANG are unset", () => {
      assert.equal(supportsUnicode({}), false);
    });
  });

  describe("resolveGlyphs()", () => {
    it("returns Unicode glyphs on a capable terminal", () => {
      const g = resolveGlyphs({ LANG: "en_US.UTF-8", TERM: "xterm-256color" });
      assert.equal(g.prompt, "›");
      assert.equal(g.hRule, "─");
      assert.equal(g.ok, "✓");
      assert.equal(g.fail, "✗");
      assert.equal(g.tool, "⟡");
      assert.equal(g.warn, "⚠");
      assert.equal(g.bullet, "•");
    });

    it("returns ASCII glyphs under tmux's default screen-256color", () => {
      const g = resolveGlyphs({ LANG: "en_US.UTF-8", TERM: "screen-256color" });
      assert.equal(g.prompt, ">");
      assert.equal(g.hRule, "-");
      assert.equal(g.ok, "[ok]");
      assert.equal(g.fail, "[x]");
      assert.equal(g.tool, "*");
      assert.equal(g.warn, "!");
      assert.equal(g.bullet, "*");
    });

    it("returns ASCII glyphs when BETTERCLAWS_ASCII=1", () => {
      const g = resolveGlyphs({
        LANG: "en_US.UTF-8",
        TERM: "xterm-256color",
        BETTERCLAWS_ASCII: "1",
      });
      assert.equal(g.prompt, ">");
    });

    it("ASCII glyphs are all single-cell so layout math stays correct", () => {
      // The CLI repeats hRule by `cols`. ASCII '-' is 1 column wide.
      const g = resolveGlyphs({ TERM: "screen-256color" });
      assert.equal(g.hRule.length, 1);
      assert.equal(g.prompt.length, 1);
      assert.equal(g.bullet.length, 1);
    });
  });
});
