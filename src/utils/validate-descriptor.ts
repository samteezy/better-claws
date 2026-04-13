import { BetterClawsError, isCapability, type ToolDescriptor } from "../types.js";

export interface ValidateDescriptorOptions {
  /** When true, validate the optional `secrets` array. */
  readonly validateSecrets?: boolean;
}

/**
 * Validate a raw object as a ToolDescriptor.
 * Throws `BetterClawsError` on any validation failure.
 */
export function validateToolDescriptor(
  raw: unknown,
  label: string,
  options?: ValidateDescriptorOptions,
): ToolDescriptor {
  if (raw === null || typeof raw !== "object") {
    throw new BetterClawsError(
      `Descriptor for "${label}" is not an object`,
      "validation",
      "INVALID_DESCRIPTOR",
    );
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj["name"] !== "string" || obj["name"].length === 0) {
    throw new BetterClawsError(
      `Descriptor for "${label}" missing "name"`,
      "validation",
      "INVALID_DESCRIPTOR",
    );
  }
  if (typeof obj["description"] !== "string") {
    throw new BetterClawsError(
      `Descriptor for "${label}" missing "description"`,
      "validation",
      "INVALID_DESCRIPTOR",
    );
  }
  if (obj["parameters"] === null || typeof obj["parameters"] !== "object") {
    throw new BetterClawsError(
      `Descriptor for "${label}" missing "parameters"`,
      "validation",
      "INVALID_DESCRIPTOR",
    );
  }
  if (!Array.isArray(obj["capabilities"])) {
    throw new BetterClawsError(
      `Descriptor for "${label}" missing "capabilities" array`,
      "validation",
      "INVALID_DESCRIPTOR",
    );
  }

  for (const cap of obj["capabilities"]) {
    if (typeof cap !== "string" || !isCapability(cap)) {
      throw new BetterClawsError(
        `Descriptor for "${label}" has unknown capability: "${String(cap)}"`,
        "validation",
        "INVALID_CAPABILITY",
      );
    }
  }

  let secrets: readonly string[] | undefined;
  if (options?.validateSecrets && obj["secrets"] !== undefined) {
    if (!Array.isArray(obj["secrets"])) {
      throw new BetterClawsError(
        `Descriptor for "${label}" has invalid "secrets" field (expected array)`,
        "validation",
        "INVALID_DESCRIPTOR",
      );
    }
    for (const s of obj["secrets"]) {
      if (typeof s !== "string" || s.length === 0) {
        throw new BetterClawsError(
          `Descriptor for "${label}" has invalid secret key: "${String(s)}"`,
          "validation",
          "INVALID_DESCRIPTOR",
        );
      }
    }
    secrets = obj["secrets"] as string[];
  }

  return {
    name: obj["name"] as string,
    description: obj["description"] as string,
    parameters: obj["parameters"] as ToolDescriptor["parameters"],
    capabilities: obj["capabilities"] as unknown as ToolDescriptor["capabilities"],
    ...(secrets ? { secrets } : {}),
  };
}
