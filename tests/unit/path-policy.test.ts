import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPath } from "../../src/utils/path-policy.js";

// Test helpers
async function withTempDir(
  fn: (tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "path-policy-test-"));
  try {
    await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("Path Policy (checkPath)", () => {
  describe("happy path: allowed paths", () => {
    it("allows relative path within allowed root", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          "file.txt",
          allowedRoot,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
        if (result.allowed) {
          assert.ok(result.resolvedPath.includes("file.txt"));
        }
      });
    });

    it("allows absolute path within allowed root", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);
        const filePath = join(allowedRoot, "file.txt");

        const result = await checkPath(
          filePath,
          tempDir,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
        if (result.allowed) {
          // On macOS, /var may canonicalize to /private/var, so check it contains the expected parts
          assert.ok(result.resolvedPath.includes("allowed"));
          assert.ok(result.resolvedPath.includes("file.txt"));
        }
      });
    });

    it("allows nested paths within allowed root", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          "deep/nested/file.txt",
          allowedRoot,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
        if (result.allowed) {
          assert.ok(result.resolvedPath.includes("deep"));
          assert.ok(result.resolvedPath.includes("nested"));
        }
      });
    });

    it("allows nonexistent file in existing allowed directory (for write scenarios)", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          join(allowedRoot, "does-not-exist.txt"),
          tempDir,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
      });
    });

    it("allows nonexistent nested directories in allowed root (for mkdir + write)", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          "deep/nested/dir/file.txt",
          allowedRoot,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
        if (result.allowed) {
          assert.ok(result.resolvedPath.includes("deep/nested/dir/file.txt"));
        }
      });
    });

    it("allows path in any of multiple allowed roots", async () => {
      await withTempDir(async (tempDir) => {
        const root1 = join(tempDir, "root1");
        const root2 = join(tempDir, "root2");
        await mkdir(root1);
        await mkdir(root2);

        const result1 = await checkPath(
          "file.txt",
          root1,
          [root1, root2],
        );
        assert.strictEqual(result1.allowed, true);

        const result2 = await checkPath(
          "file.txt",
          root2,
          [root1, root2],
        );
        assert.strictEqual(result2.allowed, true);
      });
    });
  });

  describe("deny: paths outside allowed roots", () => {
    it("denies absolute path outside all roots", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          "/etc/passwd",
          tempDir,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, false);
        if (!result.allowed) {
          assert.ok(result.reason.includes("outside"));
        }
      });
    });

    it("denies path with .. that escapes root", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        const allowedSub = join(allowedRoot, "subdir");
        await mkdir(allowedRoot);
        await mkdir(allowedSub);

        const result = await checkPath(
          "../../secret.txt",
          allowedSub,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, false);
        if (!result.allowed) {
          assert.ok(result.reason.includes("outside"));
        }
      });
    });

    it("denies path that walks up then down to external location", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        const externalRoot = join(tempDir, "external");
        await mkdir(allowedRoot);
        await mkdir(externalRoot);

        const result = await checkPath(
          join(allowedRoot, "..", "..", "external", "file.txt"),
          tempDir,
          [allowedRoot],
        );

        // Should be denied because final path is outside allowedRoot
        assert.strictEqual(result.allowed, false);
      });
    });

    it("denies when path is exactly one level above allowed root", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);
        const parentPath = join(allowedRoot, "..", "sibling.txt");

        const result = await checkPath(
          parentPath,
          allowedRoot,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, false);
      });
    });
  });

  describe("symlink escapes: must be denied", () => {
    it("denies symlink inside allowed root that points outside", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        const externalFile = join(tempDir, "external.txt");
        await mkdir(allowedRoot);
        await writeFile(externalFile, "external");

        // Create symlink inside allowed root pointing outside
        const symlinkPath = join(allowedRoot, "link-to-external");
        await symlink(externalFile, symlinkPath);

        // When we checkPath the symlink, realpath should resolve it to external file
        const result = await checkPath(
          symlinkPath,
          tempDir,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, false);
        if (!result.allowed) {
          assert.ok(result.reason.includes("outside"));
        }
      });
    });

    it("denies symlink chain that escapes", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        const externalDir = join(tempDir, "external");
        const externalFile = join(externalDir, "secret.txt");
        await mkdir(allowedRoot);
        await mkdir(externalDir);
        await writeFile(externalFile, "secret");

        // Create symlink in allowed root -> symlink -> external file
        const link1 = join(allowedRoot, "link1");
        const link2 = join(allowedRoot, "link2");
        await symlink(externalFile, link1);
        await symlink(link1, link2);

        const result = await checkPath(
          link2,
          tempDir,
          [allowedRoot],
        );

        // realpath should resolve through the chain to the external file
        assert.strictEqual(result.allowed, false);
      });
    });

    it("allows symlink inside allowed root pointing to file inside allowed root", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const realFile = join(allowedRoot, "real-file.txt");
        const symlinkPath = join(allowedRoot, "link-to-real");
        await writeFile(realFile, "content");
        await symlink(realFile, symlinkPath);

        const result = await checkPath(
          symlinkPath,
          tempDir,
          [allowedRoot],
        );

        // Should be allowed because both symlink and target are within root
        assert.strictEqual(result.allowed, true);
      });
    });
  });

  describe("edge cases", () => {
    it("handles paths with . (current directory reference)", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          "./file.txt",
          allowedRoot,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
      });
    });

    it("handles paths with multiple slashes", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          "dir//subdir///file.txt",
          allowedRoot,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
      });
    });

    it("handles trailing slashes", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          "dir/",
          allowedRoot,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
      });
    });

    it("handles empty allowed roots array", async () => {
      await withTempDir(async (tempDir) => {
        const result = await checkPath(
          "file.txt",
          tempDir,
          [],
        );

        assert.strictEqual(result.allowed, false);
      });
    });

    it("handles path that is exactly the allowed root", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          allowedRoot,
          tempDir,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
        if (result.allowed) {
          // On macOS, paths may canonicalize, so check it contains expected parts
          assert.ok(result.resolvedPath.includes("allowed"));
        }
      });
    });

    it("resolves to the real path when walking up for nonexistent ancestors", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        // Request a deeply nested nonexistent path
        const deepPath = join(allowedRoot, "a", "b", "c", "d", "file.txt");
        const result = await checkPath(
          deepPath,
          tempDir,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
        if (result.allowed) {
          // The resolved path should contain the deep path
          assert.ok(result.resolvedPath.includes("a"));
          assert.ok(result.resolvedPath.includes("b"));
          assert.ok(result.resolvedPath.includes("c"));
        }
      });
    });
  });

  describe("multiple allowed roots", () => {
    it("allows any path that falls within one of multiple roots", async () => {
      await withTempDir(async (tempDir) => {
        const root1 = join(tempDir, "root1");
        const root2 = join(tempDir, "root2");
        const root3 = join(tempDir, "root3");
        await mkdir(root1);
        await mkdir(root2);
        await mkdir(root3);

        const result1 = await checkPath("file1.txt", root1, [root1, root2, root3]);
        const result2 = await checkPath("file2.txt", root2, [root1, root2, root3]);
        const result3 = await checkPath("file3.txt", root3, [root1, root2, root3]);

        assert.strictEqual(result1.allowed, true);
        assert.strictEqual(result2.allowed, true);
        assert.strictEqual(result3.allowed, true);
      });
    });

    it("denies path that falls outside all multiple roots", async () => {
      await withTempDir(async (tempDir) => {
        const root1 = join(tempDir, "root1");
        const root2 = join(tempDir, "root2");
        await mkdir(root1);
        await mkdir(root2);

        const result = await checkPath(
          "/etc/passwd",
          tempDir,
          [root1, root2],
        );

        assert.strictEqual(result.allowed, false);
      });
    });
  });

  describe("returned resolvedPath", () => {
    it("includes the filename in resolvedPath", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          "myfile.txt",
          allowedRoot,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
        if (result.allowed) {
          assert.ok(result.resolvedPath.endsWith("myfile.txt"));
        }
      });
    });

    it("returns absolute path in resolvedPath", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          "file.txt",
          allowedRoot,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, true);
        if (result.allowed) {
          assert.ok(result.resolvedPath.startsWith("/"));
        }
      });
    });
  });

  describe("error messages for denied paths", () => {
    it("provides informative reason message for denied paths", async () => {
      await withTempDir(async (tempDir) => {
        const allowedRoot = join(tempDir, "allowed");
        await mkdir(allowedRoot);

        const result = await checkPath(
          "/etc/passwd",
          tempDir,
          [allowedRoot],
        );

        assert.strictEqual(result.allowed, false);
        if (!result.allowed) {
          assert.ok(result.reason);
          assert.ok(result.reason.length > 0);
          assert.ok(result.reason.includes("outside"));
        }
      });
    });
  });
});
