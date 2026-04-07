import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSkillMd, FrontmatterParseError } from "../../src/skills/frontmatter-parser.js";

describe("parseSkillMd", () => {
  describe("valid parsing", () => {
    it("parses basic frontmatter with name and description", () => {
      const content = `---
name: test-skill
description: A test skill
---
Body content`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "test-skill");
      assert.equal(result.frontmatter.description, "A test skill");
      assert.equal(result.body, "Body content");
    });

    it("parses frontmatter with all optional fields", () => {
      const content = `---
name: full-skill
description: Complete skill
license: MIT
compatibility: node >= 18
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "full-skill");
      assert.equal(result.frontmatter.description, "Complete skill");
      assert.equal(result.frontmatter.license, "MIT");
      assert.equal(result.frontmatter.compatibility, "node >= 18");
    });

    it("parses nested metadata block", () => {
      const content = `---
name: skill-with-metadata
description: Has metadata
metadata:
  version: 1.0
  author: test
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.metadata?.version, "1.0");
      assert.equal(result.frontmatter.metadata?.author, "test");
    });

    it("parses allowed-tools as space-delimited list", () => {
      const content = `---
name: tool-skill
description: Has tools
allowed-tools: shell file-read file-write
---
Body`;

      const result = parseSkillMd(content);

      assert.deepEqual(result.frontmatter.allowedTools, ["shell", "file-read", "file-write"]);
    });

    it("parses allowed-tools with varied whitespace", () => {
      const content = `---
name: tool-skill
description: Has tools
allowed-tools:  shell   file-read    file-write
---
Body`;

      const result = parseSkillMd(content);

      assert.deepEqual(result.frontmatter.allowedTools, ["shell", "file-read", "file-write"]);
    });

    it("parses double-quoted values", () => {
      const content = `---
name: "skill with spaces"
description: "A description with special: characters"
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "skill with spaces");
      assert.equal(result.frontmatter.description, "A description with special: characters");
    });

    it("parses single-quoted values", () => {
      const content = `---
name: 'single-quoted'
description: 'Single quoted description'
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "single-quoted");
      assert.equal(result.frontmatter.description, "Single quoted description");
    });

    it("handles complex markdown body with headers and code blocks", () => {
      const content = `---
name: skill
description: Test
---
# Header

Some text

\`\`\`typescript
const x = 1;
\`\`\`

- List item 1
- List item 2`;

      const result = parseSkillMd(content);

      assert.match(result.body, /# Header/);
      assert.match(result.body, /const x = 1/);
      assert.match(result.body, /- List item 1/);
    });

    it("handles empty body (frontmatter only)", () => {
      const content = `---
name: minimal-skill
description: Minimal
---`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "minimal-skill");
      assert.equal(result.body, "");
    });

    it("ignores leading whitespace before opening delimiter", () => {
      const content = `
---
name: skill
description: Test
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "skill");
      assert.equal(result.body, "Body");
    });

    it("skips comment lines in frontmatter", () => {
      const content = `---
# This is a comment
name: skill
# Another comment
description: Test
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "skill");
      assert.equal(result.frontmatter.description, "Test");
    });

    it("handles colons in quoted values", () => {
      const content = `---
name: "skill:name"
description: "Description: with colons"
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "skill:name");
      assert.equal(result.frontmatter.description, "Description: with colons");
    });

    it("handles body containing --- (not at start of line)", () => {
      const content = `---
name: skill
description: Test
---
Some text with --- in the middle
More text --- here`;

      const result = parseSkillMd(content);

      assert.match(result.body, /Some text with --- in the middle/);
      assert.match(result.body, /More text --- here/);
    });

    it("trims trailing whitespace from body", () => {
      const content = `---
name: skill
description: Test
---
Body content
   `;

      const result = parseSkillMd(content);

      assert.equal(result.body, "Body content");
    });

    it("handles metadata with multiple nested fields", () => {
      const content = `---
name: skill
description: Test
metadata:
  key1: value1
  key2: value2
  key3: value3
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.metadata?.key1, "value1");
      assert.equal(result.frontmatter.metadata?.key2, "value2");
      assert.equal(result.frontmatter.metadata?.key3, "value3");
    });

    it("handles empty lines in frontmatter", () => {
      const content = `---
name: skill

description: Test

license: MIT
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "skill");
      assert.equal(result.frontmatter.description, "Test");
      assert.equal(result.frontmatter.license, "MIT");
    });

    it("preserves newlines in body", () => {
      const content = `---
name: skill
description: Test
---
Line 1
Line 2
Line 3`;

      const result = parseSkillMd(content);

      assert.match(result.body, /Line 1\nLine 2\nLine 3/);
    });

    it("handles single tool in allowed-tools", () => {
      const content = `---
name: skill
description: Test
allowed-tools: shell
---
Body`;

      const result = parseSkillMd(content);

      assert.deepEqual(result.frontmatter.allowedTools, ["shell"]);
    });

    it("handles metadata with quoted values", () => {
      const content = `---
name: skill
description: Test
metadata:
  author: "John Doe"
  version: "1.0.0"
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.metadata?.author, "John Doe");
      assert.equal(result.frontmatter.metadata?.version, "1.0.0");
    });
  });

  describe("error cases", () => {
    it("throws when missing opening --- delimiter", () => {
      const content = `name: skill
description: Test
---
Body`;

      assert.throws(
        () => parseSkillMd(content),
        (err: Error) => {
          assert.ok(err instanceof FrontmatterParseError);
          assert.match(err.message, /must begin with ---/);
          return true;
        },
      );
    });

    it("throws when missing closing --- delimiter", () => {
      const content = `---
name: skill
description: Test
Body`;

      assert.throws(
        () => parseSkillMd(content),
        (err: Error) => {
          assert.ok(err instanceof FrontmatterParseError);
          assert.match(err.message, /missing closing/);
          return true;
        },
      );
    });

    it("throws when required name field is missing", () => {
      const content = `---
description: Test
---
Body`;

      assert.throws(
        () => parseSkillMd(content),
        (err: Error) => {
          assert.ok(err instanceof FrontmatterParseError);
          assert.match(err.message, /name/);
          return true;
        },
      );
    });

    it("throws when required description field is missing", () => {
      const content = `---
name: skill
---
Body`;

      assert.throws(
        () => parseSkillMd(content),
        (err: Error) => {
          assert.ok(err instanceof FrontmatterParseError);
          assert.match(err.message, /description/);
          return true;
        },
      );
    });

    it("throws when name is empty string", () => {
      const content = `---
name: ""
description: Test
---
Body`;

      assert.throws(
        () => parseSkillMd(content),
        (err: Error) => {
          assert.ok(err instanceof FrontmatterParseError);
          assert.match(err.message, /name/);
          return true;
        },
      );
    });

    it("throws when description is empty string", () => {
      const content = `---
name: skill
description: ""
---
Body`;

      assert.throws(
        () => parseSkillMd(content),
        (err: Error) => {
          assert.ok(err instanceof FrontmatterParseError);
          assert.match(err.message, /description/);
          return true;
        },
      );
    });

    it("throws when name is undefined (missing key)", () => {
      const content = `---
description: Test
---
Body`;

      assert.throws(
        () => parseSkillMd(content),
        (err: Error) => {
          assert.ok(err instanceof FrontmatterParseError);
          return true;
        },
      );
    });

    it("throws when description is undefined (missing key)", () => {
      const content = `---
name: skill
---
Body`;

      assert.throws(
        () => parseSkillMd(content),
        (err: Error) => {
          assert.ok(err instanceof FrontmatterParseError);
          return true;
        },
      );
    });
  });

  describe("edge cases", () => {
    it("ignores whitespace around field values", () => {
      const content = `---
name:    skill-name
description:    Test description
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "skill-name");
      assert.equal(result.frontmatter.description, "Test description");
    });

    it("handles lines without colons in frontmatter (skips them)", () => {
      const content = `---
name: skill
description: Test
this line has no colon
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "skill");
      assert.equal(result.frontmatter.description, "Test");
    });

    it("handles tabs in nested metadata", () => {
      const content = `---
name: skill
description: Test
metadata:
	key: value
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.metadata?.key, "value");
    });

    it("handles closing delimiter with trailing content on same line", () => {
      const content = `---
name: skill
description: Test
---Body`;

      const result = parseSkillMd(content);

      assert.equal(result.body, "Body");
    });

    it("handles multiple consecutive blank lines in body", () => {
      const content = `---
name: skill
description: Test
---
Line 1


Line 4`;

      const result = parseSkillMd(content);

      assert.match(result.body, /Line 1\n\n\nLine 4/);
    });

    it("handles very long description", () => {
      const longDesc = "x".repeat(1000);
      const content = `---
name: skill
description: ${longDesc}
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.description.length, 1000);
    });

    it("handles skill names with special characters", () => {
      const content = `---
name: "skill-with_special.chars"
description: Test
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "skill-with_special.chars");
    });

    it("handles allowed-tools with extra whitespace between tools", () => {
      const content = `---
name: skill
description: Test
allowed-tools: tool1    tool2     tool3
---
Body`;

      const result = parseSkillMd(content);

      assert.deepEqual(result.frontmatter.allowedTools, ["tool1", "tool2", "tool3"]);
    });

    it("does not require metadata to have any fields", () => {
      const content = `---
name: skill
description: Test
metadata:
---
Body`;

      const result = parseSkillMd(content);

      // Should have empty metadata object
      assert.ok(result.frontmatter.metadata);
      assert.equal(Object.keys(result.frontmatter.metadata).length, 0);
    });

    it("ignores unknown fields in frontmatter", () => {
      const content = `---
name: skill
description: Test
unknown-field: value
another-unknown: test
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "skill");
      assert.equal(result.frontmatter.description, "Test");
    });

    it("handles mixed quotes and unquoted values", () => {
      const content = `---
name: 'quoted'
description: unquoted
license: "MIT"
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "quoted");
      assert.equal(result.frontmatter.description, "unquoted");
      assert.equal(result.frontmatter.license, "MIT");
    });

    it("handles closing --- with preceding empty lines in frontmatter", () => {
      const content = `---
name: skill
description: Test

---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.name, "skill");
      assert.equal(result.body, "Body");
    });

    it("uses final unquote result for metadata values", () => {
      const content = `---
name: skill
description: Test
metadata:
  key: "quoted_value"
---
Body`;

      const result = parseSkillMd(content);

      assert.equal(result.frontmatter.metadata?.key, "quoted_value");
    });
  });
});
