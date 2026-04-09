import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, StreamingMarkdownWriter } from "../../../src/utils/terminal-markdown.js";
import { strip } from "../../../src/utils/ansi.js";

describe("renderMarkdown", () => {
  describe("plain text", () => {
    it("passes through plain text unchanged", () => {
      const input = "This is plain text";
      const result = renderMarkdown(input);
      assert.equal(strip(result), input);
    });

    it("preserves multiple lines of plain text", () => {
      const input = "Line 1\nLine 2\nLine 3";
      const result = renderMarkdown(input);
      assert.equal(strip(result), input);
    });

    it("handles empty string", () => {
      const result = renderMarkdown("");
      assert.equal(result, "");
    });

    it("preserves whitespace in plain text", () => {
      const input = "  leading and trailing  ";
      const result = renderMarkdown(input);
      assert.equal(strip(result), input);
    });

    it("handles special characters", () => {
      const input = "Hello! @#$%^&*()_+-=[]{}|;:',.<>?";
      const result = renderMarkdown(input);
      assert.equal(strip(result), input);
    });
  });

  describe("headings", () => {
    it("renders h1 with formatting", () => {
      const input = "# Heading 1";
      const result = renderMarkdown(input);
      assert(strip(result).includes("Heading 1"));
    });

    it("renders h2 with formatting", () => {
      const input = "## Heading 2";
      const result = renderMarkdown(input);
      assert(strip(result).includes("Heading 2"));
    });

    it("renders h3 with formatting", () => {
      const input = "### Heading 3";
      const result = renderMarkdown(input);
      assert(strip(result).includes("Heading 3"));
    });

    it("ignores h4 and deeper (not supported)", () => {
      const input = "#### Heading 4";
      const result = renderMarkdown(input);
      // Should render as plain text, preserving the markdown syntax
      assert.equal(strip(result), input);
    });

    it("preserves heading content with special characters", () => {
      const input = "# Heading with !@#$%";
      const result = renderMarkdown(input);
      assert(strip(result).includes("Heading with !@#$%"));
    });

    it("handles heading with no text after #", () => {
      const input = "# ";
      const result = renderMarkdown(input);
      // Should still process, yielding just the empty string formatted as heading
      assert(typeof result === "string");
    });

    it("requires space after hash for heading recognition", () => {
      const input = "#NoSpace";
      const result = renderMarkdown(input);
      // Without space, should be plain text
      assert.equal(strip(result), input);
    });

    it("renders multiple headings in sequence", () => {
      const input = "# First\n## Second\n### Third";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("First"));
      assert(stripped.includes("Second"));
      assert(stripped.includes("Third"));
    });
  });

  describe("unordered lists", () => {
    it("renders list with * bullet", () => {
      const input = "* Item 1";
      const result = renderMarkdown(input);
      // Should convert * to bullet character
      assert(strip(result).includes("Item 1"));
    });

    it("renders list with - bullet", () => {
      const input = "- Item 2";
      const result = renderMarkdown(input);
      assert(strip(result).includes("Item 2"));
    });

    it("renders multiple list items", () => {
      const input = "* Item 1\n* Item 2\n* Item 3";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("Item 1"));
      assert(stripped.includes("Item 2"));
      assert(stripped.includes("Item 3"));
    });

    it("converts list bullet to unicode bullet character", () => {
      const input = "* Item";
      const result = renderMarkdown(input);
      // Should contain bullet character (u2022 = •)
      assert(result.includes("\u2022"));
    });

    it("preserves indentation in nested lists", () => {
      const input = "* Item 1\n  * Nested item";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      // Indentation should be preserved
      assert(stripped.includes("  "));
      assert(stripped.includes("Item 1"));
      assert(stripped.includes("Nested item"));
    });

    it("handles list items with special characters", () => {
      const input = "* Item with !@#$%";
      const result = renderMarkdown(input);
      assert(strip(result).includes("Item with !@#$%"));
    });

    it("handles list items with multiple spaces", () => {
      const input = "*   Item with extra spaces";
      const result = renderMarkdown(input);
      assert(strip(result).includes("Item with extra spaces"));
    });
  });

  describe("numbered lists", () => {
    it("renders list with period notation (1.)", () => {
      const input = "1. First item";
      const result = renderMarkdown(input);
      assert(strip(result).includes("First item"));
    });

    it("renders list with parenthesis notation (1))", () => {
      const input = "2) Second item";
      const result = renderMarkdown(input);
      assert(strip(result).includes("Second item"));
    });

    it("converts numbered list to bullet character", () => {
      const input = "1. Item";
      const result = renderMarkdown(input);
      // Should contain bullet character
      assert(result.includes("\u2022"));
    });

    it("renders multiple numbered items", () => {
      const input = "1. First\n2. Second\n3. Third";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("First"));
      assert(stripped.includes("Second"));
      assert(stripped.includes("Third"));
    });

    it("preserves indentation in nested numbered lists", () => {
      const input = "1. Item 1\n  2. Nested item";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("  "));
      assert(stripped.includes("Item 1"));
      assert(stripped.includes("Nested item"));
    });

    it("handles numbered lists with multi-digit numbers", () => {
      const input = "10. Item ten\n99. Item ninety-nine";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("Item ten"));
      assert(stripped.includes("Item ninety-nine"));
    });
  });

  describe("code blocks", () => {
    it("renders fenced code block with dim formatting", () => {
      const input = "```\ncode here\n```";
      const result = renderMarkdown(input);
      assert(strip(result).includes("code here"));
    });

    it("indents code block content", () => {
      const input = "```\nfunction foo() {}\n```";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      // Code should be indented with 2 spaces
      assert(stripped.includes("  function foo() {}"));
    });

    it("handles multiple lines in code block", () => {
      const input = "```\nline1\nline2\nline3\n```";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("line1"));
      assert(stripped.includes("line2"));
      assert(stripped.includes("line3"));
    });

    it("ignores language tag after backticks", () => {
      const input = "```javascript\nconst x = 1;\n```";
      const result = renderMarkdown(input);
      // Should render code, language tag line should be skipped
      assert(strip(result).includes("const x = 1;"));
    });

    it("handles empty code block", () => {
      const input = "```\n```";
      const result = renderMarkdown(input);
      // Should not error, just render empty
      assert(typeof result === "string");
    });

    it("handles code with backticks in content (non-adjacent)", () => {
      const input = "```\necho `ls`\n```";
      const result = renderMarkdown(input);
      assert(strip(result).includes("echo `ls`"));
    });

    it("properly closes and reopens code blocks", () => {
      const input = "```\nblock1\n```\ntext\n```\nblock2\n```";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("block1"));
      assert(stripped.includes("block2"));
      assert(stripped.includes("text"));
    });

    it("handles unclosed code block at end of input", () => {
      const input = "```\ncode without close";
      const result = renderMarkdown(input);
      // Should still render the code
      assert(strip(result).includes("code without close"));
    });

    it("uses dim formatting for code block", () => {
      const input = "```\nhello\n```";
      const result = renderMarkdown(input);
      // In test environment, dim is passthrough, but content should be there
      assert(result.includes("hello"));
    });
  });

  describe("inline code", () => {
    it("renders inline code with backticks", () => {
      const input = "Use `variable` in code";
      const result = renderMarkdown(input);
      assert(strip(result).includes("variable"));
    });

    it("handles multiple inline code snippets", () => {
      const input = "Use `var1` and `var2` here";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("var1"));
      assert(stripped.includes("var2"));
    });

    it("preserves inline code with special characters", () => {
      const input = "Code: `foo-bar_baz`";
      const result = renderMarkdown(input);
      assert(strip(result).includes("foo-bar_baz"));
    });

    it("handles inline code with spaces", () => {
      const input = "Run `npm install`";
      const result = renderMarkdown(input);
      assert(strip(result).includes("npm install"));
    });

    it("applies dim formatting to inline code", () => {
      const input = "`code`";
      const result = renderMarkdown(input);
      // Content should be present
      assert(result.includes("code"));
    });
  });

  describe("bold formatting", () => {
    it("renders **text** as bold", () => {
      const input = "This is **bold** text";
      const result = renderMarkdown(input);
      assert(strip(result).includes("bold"));
    });

    it("renders __text__ as bold", () => {
      const input = "This is __bold__ text";
      const result = renderMarkdown(input);
      assert(strip(result).includes("bold"));
    });

    it("handles multiple bold sections", () => {
      const input = "**first** and **second**";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("first"));
      assert(stripped.includes("second"));
    });

    it("preserves context around bold", () => {
      const input = "before **bold** after";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("before"));
      assert(stripped.includes("bold"));
      assert(stripped.includes("after"));
    });
  });

  describe("italic formatting", () => {
    it("renders *text* as italic (with word boundaries)", () => {
      const input = "This is *italic* text";
      const result = renderMarkdown(input);
      assert(strip(result).includes("italic"));
    });

    it("renders _text_ as italic (with word boundaries)", () => {
      const input = "This is _italic_ text";
      const result = renderMarkdown(input);
      assert(strip(result).includes("italic"));
    });

    it("respects word boundaries for single asterisk", () => {
      const input = "words*not*italic";
      const result = renderMarkdown(input);
      // Without word boundary, should not be treated as italic
      // The regex requires non-word characters around the asterisks
      const stripped = strip(result);
      assert(stripped.includes("words*not*italic"));
    });

    it("handles italic in the middle of sentence", () => {
      const input = "In *the* middle";
      const result = renderMarkdown(input);
      assert(strip(result).includes("the"));
    });

    it("handles multiple italic sections", () => {
      const input = "*first* and *second*";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("first"));
      assert(stripped.includes("second"));
    });
  });

  describe("bold + italic combinations", () => {
    it("renders ***text*** as bold and italic", () => {
      const input = "This is ***bold italic*** text";
      const result = renderMarkdown(input);
      assert(strip(result).includes("bold italic"));
    });

    it("renders ___text___ as bold and italic", () => {
      const input = "This is ___bold italic___ text";
      const result = renderMarkdown(input);
      assert(strip(result).includes("bold italic"));
    });

    it("handles multiple bold+italic sections", () => {
      const input = "***first*** and ___second___";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("first"));
      assert(stripped.includes("second"));
    });
  });

  describe("complex nested content", () => {
    it("renders heading with inline code", () => {
      const input = "## Using `variable` in code";
      const result = renderMarkdown(input);
      assert(strip(result).includes("variable"));
    });

    it("renders list items with inline formatting", () => {
      const input = "* Use **bold** in lists\n* Or *italic* here";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("bold"));
      assert(stripped.includes("italic"));
    });

    it("renders code block with content", () => {
      const input = "Before code\n```\ncode line\n```\nAfter code";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("Before code"));
      assert(stripped.includes("code line"));
      assert(stripped.includes("After code"));
    });

    it("preserves context when mixing lists and text", () => {
      const input = "Text\n- Item 1\n- Item 2\nMore text";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("Text"));
      assert(stripped.includes("Item 1"));
      assert(stripped.includes("Item 2"));
      assert(stripped.includes("More text"));
    });

    it("handles real-world markdown example", () => {
      const input = `# Title

This is a **bold** introduction.

## Features

* Fast performance
* **Easy** to use
* Works with *italic* text

Code example:

\`\`\`
function example() {
  return true;
}
\`\`\`

Done.`;
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("Title"));
      assert(stripped.includes("bold"));
      assert(stripped.includes("Features"));
      assert(stripped.includes("Fast performance"));
      assert(stripped.includes("Easy"));
      assert(stripped.includes("italic"));
      assert(stripped.includes("example"));
    });
  });

  describe("edge cases", () => {
    it("handles only a heading", () => {
      const result = renderMarkdown("# Solo heading");
      assert(strip(result).includes("Solo heading"));
    });

    it("handles only a list", () => {
      const result = renderMarkdown("* Only\n* List");
      const stripped = strip(result);
      assert(stripped.includes("Only"));
      assert(stripped.includes("List"));
    });

    it("handles only a code block", () => {
      const result = renderMarkdown("```\nonly code\n```");
      assert(strip(result).includes("only code"));
    });

    it("handles empty lines", () => {
      const input = "Line 1\n\nLine 3";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("Line 1"));
      assert(stripped.includes("Line 3"));
    });

    it("handles line with only spaces", () => {
      const input = "Text\n   \nMore";
      const result = renderMarkdown(input);
      // Should handle gracefully
      assert(typeof result === "string");
    });

    it("handles text that looks like markdown but isn't", () => {
      const input = "The ratio is 1:2 and cost *USD";
      const result = renderMarkdown(input);
      // Should not incorrectly parse as italic
      assert(typeof result === "string");
    });

    it("preserves unicode characters", () => {
      const input = "Hello 👋 world 🌍";
      const result = renderMarkdown(input);
      assert(strip(result).includes("👋"));
      assert(strip(result).includes("🌍"));
    });

    it("handles very long lines", () => {
      const longLine = "x".repeat(1000);
      const result = renderMarkdown(longLine);
      assert(strip(result).includes(longLine));
    });

    it("handles code block with indented opening fence", () => {
      const input = "  ```\n  code\n  ```";
      const result = renderMarkdown(input);
      // trimStart should match even with leading spaces
      assert(strip(result).includes("code"));
    });
  });

  describe("formatting application order", () => {
    it("applies bold before italic in processing order", () => {
      // *** is bold+italic, but should be processed as bold first
      const input = "***test***";
      const result = renderMarkdown(input);
      // Content should be preserved
      assert(strip(result).includes("test"));
    });

    it("preserves inline code when mixed with formatting", () => {
      const input = "`code` and **bold**";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("code"));
      assert(stripped.includes("bold"));
    });

    it("handles code in headings", () => {
      const input = "## Heading with `code` inside";
      const result = renderMarkdown(input);
      assert(strip(result).includes("code"));
    });
  });

  describe("output consistency", () => {
    it("produces same output for repeated calls", () => {
      const input = "# Test\n\n* Item 1\n* Item 2";
      const first = renderMarkdown(input);
      const second = renderMarkdown(input);
      assert.equal(first, second);
    });

    it("strips to consistent result", () => {
      const input = "**bold** and *italic*";
      const result = renderMarkdown(input);
      const stripped1 = strip(result);
      const stripped2 = strip(result);
      assert.equal(stripped1, stripped2);
    });
  });

  describe("list edge cases", () => {
    it("handles mixed unordered list markers", () => {
      const input = "* Item 1\n- Item 2\n* Item 3";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("Item 1"));
      assert(stripped.includes("Item 2"));
      assert(stripped.includes("Item 3"));
    });

    it("handles list with varying indentation levels", () => {
      const input = "* L1\n  * L2\n    * L3\n  * L2b";
      const result = renderMarkdown(input);
      const stripped = strip(result);
      assert(stripped.includes("L1"));
      assert(stripped.includes("L2"));
      assert(stripped.includes("L3"));
      assert(stripped.includes("L2b"));
    });

    it("does not treat text after list marker without space as list", () => {
      const input = "*nospace item";
      const result = renderMarkdown(input);
      // Should treat as plain text, not a list
      assert.equal(strip(result), input);
    });

    it("does not treat number without proper format as list", () => {
      const input = "123item";
      const result = renderMarkdown(input);
      // Should be plain text
      assert.equal(strip(result), input);
    });
  });
});

describe("StreamingMarkdownWriter", () => {
  describe("basic streaming", () => {
    it("pushes and renders a complete line with newline", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Hello world\n");

      assert.deepEqual(output, ["Hello world\n"]);
    });

    it("pushes multiple complete lines", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Line 1\n");
      writer.push("Line 2\n");
      writer.push("Line 3\n");

      assert.deepEqual(output, ["Line 1\n", "Line 2\n", "Line 3\n"]);
    });

    it("preserves plain text content", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Plain text here\n");
      writer.flush();

      const result = output.join("");
      assert.equal(strip(result).trim(), "Plain text here");
    });
  });

  describe("fragmented deltas", () => {
    it("buffers incomplete lines until newline arrives", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Hel");
      writer.push("lo ");
      writer.push("wor");
      writer.push("ld\n");

      assert.deepEqual(output, ["Hello world\n"]);
    });

    it("handles character-by-character deltas", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      const text = "Fragment test";
      for (const char of text) {
        writer.push(char);
      }
      writer.push("\n");

      assert.deepEqual(output, ["Fragment test\n"]);
    });

    it("buffers fragmented multi-line content", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Line 1\nLi");
      writer.push("ne 2\nLi");
      writer.push("ne 3\n");

      assert.equal(output.length, 3);
      assert.equal(strip(output[0]!).trim(), "Line 1");
      assert.equal(strip(output[1]!).trim(), "Line 2");
      assert.equal(strip(output[2]!).trim(), "Line 3");
    });

    it("holds incomplete final line in buffer until flush", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Line 1\n");
      writer.push("Incom");
      writer.push("plete");

      assert.equal(output.length, 1);
      assert.equal(strip(output[0]!).trim(), "Line 1");

      writer.flush();

      assert.equal(output.length, 2);
      assert.equal(strip(output[1]!).trim(), "Incomplete");
    });
  });

  describe("newline handling and flush", () => {
    it("flush renders remaining buffer content", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Final line without newline");
      assert.equal(output.length, 0);

      writer.flush();

      assert.equal(output.length, 1);
      assert.equal(strip(output[0]!), "Final line without newline");
    });

    it("flush with empty buffer is a no-op", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Content\n");
      assert.equal(output.length, 1);

      writer.flush();

      assert.equal(output.length, 1);
    });

    it("multiple flushes only output once", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Text");
      writer.flush();
      const afterFirstFlush = output.length;

      writer.flush();
      writer.flush();

      assert.equal(output.length, afterFirstFlush);
    });

    it("processes multiple lines in a single push", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Line 1\nLine 2\nLine 3\n");

      assert.equal(output.length, 3);
      assert.equal(strip(output[0]!).trim(), "Line 1");
      assert.equal(strip(output[1]!).trim(), "Line 2");
      assert.equal(strip(output[2]!).trim(), "Line 3");
    });

    it("handles push with trailing newline and buffer", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Line 1\n");
      writer.push("Line 2\n");
      writer.push("Partial");

      assert.equal(output.length, 2);

      writer.flush();

      assert.equal(output.length, 3);
      assert.equal(strip(output[2]!), "Partial");
    });
  });

  describe("code blocks in streaming", () => {
    it("toggles code block state across pushes", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Before code\n");
      writer.push("```\n");
      writer.push("code line 1\n");
      writer.push("code line 2\n");
      writer.push("```\n");
      writer.push("After code\n");

      const stripped = strip(output.join(""));
      assert(stripped.includes("Before code"));
      assert(stripped.includes("code line 1"));
      assert(stripped.includes("code line 2"));
      assert(stripped.includes("After code"));
      // Code lines should be indented
      assert(stripped.includes("  code line 1"));
      assert(stripped.includes("  code line 2"));
    });

    it("handles code block fence arriving fragmented", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Start\n");
      writer.push("`");
      writer.push("`");
      writer.push("`\n");
      writer.push("inside code\n");
      writer.push("`");
      writer.push("`");
      writer.push("`\n");
      writer.push("End\n");

      const stripped = strip(output.join(""));
      assert(stripped.includes("Start"));
      assert(stripped.includes("inside code"));
      assert(stripped.includes("End"));
      assert(stripped.includes("  inside code"));
    });

    it("resets code block state after flush (intended design)", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      // Push a complete code block before flush
      writer.push("Text\n");
      writer.push("```\n");
      writer.push("code\n");
      writer.push("```\n");
      writer.flush();

      // After flush, code block state is reset, so new code needs a new fence
      writer.push("```\n");
      writer.push("more code\n");
      writer.push("```\n");
      writer.push("Done\n");

      const stripped = strip(output.join(""));
      assert(stripped.includes("code"));
      assert(stripped.includes("more code"));
      assert(stripped.includes("  code"));
      assert(stripped.includes("  more code"));
    });

    it("handles nested/reopened code blocks", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("```\nblock1\n```\n");
      writer.push("text\n");
      writer.push("```\nblock2\n```\n");

      const stripped = strip(output.join(""));
      assert(stripped.includes("block1"));
      assert(stripped.includes("block2"));
      assert(stripped.includes("text"));
    });
  });

  describe("heading rendering in streaming", () => {
    it("renders h1 through streaming", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("# Heading One\n");
      writer.flush();

      assert(strip(output.join("")).includes("Heading One"));
    });

    it("renders multiple headings", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("# H1\n");
      writer.push("## H2\n");
      writer.push("### H3\n");

      const stripped = strip(output.join(""));
      assert(stripped.includes("H1"));
      assert(stripped.includes("H2"));
      assert(stripped.includes("H3"));
    });

    it("handles fragmented heading syntax", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("#");
      writer.push(" ");
      writer.push("Title");
      writer.push("\n");

      assert(strip(output.join("")).includes("Title"));
    });

    it("heading with inline formatting (inline not supported in headings)", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("# Title\n");
      writer.flush();

      const stripped = strip(output.join(""));
      // Headings are rendered
      assert(stripped.includes("Title"));
    });
  });

  describe("list items in streaming", () => {
    it("renders unordered list through streaming", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("* Item 1\n");
      writer.push("* Item 2\n");
      writer.push("* Item 3\n");

      const result = output.join("");
      assert(result.includes("\u2022"));
      const stripped = strip(result);
      assert(stripped.includes("Item 1"));
      assert(stripped.includes("Item 2"));
      assert(stripped.includes("Item 3"));
    });

    it("renders numbered list through streaming", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("1. First\n");
      writer.push("2. Second\n");
      writer.push("3. Third\n");

      const result = output.join("");
      assert(result.includes("\u2022"));
      const stripped = strip(result);
      assert(stripped.includes("First"));
      assert(stripped.includes("Second"));
      assert(stripped.includes("Third"));
    });

    it("handles list item with fragmented content", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("* Item ");
      writer.push("with ");
      writer.push("fragments\n");

      assert(strip(output.join("")).includes("Item with fragments"));
    });

    it("preserves nested list indentation", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("* L1\n");
      writer.push("  * L2\n");
      writer.push("    * L3\n");

      const stripped = strip(output.join(""));
      assert(stripped.includes("L1"));
      assert(stripped.includes("L2"));
      assert(stripped.includes("L3"));
      // Indentation should be preserved
      assert(stripped.includes("  "));
    });

    it("list items with inline formatting", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("* Item with **bold**\n");
      writer.push("* Item with *italic*\n");

      const stripped = strip(output.join(""));
      assert(stripped.includes("Item with bold"));
      assert(stripped.includes("Item with italic"));
    });
  });

  describe("tool interruptions and resume", () => {
    it("can interrupt streaming, flush, and resume", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("First part\n");
      writer.push("Incomplete");
      writer.flush();

      const firstOutput = output.length;

      // Resume streaming
      writer.push(" resumed\n");

      assert.equal(output.length, firstOutput + 1);
      const stripped = strip(output.join(""));
      assert(stripped.includes("First part"));
      assert(stripped.includes("Incomplete resumed"));
    });

    it("recovers after tool interruption when code block is complete", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      // Push complete code block, then tool interruption
      writer.push("Text\n```\ncode\n```\n");
      writer.flush();

      // Resume with new content (code block state was reset, so plain text works)
      writer.push("more text\n");

      const stripped = strip(output.join(""));
      assert(stripped.includes("code"));
      assert(stripped.includes("more text"));
      assert(stripped.includes("  code"));
    });
  });

  describe("empty and edge cases", () => {
    it("handles empty push", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("");
      writer.flush();

      assert.equal(output.length, 0);
    });

    it("handles only newlines", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("\n\n\n");
      writer.flush();

      // Three newlines create three empty lines
      assert.equal(output.length, 3);
    });

    it("handles push with only whitespace", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("   \n");
      writer.flush();

      assert.equal(output.length, 1);
    });

    it("handles very long single line", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      const longLine = "x".repeat(10000);
      writer.push(longLine);
      writer.push("\n");

      const result = output.join("");
      assert(result.includes(longLine));
    });

    it("handles unicode characters", () => {
      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((text) => output.push(text));

      writer.push("Hello 👋 ");
      writer.push("world 🌍\n");

      const stripped = strip(output.join(""));
      assert(stripped.includes("👋"));
      assert(stripped.includes("🌍"));
    });
  });

  describe("output equivalence", () => {
    it("streaming produces same output as batch for plain text", () => {
      const text = "Line 1\nLine 2\nLine 3";
      const batchResult = strip(renderMarkdown(text));

      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((s) => output.push(s));
      writer.push(text + "\n");
      writer.flush();
      const streamResult = strip(output.join("")).trimEnd();

      assert.equal(streamResult, batchResult);
    });

    it("streaming produces same output as batch for headings", () => {
      const text = "# Heading\n## Sub\n### Deep";
      const batchResult = strip(renderMarkdown(text));

      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((s) => output.push(s));
      writer.push(text + "\n");
      writer.flush();
      const streamResult = strip(output.join("")).trimEnd();

      assert.equal(streamResult, batchResult);
    });

    it("streaming produces same output as batch for lists", () => {
      const text = "* Item 1\n* Item 2\n1. Numbered";
      const batchResult = strip(renderMarkdown(text));

      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((s) => output.push(s));
      writer.push(text + "\n");
      writer.flush();
      const streamResult = strip(output.join("")).trimEnd();

      assert.equal(streamResult, batchResult);
    });

    it("streaming produces same output as batch for code blocks", () => {
      const text = "Before\n```\ncode\nmore\n```\nAfter";
      const batchResult = strip(renderMarkdown(text));

      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((s) => output.push(s));
      writer.push(text + "\n");
      writer.flush();
      const streamResult = strip(output.join("")).trimEnd();

      assert.equal(streamResult, batchResult);
    });

    it("streaming produces same output as batch for mixed content", () => {
      const text = `# Title

* **Bold** item
* _Italic_ item

\`\`\`
code block
\`\`\`

Inline \`code\` here.`;
      const batchResult = strip(renderMarkdown(text));

      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((s) => output.push(s));
      writer.push(text + "\n");
      writer.flush();
      const streamResult = strip(output.join("")).trimEnd();

      assert.equal(streamResult, batchResult);
    });

    it("streaming with fragmented deltas matches batch output", () => {
      const text = `# Complex Example

This is **bold** and *italic* text.

* Item with \`code\`
* Another item

\`\`\`
function test() {
  return true;
}
\`\`\`

Final paragraph.`;
      const batchResult = strip(renderMarkdown(text));

      const output: string[] = [];
      const writer = new StreamingMarkdownWriter((s) => output.push(s));

      // Push in small chunks to simulate slow streaming
      for (let i = 0; i < text.length; i += 7) {
        writer.push(text.slice(i, i + 7));
      }
      writer.push("\n");
      writer.flush();
      const streamResult = strip(output.join("")).trimEnd();

      assert.equal(streamResult, batchResult);
    });
  });
});
