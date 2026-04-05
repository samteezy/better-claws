import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CapabilityGate } from "../../src/tools/capability-gate.js";
import type { ToolDescriptor, Capability, GrantScope } from "../../src/types.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

function createMockLogger() {
  const calls: Array<{
    sessionId: string | null;
    eventType: string;
    component: string;
    payload: Record<string, unknown>;
  }> = [];
  const logger = {
    calls,
    log(entry: {
      sessionId: string | null;
      eventType: string;
      component: string;
      payload: Record<string, unknown>;
    }): void {
      calls.push(entry);
    },
    async flush(): Promise<void> {},
    async close(): Promise<void> {},
  } as unknown as StructuredLogger & { calls: typeof calls };
  return logger;
}

function createToolDescriptor(
  name: string,
  capabilities: readonly Capability[] = [],
): ToolDescriptor {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object" },
    capabilities,
  };
}

describe("CapabilityGate", () => {
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  describe("check() with deny policy", () => {
    let gate: CapabilityGate;

    beforeEach(() => {
      gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });
    });

    it("tool with no capabilities always passes", () => {
      const tool = createToolDescriptor("no-cap-tool", []);
      const grants = new Map<string, GrantScope>();

      const decision = gate.check(tool, grants);

      assert.equal(decision.allowed, true);
      assert.equal(decision.reason, "Tool requires no capabilities");
      assert.deepEqual(decision.missingCapabilities, []);
    });

    it("tool requiring fs:read denied when session has no grants", () => {
      const tool = createToolDescriptor("file-reader", ["fs:read"]);
      const grants = new Map<string, GrantScope>();

      const decision = gate.check(tool, grants);

      assert.equal(decision.allowed, false);
      assert.match(decision.reason, /Missing capabilities/);
      assert.deepEqual(decision.missingCapabilities, ["fs:read"]);
    });

    it("tool requiring fs:read allowed when session grants fs:read", () => {
      const tool = createToolDescriptor("file-reader", ["fs:read"]);
      const grants = new Map<string, GrantScope>();
      grants.set("fs:read", "session");

      const decision = gate.check(tool, grants);

      assert.equal(decision.allowed, true);
      assert.equal(decision.reason, "All required capabilities granted");
      assert.deepEqual(decision.missingCapabilities, []);
    });

    it("tool requiring [fs:read, fs:write] denied when session only grants fs:read", () => {
      const tool = createToolDescriptor("file-editor", ["fs:read", "fs:write"]);
      const grants = new Map<string, GrantScope>();
      grants.set("fs:read", "session");

      const decision = gate.check(tool, grants);

      assert.equal(decision.allowed, false);
      assert.deepEqual(decision.missingCapabilities, ["fs:write"]);
    });

    it("missingCapabilities list is correct when some capabilities are granted", () => {
      const tool = createToolDescriptor("complex-tool", [
        "fs:read",
        "fs:write",
        "net:outbound",
      ]);
      const grants = new Map<string, GrantScope>();
      grants.set("fs:read", "session");
      grants.set("net:outbound", "persistent");

      const decision = gate.check(tool, grants);

      assert.deepEqual(decision.missingCapabilities, ["fs:write"]);
    });

    it("default deny policy with empty grants denies everything", () => {
      const tool = createToolDescriptor("any-tool", ["fs:read"]);
      const grants = new Map<string, GrantScope>();

      const decision = gate.check(tool, grants);

      assert.equal(decision.allowed, false);
    });

    it("allows tool when all required capabilities are granted", () => {
      const tool = createToolDescriptor("full-access", [
        "fs:read",
        "fs:write",
        "exec:shell",
      ]);
      const grants = new Map<string, GrantScope>();
      grants.set("fs:read", "session");
      grants.set("fs:write", "session");
      grants.set("exec:shell", "persistent");

      const decision = gate.check(tool, grants);

      assert.equal(decision.allowed, true);
      assert.deepEqual(decision.missingCapabilities, []);
    });

    it("grants with different scopes (session vs persistent) both count", () => {
      const tool = createToolDescriptor("mixed-scope", ["fs:read", "net:outbound"]);
      const grants = new Map<string, GrantScope>();
      grants.set("fs:read", "session");
      grants.set("net:outbound", "persistent");

      const decision = gate.check(tool, grants);

      assert.equal(decision.allowed, true);
    });
  });

  describe("check() with allow policy", () => {
    let gate: CapabilityGate;

    beforeEach(() => {
      gate = new CapabilityGate({
        defaultPolicy: "allow",
        logger: mockLogger,
      });
    });

    it("default allow policy with missing capabilities still reports them but allows", () => {
      const tool = createToolDescriptor("privileged-tool", ["fs:write", "exec:shell"]);
      const grants = new Map<string, GrantScope>();

      const decision = gate.check(tool, grants);

      assert.equal(decision.allowed, true);
      assert.deepEqual(decision.missingCapabilities, ["fs:write", "exec:shell"]);
      assert.match(
        decision.reason,
        /Default allow policy.*missing capabilities noted/,
      );
    });

    it("allows execution but lists missing capabilities", () => {
      const tool = createToolDescriptor("partial-tool", [
        "fs:read",
        "fs:write",
        "net:outbound",
      ]);
      const grants = new Map<string, GrantScope>();
      grants.set("fs:read", "session");

      const decision = gate.check(tool, grants);

      assert.equal(decision.allowed, true);
      assert.deepEqual(decision.missingCapabilities, ["fs:write", "net:outbound"]);
    });

    it("allows tool with no capabilities", () => {
      const tool = createToolDescriptor("safe-tool", []);
      const grants = new Map<string, GrantScope>();

      const decision = gate.check(tool, grants);

      assert.equal(decision.allowed, true);
    });
  });

  describe("logging gate decisions", () => {
    it("logs every decision (allowed case)", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const tool = createToolDescriptor("test-tool", ["fs:read"]);
      const grants = new Map<string, GrantScope>();
      grants.set("fs:read", "session");

      gate.check(tool, grants);

      assert.equal(mockLogger.calls.length, 1);
      const call = mockLogger.calls[0];
      assert.equal(call?.eventType, "gate:decision");
      assert.equal(call?.component, "gate");
      assert.equal(call?.payload.tool, "test-tool");
      assert.equal(call?.payload.allowed, true);
    });

    it("logs every decision (denied case)", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const tool = createToolDescriptor("denied-tool", ["fs:write"]);
      const grants = new Map<string, GrantScope>();

      gate.check(tool, grants);

      assert.equal(mockLogger.calls.length, 1);
      const call = mockLogger.calls[0];
      assert.equal(call?.eventType, "gate:decision");
      assert.equal(call?.component, "gate");
      assert.equal(call?.payload.tool, "denied-tool");
      assert.equal(call?.payload.allowed, false);
      assert.ok(Array.isArray(call?.payload.missingCapabilities));
      assert.equal(
        (call?.payload.missingCapabilities as unknown[]).length,
        1,
      );
    });

    it("logs decision with missing capabilities list", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const tool = createToolDescriptor("partial-tool", [
        "fs:read",
        "fs:write",
        "exec:shell",
      ]);
      const grants = new Map<string, GrantScope>();
      grants.set("fs:read", "session");

      gate.check(tool, grants);

      const call = mockLogger.calls[0];
      assert.deepEqual(call?.payload.missingCapabilities, ["fs:write", "exec:shell"]);
    });

    it("logs reason for each decision", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      // First: tool with no capabilities
      const noCapTool = createToolDescriptor("no-cap", []);
      gate.check(noCapTool, new Map());

      assert.match(
        mockLogger.calls[0]?.payload.reason as string,
        /no capabilities/i,
      );

      mockLogger.calls.length = 0;

      // Second: all capabilities granted
      const grantedTool = createToolDescriptor("granted", ["fs:read"]);
      const grants = new Map<string, GrantScope>();
      grants.set("fs:read", "session");
      gate.check(grantedTool, grants);

      assert.match(
        mockLogger.calls[0]?.payload.reason as string,
        /All required capabilities/i,
      );

      mockLogger.calls.length = 0;

      // Third: missing capabilities with deny policy
      const deniedTool = createToolDescriptor("denied", ["fs:write"]);
      gate.check(deniedTool, new Map());

      assert.match(
        mockLogger.calls[0]?.payload.reason as string,
        /Missing capabilities/i,
      );
    });

    it("logs sessionId as null (capability gate doesn't have session context)", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const tool = createToolDescriptor("any-tool", []);
      gate.check(tool, new Map());

      assert.equal(mockLogger.calls[0]?.sessionId, null);
    });
  });

  describe("capability matching", () => {
    it("respects exact capability name matching (case-sensitive)", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const tool = createToolDescriptor("fs-tool", ["fs:read"]);
      const grants = new Map<string, GrantScope>();
      grants.set("fs:read", "session");

      const decision = gate.check(tool, grants);
      assert.equal(decision.allowed, true);

      mockLogger.calls.length = 0;

      // Different case should not match
      const grants2 = new Map<string, GrantScope>();
      grants2.set("FS:READ", "session"); // uppercase

      const decision2 = gate.check(tool, grants2);
      assert.equal(decision2.allowed, false);
    });

    it("distinguishes between different capability names", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const tool = createToolDescriptor("net-tool", ["net:outbound"]);
      const grants = new Map<string, GrantScope>();
      grants.set("net:listen", "session"); // Different capability

      const decision = gate.check(tool, grants);
      assert.equal(decision.allowed, false);
      assert.deepEqual(decision.missingCapabilities, ["net:outbound"]);
    });
  });

  describe("requestApproval()", () => {
    it("returns false decision with all tool capabilities as missing", async () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const tool = createToolDescriptor("approval-test", [
        "fs:read",
        "fs:write",
      ]);

      const decision = await gate.requestApproval(tool, "session-123");

      assert.equal(decision.allowed, false);
      assert.match(
        decision.reason,
        /approval not yet implemented/i,
      );
      assert.deepEqual(decision.missingCapabilities, ["fs:read", "fs:write"]);
    });

    it("logs the approval request", async () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const tool = createToolDescriptor("logged-approval", ["fs:read"]);

      await gate.requestApproval(tool, "session-456");

      assert.equal(mockLogger.calls.length, 1);
      assert.equal(mockLogger.calls[0]?.eventType, "gate:decision");
    });
  });

  describe("security-critical paths", () => {
    it("denies by default in deny-all policy", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const highRiskTools = [
        createToolDescriptor("shell", ["exec:shell"]),
        createToolDescriptor("write", ["fs:write"]),
        createToolDescriptor("net", ["net:outbound"]),
        createToolDescriptor("browser", ["browser:navigate"]),
      ];

      for (const tool of highRiskTools) {
        const decision = gate.check(tool, new Map());
        assert.equal(
          decision.allowed,
          false,
          `${tool.name} should be denied with no grants`,
        );
      }
    });

    it("accurately reports multiple missing critical capabilities", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const tool = createToolDescriptor("dangerous", [
        "fs:write",
        "exec:shell",
        "net:outbound",
      ]);

      const decision = gate.check(tool, new Map());

      assert.equal(decision.missingCapabilities.length, 3);
      assert.ok(decision.missingCapabilities.includes("fs:write"));
      assert.ok(decision.missingCapabilities.includes("exec:shell"));
      assert.ok(decision.missingCapabilities.includes("net:outbound"));
    });

    it("only allows tools with ALL required capabilities", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const tool = createToolDescriptor("strict", ["fs:read", "fs:write"]);

      // Deny with only one of two
      const grants1 = new Map<string, GrantScope>();
      grants1.set("fs:read", "session");
      const decision1 = gate.check(tool, grants1);
      assert.equal(decision1.allowed, false);

      // Allow only with both
      const grants2 = new Map<string, GrantScope>();
      grants2.set("fs:read", "session");
      grants2.set("fs:write", "session");
      const decision2 = gate.check(tool, grants2);
      assert.equal(decision2.allowed, true);
    });
  });

  describe("edge cases", () => {
    it("handles tool with many capabilities", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const allCapabilities: Capability[] = [
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

      const tool = createToolDescriptor("all-caps", allCapabilities);

      // Deny when no grants
      const decision1 = gate.check(tool, new Map());
      assert.equal(decision1.allowed, false);
      assert.equal(decision1.missingCapabilities.length, 11);

      // Allow when all granted
      const grants = new Map<string, GrantScope>();
      for (const cap of allCapabilities) {
        grants.set(cap, "session");
      }
      const decision2 = gate.check(tool, grants);
      assert.equal(decision2.allowed, true);
      assert.equal(decision2.missingCapabilities.length, 0);
    });

    it("handles repeated grant checks on same session", () => {
      const gate = new CapabilityGate({
        defaultPolicy: "deny",
        logger: mockLogger,
      });

      const tool = createToolDescriptor("repeated", ["fs:read"]);
      const grants = new Map<string, GrantScope>();

      // First check: denied
      const decision1 = gate.check(tool, grants);
      assert.equal(decision1.allowed, false);

      // Grant and check again: allowed
      grants.set("fs:read", "session");
      const decision2 = gate.check(tool, grants);
      assert.equal(decision2.allowed, true);

      // Revoke (simulated by creating new grants map) and check: denied
      const decision3 = gate.check(tool, new Map());
      assert.equal(decision3.allowed, false);
    });
  });
});
