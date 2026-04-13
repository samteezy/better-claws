import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MESSAGE_LENGTH,
  truncateMessage,
} from "../../../src/utils/text.js";

describe("text", () => {
  describe("MAX_MESSAGE_LENGTH", () => {
    it("is defined as a constant", () => {
      assert.strictEqual(typeof MAX_MESSAGE_LENGTH, "number");
    });

    it("equals 32768", () => {
      assert.equal(MAX_MESSAGE_LENGTH, 32_768);
    });

    it("is a positive integer", () => {
      assert(MAX_MESSAGE_LENGTH > 0);
      assert.equal(MAX_MESSAGE_LENGTH, Math.floor(MAX_MESSAGE_LENGTH));
    });
  });

  describe("truncateMessage()", () => {
    it("returns string unchanged when shorter than default limit", () => {
      const text = "short message";
      const result = truncateMessage(text);
      assert.equal(result, text);
    });

    it("returns string unchanged when exactly at default limit", () => {
      const text = "x".repeat(MAX_MESSAGE_LENGTH);
      const result = truncateMessage(text);
      assert.equal(result, text);
      assert.equal(result.length, MAX_MESSAGE_LENGTH);
    });

    it("truncates string exceeding default limit", () => {
      const text = "x".repeat(MAX_MESSAGE_LENGTH + 100);
      const result = truncateMessage(text);
      assert.equal(result.length, MAX_MESSAGE_LENGTH);
      assert.equal(result, "x".repeat(MAX_MESSAGE_LENGTH));
    });

    it("respects custom max parameter", () => {
      const text = "1234567890";
      const result = truncateMessage(text, 5);
      assert.equal(result, "12345");
      assert.equal(result.length, 5);
    });

    it("returns unchanged when custom max exceeds text length", () => {
      const text = "short";
      const result = truncateMessage(text, 100);
      assert.equal(result, text);
    });

    it("returns unchanged when custom max equals text length", () => {
      const text = "exactly";
      const result = truncateMessage(text, 7);
      assert.equal(result, text);
    });

    it("returns empty string for empty input", () => {
      const result = truncateMessage("");
      assert.equal(result, "");
    });

    it("returns single character unchanged when max is 1", () => {
      const result = truncateMessage("a", 1);
      assert.equal(result, "a");
    });

    it("truncates single character to empty when max is 0", () => {
      const result = truncateMessage("a", 0);
      assert.equal(result, "");
    });

    it("preserves newlines and whitespace when truncating", () => {
      const text = "line1\nline2\nline3";
      const result = truncateMessage(text, 10);
      assert.equal(result, "line1\nline");
      assert.equal(result.length, 10);
    });

    it("truncates multi-byte UTF-8 characters correctly", () => {
      const text = "Hello 👋 World";
      const result = truncateMessage(text, 7);
      // "Hello 👋" is 7 characters (emoji counts as 1 character)
      assert.equal(result.length, 7);
    });

    it("handles very large custom max parameter", () => {
      const text = "small";
      const result = truncateMessage(text, 1_000_000);
      assert.equal(result, text);
    });

    it("handles zero as custom max parameter", () => {
      const text = "anything";
      const result = truncateMessage(text, 0);
      assert.equal(result, "");
    });

    it("default max parameter can be overridden with smaller value", () => {
      const text = "x".repeat(1000);
      const result = truncateMessage(text, 100);
      assert.equal(result.length, 100);
      assert(result.length < MAX_MESSAGE_LENGTH);
    });

    it("truncates text with special characters", () => {
      const text = "!@#$%^&*()_+-=[]{}|;:',.<>?";
      const result = truncateMessage(text, 10);
      assert.equal(result, "!@#$%^&*()");
      assert.equal(result.length, 10);
    });

    it("returns correct type (string)", () => {
      const result = truncateMessage("test");
      assert.strictEqual(typeof result, "string");
    });
  });
});
