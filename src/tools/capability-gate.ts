import {
  BetterClawsError,
  type Capability,
  type GateDecision,
  type GrantScope,
  type ToolDescriptor,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";

export class GateError extends BetterClawsError {
  constructor(message: string, code: string = "GATE_ERROR") {
    super(message, "gate", code);
    this.name = "GateError";
  }
}

export interface CapabilityGateOptions {
  readonly defaultPolicy: "deny" | "allow";
  readonly logger: StructuredLogger;
}

export class CapabilityGate {
  private readonly defaultPolicy: "deny" | "allow";
  private readonly logger: StructuredLogger;

  constructor(options: CapabilityGateOptions) {
    this.defaultPolicy = options.defaultPolicy;
    this.logger = options.logger;
  }

  check(
    toolDescriptor: ToolDescriptor,
    sessionGrants: Map<string, GrantScope>,
  ): GateDecision {
    const required = toolDescriptor.capabilities;

    // Tools with no capability requirements always pass
    if (required.length === 0) {
      const decision: GateDecision = {
        allowed: true,
        reason: "Tool requires no capabilities",
        missingCapabilities: [],
      };
      this.logDecision(toolDescriptor.name, decision);
      return decision;
    }

    const missing: Capability[] = [];
    for (const cap of required) {
      if (!sessionGrants.has(cap)) {
        missing.push(cap);
      }
    }

    if (missing.length === 0) {
      const decision: GateDecision = {
        allowed: true,
        reason: "All required capabilities granted",
        missingCapabilities: [],
      };
      this.logDecision(toolDescriptor.name, decision);
      return decision;
    }

    const decision: GateDecision = {
      allowed: this.defaultPolicy === "allow",
      reason:
        this.defaultPolicy === "deny"
          ? `Missing capabilities: ${missing.join(", ")}`
          : `Default allow policy — missing capabilities noted: ${missing.join(", ")}`,
      missingCapabilities: missing,
    };
    this.logDecision(toolDescriptor.name, decision);
    return decision;
  }

  async requestApproval(
    toolDescriptor: ToolDescriptor,
    _sessionId: string,
  ): Promise<GateDecision> {
    // Placeholder — in the future this sends an approval request via the adapter
    const decision: GateDecision = {
      allowed: false,
      reason: "User approval not yet implemented — denied by default",
      missingCapabilities: [...toolDescriptor.capabilities],
    };
    this.logDecision(toolDescriptor.name, decision);
    return decision;
  }

  private logDecision(toolName: string, decision: GateDecision): void {
    this.logger.log({
      sessionId: null,
      eventType: "gate:decision",
      component: "gate",
      payload: {
        tool: toolName,
        allowed: decision.allowed,
        reason: decision.reason,
        missingCapabilities: decision.missingCapabilities,
      },
    });
  }
}
