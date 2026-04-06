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

  // Register adapter tokens and secrets
  for (const [name, adapter] of Object.entries(config.adapters)) {
    if (adapter?.token) {
      manager.register(`adapter:${name}:token`, adapter.token, "env");
    }
    if (adapter?.secret) {
      manager.register(`adapter:${name}:secret`, adapter.secret, "env");
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
