import type { BetterClawsConfig } from "../types.js";
import type { SecretManager } from "./secret-manager.js";

export function seedFromConfig(
  manager: SecretManager,
  config: BetterClawsConfig,
): void {
  // Register LLM API key
  if (config.llm.apiKey) {
    manager.register("llm:apiKey", config.llm.apiKey, "env");
  }

  // Register weak LLM API key (falls back to main key)
  if (config.llm.weak) {
    const weakApiKey = config.llm.weak.apiKey ?? config.llm.apiKey;
    if (weakApiKey) {
      manager.register("llm:weak:apiKey", weakApiKey, "env");
    }
  }

  // Register adapter tokens and secrets
  for (const [name, adapter] of Object.entries(config.adapters)) {
    if (adapter?.token) {
      manager.register(`adapter:${name}:token`, adapter.token, "env");
    }
    if (adapter?.secret) {
      manager.register(`adapter:${name}:secret`, adapter.secret, "env");
    }
    if (adapter?.apiUrl) {
      manager.register(`adapter:${name}:apiUrl`, adapter.apiUrl, "env");
    }
    if (adapter?.number) {
      manager.register(`adapter:${name}:number`, adapter.number, "env");
    }
  }

  // Register user-defined secrets from config.secrets section
  if (config.secrets) {
    for (const [key, value] of Object.entries(config.secrets)) {
      if (value) {
        manager.register(key, value, "config");
      }
    }
  }
}
