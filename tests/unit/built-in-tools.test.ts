import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecutionContext } from "../../src/types.js";
import { handler as shellHandler } from "../../src/tools/built-in/shell.js";
import { handler as fileReadHandler } from "../../src/tools/built-in/file-read.js";
import { handler as fileWriteHandler } from "../../src/tools/built-in/file-write.js";
import { handler as webFetchHandler } from "../../src/tools/built-in/web-fetch.js";

// Test helpers
async function withTempDir(
  fn: (tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "bc-tools-"));
  try {
    await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function makeContext(tempDir: string): ExecutionContext {
  return {
    sessionId: "test-session",
    capabilities: [],
    scratchDir: tempDir,
    timeout: 5000,
    secrets: new Map<string, string>(),
  };
}

describe("Built-in tools", () => {
  describe("shell tool", () => {
    it("executes a simple command and returns stdout", async () => {
      await withTempDir(async (tempDir) => {
        const result = await shellHandler.execute(
          { command: "echo", args: ["hello"] },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);
        const output = result.output as Record<string, unknown>;
        assert.strictEqual((output["stdout"] as string).trim(), "hello");
        assert.strictEqual(output["exitCode"], 0);
        assert.ok(result.durationMs >= 0);
      });
    });

    it("returns error for missing command parameter", async () => {
      await withTempDir(async (tempDir) => {
        const result = await shellHandler.execute({}, makeContext(tempDir));

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, "Missing required parameter: command");
        assert.strictEqual(result.output, null);
      });
    });

    it("returns error when command is empty string", async () => {
      await withTempDir(async (tempDir) => {
        const result = await shellHandler.execute(
          { command: "" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, "Missing required parameter: command");
      });
    });

    it("returns error output when command fails", async () => {
      await withTempDir(async (tempDir) => {
        const result = await shellHandler.execute(
          { command: "nonexistent-command-xyz" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, false);
        assert.ok(result.error);
        assert.ok(result.output);
        const output = result.output as Record<string, unknown>;
        assert.ok(output["exitCode"] !== 0 || output["stderr"]);
      });
    });

    it("passes args correctly to command", async () => {
      await withTempDir(async (tempDir) => {
        const result = await shellHandler.execute(
          { command: "echo", args: ["foo", "bar", "baz"] },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);
        const output = result.output as Record<string, unknown>;
        const stdout = (output["stdout"] as string).trim();
        assert.ok(stdout.includes("foo"));
        assert.ok(stdout.includes("bar"));
        assert.ok(stdout.includes("baz"));
      });
    });

    it("respects custom cwd parameter", async () => {
      await withTempDir(async (tempDir) => {
        const result = await shellHandler.execute(
          { command: "pwd" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);
      });
    });

    it("converts args to strings", async () => {
      await withTempDir(async (tempDir) => {
        const result = await shellHandler.execute(
          { command: "echo", args: [123, 456] },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);
        const output = result.output as Record<string, unknown>;
        const stdout = (output["stdout"] as string).trim();
        assert.ok(stdout.includes("123"));
        assert.ok(stdout.includes("456"));
      });
    });
  });

  describe("file-read tool", () => {
    it("reads an existing file and returns content", async () => {
      await withTempDir(async (tempDir) => {
        const filePath = join(tempDir, "test.txt");
        await writeFile(filePath, "line1\nline2\nline3\n");

        const result = await fileReadHandler.execute(
          { path: filePath },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);
        const output = result.output as Record<string, unknown>;
        assert.ok((output["content"] as string).includes("line1"));
        assert.ok((output["content"] as string).includes("line2"));
      });
    });

    it("returns error for missing path parameter", async () => {
      await withTempDir(async (tempDir) => {
        const result = await fileReadHandler.execute({}, makeContext(tempDir));

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, "Missing required parameter: path");
        assert.strictEqual(result.output, null);
      });
    });

    it("returns error when path is empty string", async () => {
      await withTempDir(async (tempDir) => {
        const result = await fileReadHandler.execute(
          { path: "" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, "Missing required parameter: path");
      });
    });

    it("returns error for nonexistent file", async () => {
      await withTempDir(async (tempDir) => {
        const result = await fileReadHandler.execute(
          { path: join(tempDir, "nonexistent.txt") },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, false);
        assert.ok(result.error);
      });
    });

    it("supports startLine and endLine range", async () => {
      await withTempDir(async (tempDir) => {
        const filePath = join(tempDir, "test.txt");
        await writeFile(filePath, "line1\nline2\nline3\nline4\nline5\n");

        const result = await fileReadHandler.execute(
          { path: filePath, startLine: 2, endLine: 4 },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);
        const output = result.output as Record<string, unknown>;
        const content = output["content"] as string;
        assert.ok(content.includes("line2"));
        assert.ok(content.includes("line3"));
        assert.ok(content.includes("line4"));
        assert.ok(!content.includes("line1"));
        assert.ok(!content.includes("line5"));
      });
    });

    it("reports totalLines correctly", async () => {
      await withTempDir(async (tempDir) => {
        const filePath = join(tempDir, "test.txt");
        await writeFile(filePath, "a\nb\nc\nd\ne\n");

        const result = await fileReadHandler.execute(
          { path: filePath },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);
        const output = result.output as Record<string, unknown>;
        assert.ok(output["totalLines"]);
      });
    });

    it("handles startLine of 1 (beginning of file)", async () => {
      await withTempDir(async (tempDir) => {
        const filePath = join(tempDir, "test.txt");
        await writeFile(filePath, "first\nsecond\n");

        const result = await fileReadHandler.execute(
          { path: filePath, startLine: 1, endLine: 1 },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);
        const output = result.output as Record<string, unknown>;
        assert.strictEqual((output["content"] as string).trim(), "first");
      });
    });

    it("clamps endLine to file length", async () => {
      await withTempDir(async (tempDir) => {
        const filePath = join(tempDir, "test.txt");
        await writeFile(filePath, "line1\nline2\n");

        const result = await fileReadHandler.execute(
          { path: filePath, startLine: 1, endLine: 999 },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);
        const output = result.output as Record<string, unknown>;
        assert.ok(output["content"]);
      });
    });

    it("accepts relative paths and resolves against scratchDir", async () => {
      await withTempDir(async (tempDir) => {
        const filePath = join(tempDir, "relative-test.txt");
        await writeFile(filePath, "test content\n");

        const result = await fileReadHandler.execute(
          { path: "relative-test.txt" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);
        const output = result.output as Record<string, unknown>;
        assert.ok((output["content"] as string).includes("test content"));
      });
    });
  });

  describe("file-write tool", () => {
    it("writes content to a file and verifies it was written", async () => {
      await withTempDir(async (tempDir) => {
        const filePath = join(tempDir, "written.txt");
        const result = await fileWriteHandler.execute(
          { path: filePath, content: "test content" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);

        const readResult = await fileReadHandler.execute(
          { path: filePath },
          makeContext(tempDir),
        );
        assert.strictEqual(readResult.success, true);
        const readOutput = readResult.output as Record<string, unknown>;
        assert.strictEqual((readOutput["content"] as string).trim(), "test content");
      });
    });

    it("creates parent directories if needed", async () => {
      await withTempDir(async (tempDir) => {
        const filePath = join(tempDir, "nested", "deep", "file.txt");
        const result = await fileWriteHandler.execute(
          { path: filePath, content: "nested content" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);

        const readResult = await fileReadHandler.execute(
          { path: filePath },
          makeContext(tempDir),
        );
        assert.strictEqual(readResult.success, true);
      });
    });

    it("returns error for missing path parameter", async () => {
      await withTempDir(async (tempDir) => {
        const result = await fileWriteHandler.execute(
          { content: "test" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, "Missing required parameter: path");
        assert.strictEqual(result.output, null);
      });
    });

    it("returns error when path is empty string", async () => {
      await withTempDir(async (tempDir) => {
        const result = await fileWriteHandler.execute(
          { path: "", content: "test" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, "Missing required parameter: path");
      });
    });

    it("returns error for missing content parameter", async () => {
      await withTempDir(async (tempDir) => {
        const result = await fileWriteHandler.execute(
          { path: join(tempDir, "test.txt") },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, "Missing required parameter: content");
        assert.strictEqual(result.output, null);
      });
    });

    it("reports bytesWritten correctly", async () => {
      await withTempDir(async (tempDir) => {
        const filePath = join(tempDir, "bytes-test.txt");
        const content = "hello world";
        const result = await fileWriteHandler.execute(
          { path: filePath, content },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        assert.ok(result.output);
        const output = result.output as Record<string, unknown>;
        assert.strictEqual(output["bytesWritten"], Buffer.byteLength(content, "utf-8"));
      });
    });

    it("handles UTF-8 content correctly", async () => {
      await withTempDir(async (tempDir) => {
        const filePath = join(tempDir, "utf8.txt");
        const content = "Hello 世界 🌍";
        const result = await fileWriteHandler.execute(
          { path: filePath, content },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);
        const output = result.output as Record<string, unknown>;
        assert.strictEqual(
          output["bytesWritten"],
          Buffer.byteLength(content, "utf-8"),
        );

        const readResult = await fileReadHandler.execute(
          { path: filePath },
          makeContext(tempDir),
        );
        assert.strictEqual(readResult.success, true);
        const readOutput = readResult.output as Record<string, unknown>;
        assert.strictEqual((readOutput["content"] as string).trim(), content);
      });
    });

    it("overwrites existing files", async () => {
      await withTempDir(async (tempDir) => {
        const filePath = join(tempDir, "overwrite.txt");

        await fileWriteHandler.execute(
          { path: filePath, content: "original" },
          makeContext(tempDir),
        );

        const result = await fileWriteHandler.execute(
          { path: filePath, content: "overwritten" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);

        const readResult = await fileReadHandler.execute(
          { path: filePath },
          makeContext(tempDir),
        );
        const readOutput = readResult.output as Record<string, unknown>;
        assert.strictEqual((readOutput["content"] as string).trim(), "overwritten");
      });
    });

    it("accepts relative paths and resolves against scratchDir", async () => {
      await withTempDir(async (tempDir) => {
        const result = await fileWriteHandler.execute(
          { path: "relative.txt", content: "relative content" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, true);

        const readResult = await fileReadHandler.execute(
          { path: join(tempDir, "relative.txt") },
          makeContext(tempDir),
        );
        assert.strictEqual(readResult.success, true);
      });
    });
  });

  describe("web-fetch tool", () => {
    it("returns error for missing url parameter", async () => {
      await withTempDir(async (tempDir) => {
        const result = await webFetchHandler.execute({}, makeContext(tempDir));

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, "Missing required parameter: url");
        assert.strictEqual(result.output, null);
      });
    });

    it("returns error when url is empty string", async () => {
      await withTempDir(async (tempDir) => {
        const result = await webFetchHandler.execute({ url: "" }, makeContext(tempDir));

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, "Missing required parameter: url");
      });
    });

    it("returns error for invalid URL", async () => {
      await withTempDir(async (tempDir) => {
        const result = await webFetchHandler.execute(
          { url: "not a valid url" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, false);
        assert.ok(result.error);
        assert.ok(result.error?.includes("Invalid URL"));
      });
    });

    it("returns error for unsupported protocol (ftp)", async () => {
      await withTempDir(async (tempDir) => {
        const result = await webFetchHandler.execute(
          { url: "ftp://example.com/file.txt" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, false);
        assert.ok(result.error);
        assert.ok(result.error?.includes("Unsupported protocol"));
      });
    });

    it("returns error for unsupported protocol (file)", async () => {
      await withTempDir(async (tempDir) => {
        const result = await webFetchHandler.execute(
          { url: "file:///etc/passwd" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, false);
        assert.ok(result.error);
        assert.ok(result.error?.includes("Unsupported protocol"));
      });
    });

    it("returns error for unsupported protocol (gopher)", async () => {
      await withTempDir(async (tempDir) => {
        const result = await webFetchHandler.execute(
          { url: "gopher://example.com" },
          makeContext(tempDir),
        );

        assert.strictEqual(result.success, false);
        assert.ok(result.error);
        assert.ok(result.error?.includes("Unsupported protocol"));
      });
    });

    it("validates URL structure before network call", async () => {
      await withTempDir(async (tempDir) => {
        const invalidUrls = [
          "://missing.scheme",
          "http//missing.slash",
          "ht!tp://invalid",
        ];

        for (const url of invalidUrls) {
          const result = await webFetchHandler.execute({ url }, makeContext(tempDir));
          assert.strictEqual(result.success, false);
          assert.ok(result.error);
        }
      });
    });
  });
});
