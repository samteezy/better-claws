import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toErrorMessage, isEnoent } from "../../../src/utils/errors.js";

describe("errors", () => {
  describe("toErrorMessage()", () => {
    it("extracts message from Error instance", () => {
      const err = new Error("Something went wrong");
      const result = toErrorMessage(err);
      assert.equal(result, "Something went wrong");
    });

    it("extracts message from TypeError instance", () => {
      const err = new TypeError("Type error message");
      const result = toErrorMessage(err);
      assert.equal(result, "Type error message");
    });

    it("extracts message from RangeError instance", () => {
      const err = new RangeError("Range error message");
      const result = toErrorMessage(err);
      assert.equal(result, "Range error message");
    });

    it("converts plain string to string", () => {
      const err = "just a string";
      const result = toErrorMessage(err);
      assert.equal(result, "just a string");
    });

    it("converts number to string", () => {
      const err = 42;
      const result = toErrorMessage(err);
      assert.equal(result, "42");
    });

    it("converts null to string 'null'", () => {
      const err = null;
      const result = toErrorMessage(err);
      assert.equal(result, "null");
    });

    it("converts undefined to string 'undefined'", () => {
      const err = undefined;
      const result = toErrorMessage(err);
      assert.equal(result, "undefined");
    });

    it("converts object to string representation", () => {
      const err = { message: "obj prop", foo: "bar" };
      const result = toErrorMessage(err);
      assert.equal(result, "[object Object]");
    });

    it("converts boolean true to string", () => {
      const err = true;
      const result = toErrorMessage(err);
      assert.equal(result, "true");
    });

    it("converts boolean false to string", () => {
      const err = false;
      const result = toErrorMessage(err);
      assert.equal(result, "false");
    });

    it("converts array to string representation", () => {
      const err = ["a", "b", "c"];
      const result = toErrorMessage(err);
      assert.equal(result, "a,b,c");
    });

    it("handles Error with empty message", () => {
      const err = new Error("");
      const result = toErrorMessage(err);
      assert.equal(result, "");
    });
  });

  describe("isEnoent()", () => {
    it("returns true for ENOENT error", () => {
      const err = new Error("File not found");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      const result = isEnoent(err);
      assert.equal(result, true);
    });

    it("returns false for EACCES error", () => {
      const err = new Error("Permission denied");
      (err as NodeJS.ErrnoException).code = "EACCES";
      const result = isEnoent(err);
      assert.equal(result, false);
    });

    it("returns false for EISDIR error", () => {
      const err = new Error("Is a directory");
      (err as NodeJS.ErrnoException).code = "EISDIR";
      const result = isEnoent(err);
      assert.equal(result, false);
    });

    it("returns false for Error with no code property", () => {
      const err = new Error("Some error");
      const result = isEnoent(err);
      assert.equal(result, false);
    });

    it("returns false for Error with code property set to undefined", () => {
      const err = new Error("Some error");
      (err as NodeJS.ErrnoException).code = undefined;
      const result = isEnoent(err);
      assert.equal(result, false);
    });

    it("returns false for plain string", () => {
      const err = "ENOENT";
      const result = isEnoent(err);
      assert.equal(result, false);
    });

    it("returns false for null", () => {
      const err = null;
      const result = isEnoent(err);
      assert.equal(result, false);
    });

    it("returns false for undefined", () => {
      const err = undefined;
      const result = isEnoent(err);
      assert.equal(result, false);
    });

    it("returns false for object with code property but not an Error", () => {
      const err = { code: "ENOENT" };
      const result = isEnoent(err);
      assert.equal(result, false);
    });

    it("returns false for number", () => {
      const err = 123;
      const result = isEnoent(err);
      assert.equal(result, false);
    });

    it("distinguishes between ENOENT and similar codes", () => {
      const enoent = new Error("File not found");
      (enoent as NodeJS.ErrnoException).code = "ENOENT";

      const enotdir = new Error("Not a directory");
      (enotdir as NodeJS.ErrnoException).code = "ENOTDIR";

      assert.equal(isEnoent(enoent), true);
      assert.equal(isEnoent(enotdir), false);
    });
  });
});
