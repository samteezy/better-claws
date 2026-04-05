import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isCapability,
  BetterClawsError,
  CAPABILITIES,
  type Capability,
} from "../../src/types.js";

describe("types", () => {
  describe("isCapability()", () => {
    it("returns true for valid capabilities", () => {
      for (const cap of CAPABILITIES) {
        assert.equal(isCapability(cap), true, `${cap} should be a valid capability`);
      }
    });

    it("returns true for all capability strings", () => {
      const validCapabilities: Capability[] = [
        "fs:read",
        "fs:write",
        "fs:delete",
        "net:outbound",
        "net:listen",
        "exec:shell",
        "exec:subprocess",
        "browser:navigate",
        "browser:input",
        "memory:read",
        "memory:write",
      ];

      for (const cap of validCapabilities) {
        assert.equal(
          isCapability(cap),
          true,
          `${cap} should be recognized as a capability`,
        );
      }
    });

    it("returns false for invalid strings", () => {
      assert.equal(isCapability("invalid:capability"), false);
      assert.equal(isCapability("fs:execute"), false);
      assert.equal(isCapability("net:read"), false);
      assert.equal(isCapability(""), false);
      assert.equal(isCapability("exec"), false);
    });

    it("returns false for empty string", () => {
      assert.equal(isCapability(""), false);
    });

    it("returns false for case-sensitive mismatch", () => {
      assert.equal(isCapability("FS:READ"), false);
      assert.equal(isCapability("Fs:Read"), false);
    });

    it("returns false for strings with extra whitespace", () => {
      assert.equal(isCapability(" fs:read"), false);
      assert.equal(isCapability("fs:read "), false);
      assert.equal(isCapability(" fs:read "), false);
    });
  });

  describe("BetterClawsError", () => {
    it("constructs with message, component, and code", () => {
      const error = new BetterClawsError("Test message", "test-component", "TEST_CODE");

      assert.equal(error.message, "Test message");
      assert.equal(error.component, "test-component");
      assert.equal(error.code, "TEST_CODE");
    });

    it("has correct name property", () => {
      const error = new BetterClawsError("Test", "component", "code");
      assert.equal(error.name, "BetterClawsError");
    });

    it("extends Error and is instanceof Error", () => {
      const error = new BetterClawsError("Test", "component", "code");
      assert.ok(error instanceof Error);
    });

    it("preserves all properties", () => {
      const error = new BetterClawsError("Auth failed", "llm-client", "AUTH_INVALID");

      assert.equal(error.message, "Auth failed");
      assert.equal(error.component, "llm-client");
      assert.equal(error.code, "AUTH_INVALID");
      assert.equal(error.name, "BetterClawsError");
    });

    it("can be thrown and caught", () => {
      const error = new BetterClawsError("Network error", "executor", "TIMEOUT");

      try {
        throw error;
      } catch (err) {
        assert.ok(err instanceof BetterClawsError);
        assert.equal((err as BetterClawsError).component, "executor");
        assert.equal((err as BetterClawsError).code, "TIMEOUT");
      }
    });

    it("supports different component names", () => {
      const components = [
        "router",
        "session-manager",
        "llm-client",
        "capability-gate",
        "executor",
        "logger",
      ];

      for (const component of components) {
        const error = new BetterClawsError("Error", component, "CODE");
        assert.equal(error.component, component);
      }
    });

    it("supports different error codes", () => {
      const codes = ["MISSING_ENV_VAR", "CONFIG_ERROR", "TIMEOUT", "INVALID_FORMAT"];

      for (const code of codes) {
        const error = new BetterClawsError("Error", "component", code);
        assert.equal(error.code, code);
      }
    });
  });
});
