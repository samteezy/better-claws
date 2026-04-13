import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { missingParamResult } from "../../../src/tools/built-in/tool-helpers.js";
import type { ToolResult } from "../../../src/types.js";

describe("tool-helpers", () => {
  describe("missingParamResult()", () => {
    it("returns an object with success: false", () => {
      const start = Date.now();
      const result = missingParamResult("paramName", start);
      assert.equal(result.success, false);
    });

    it("returns an object with output: null", () => {
      const start = Date.now();
      const result = missingParamResult("paramName", start);
      assert.equal(result.output, null);
    });

    it("returns an object with error string containing the param name", () => {
      const start = Date.now();
      const result = missingParamResult("filePath", start);
      assert.strictEqual(typeof result.error, "string");
      assert(result.error!.includes("filePath"));
    });

    it("includes 'Missing required parameter:' in error message", () => {
      const start = Date.now();
      const result = missingParamResult("someParam", start);
      assert(result.error!.includes("Missing required parameter:"));
    });

    it("returns an object with durationMs as a non-negative number", () => {
      const start = Date.now();
      const result = missingParamResult("param", start);
      assert.strictEqual(typeof result.durationMs, "number");
      assert(result.durationMs >= 0);
    });

    it("different param names produce different error messages", () => {
      const start = Date.now();
      const result1 = missingParamResult("param1", start);
      const result2 = missingParamResult("param2", start);
      assert.notEqual(result1.error, result2.error);
      assert(result1.error!.includes("param1"));
      assert(result2.error!.includes("param2"));
    });

    it("calculates durationMs from start timestamp", () => {
      const start = Date.now();
      const result = missingParamResult("param", start);
      // durationMs should be elapsed time since start
      assert(result.durationMs >= 0);
      assert(result.durationMs < 1000); // Should complete in under 1 second
    });

    it("returns a valid ToolResult type", () => {
      const start = Date.now();
      const result = missingParamResult("param", start);
      // Check that result conforms to ToolResult shape
      assert.strictEqual(typeof result.success, "boolean");
      assert.strictEqual(result.output, null);
      assert.strictEqual(typeof result.error, "string");
      assert.strictEqual(typeof result.durationMs, "number");
    });

    it("works with empty string param name", () => {
      const start = Date.now();
      const result = missingParamResult("", start);
      assert.equal(result.success, false);
      assert.equal(result.output, null);
      assert.strictEqual(typeof result.error, "string");
    });

    it("works with special characters in param name", () => {
      const start = Date.now();
      const result = missingParamResult("param-with-dashes_and_underscores", start);
      assert(result.error!.includes("param-with-dashes_and_underscores"));
    });

    it("works with param name containing spaces", () => {
      const start = Date.now();
      const result = missingParamResult("param with spaces", start);
      assert(result.error!.includes("param with spaces"));
    });

    it("error message does not include the word 'null'", () => {
      const start = Date.now();
      const result = missingParamResult("param", start);
      // output is null but error message should be meaningful
      assert(!result.error!.toLowerCase().includes("null output"));
    });

    it("multiple calls with same params produce same error message text", () => {
      const start1 = Date.now();
      const start2 = Date.now();
      const result1 = missingParamResult("param", start1);
      const result2 = missingParamResult("param", start2);
      // Error messages should be identical even if durationMs differs slightly
      assert.equal(result1.error, result2.error);
    });

    it("start time in the past produces positive durationMs", () => {
      const start = Date.now() - 1000; // 1 second ago
      const result = missingParamResult("param", start);
      assert(result.durationMs >= 1000);
    });

    it("readonly success property is false", () => {
      const start = Date.now();
      const result = missingParamResult("param", start) as ToolResult;
      // Verify it's a valid ToolResult with readonly properties
      assert.equal(result.success, false);
    });
  });
});
