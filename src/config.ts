import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createErrorClass,
  type BetterClawsConfig,
  type LlmConfig } from "./types.js";

export interface ResolvedWeakLlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature: number;
}

export function resolveWeakLlmConfig(llm: LlmConfig): ResolvedWeakLlmConfig | null {
  if (!llm.weak) return null;
  return {
    baseUrl: llm.weak.baseUrl ?? llm.baseUrl,
    apiKey: llm.weak.apiKey ?? llm.apiKey,
    model: llm.weak.model,
    maxTokens: llm.weak.maxTokens ?? llm.maxTokens,
    temperature: llm.weak.temperature ?? llm.temperature,
  };
}

export const ConfigError = createErrorClass("ConfigError", "config", "CONFIG_ERROR");

export const DEFAULT_CONFIG: BetterClawsConfig = {
  gateway: {
    host: "127.0.0.1",
    port: 18700,
  },
  llm: {
    baseUrl: "http://localhost:11434/v1",
    apiKey: "",
    model: "qwen3:8b",
    maxTokens: 24000,
    temperature: 0.7,
  },
  adapters: {},
  security: {
    defaultCapabilityPolicy: "deny",
    sandboxTimeout: 30000,
    stripEnvironment: true,
    allowPersistentGrants: false,
    autoGrantCapabilities: ["fs:read", "memory:read", "memory:write"],
  },
  memory: {
    maxLongTermEntries: 2000,
    confidenceDecayRate: 0.01,
    staleThreshold: 0.2,
    curationIntervalMinutes: 60,
    curationEnabled: true,
    workingMemoryBudgetChars: 8192,
  },
  logging: {
    directory: "data/logs",
    redactSensitive: true,
    retentionDays: 90,
  },
  systemContext: {
    timezone: "UTC",
  },
};

export function resolveEnvSecrets(obj: unknown): unknown {
  if (typeof obj === "string") {
    if (obj.startsWith("env:")) {
      const varName = obj.slice(4);
      const value = process.env[varName];
      if (value === undefined) {
        throw new ConfigError(
          `Environment variable "${varName}" is not set (referenced as "${obj}")`,
          "MISSING_ENV_VAR",
        );
      }
      return value;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(resolveEnvSecrets);
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveEnvSecrets(value);
    }
    return result;
  }

  return obj;
}

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];

    if (
      targetValue !== null &&
      sourceValue !== null &&
      typeof targetValue === "object" &&
      typeof sourceValue === "object" &&
      !Array.isArray(targetValue) &&
      !Array.isArray(sourceValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>,
      );
    } else {
      result[key] = sourceValue;
    }
  }

  return result as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateConfig(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new ConfigError(
      "Configuration must be a JSON object",
      "INVALID_FORMAT",
    );
  }

  if (raw["gateway"] !== undefined && !isRecord(raw["gateway"])) {
    throw new ConfigError('"gateway" must be an object', "INVALID_FORMAT");
  }
  if (raw["llm"] !== undefined && !isRecord(raw["llm"])) {
    throw new ConfigError('"llm" must be an object', "INVALID_FORMAT");
  }
  if (raw["security"] !== undefined && !isRecord(raw["security"])) {
    throw new ConfigError('"security" must be an object', "INVALID_FORMAT");
  }

  return raw;
}

export async function loadConfig(
  configPath?: string,
): Promise<BetterClawsConfig> {
  const filePath = resolve(configPath ?? "config/betterclaws.json");

  let raw: unknown;
  try {
    const content = await readFile(filePath, "utf-8");
    raw = JSON.parse(content) as unknown;
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return DEFAULT_CONFIG;
    }
    throw new ConfigError(
      `Failed to read config at "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      "READ_ERROR",
    );
  }

  const validated = validateConfig(raw);
  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    validated,
  ) as unknown as BetterClawsConfig;
  const resolved = resolveEnvSecrets(merged) as BetterClawsConfig;

  return resolved;
}

/**
 * Write config back to disk. Secrets that were resolved from env vars
 * are NOT written — only the raw JSON structure is saved.
 * The caller is responsible for providing the raw (unresolved) config.
 */
export async function saveConfig(
  config: Record<string, unknown>,
  configPath?: string,
): Promise<void> {
  const filePath = resolve(configPath ?? "config/betterclaws.json");
  const json = JSON.stringify(config, null, 2) + "\n";
  try {
    await writeFile(filePath, json, "utf-8");
  } catch (err) {
    throw new ConfigError(
      `Failed to write config at "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      "WRITE_ERROR",
    );
  }
}
