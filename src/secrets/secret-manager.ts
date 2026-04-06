import type { StructuredLogger } from "../logger/structured-logger.js";
import { SecretError } from "./errors.js";

export type SecretSource = "env" | "config" | "runtime";

export interface SecretEntry {
  readonly key: string;
  readonly value: string;
  readonly source: SecretSource;
  readonly createdAt: number;
  updatedAt: number;
}

export interface SecretManagerOptions {
  readonly logger: StructuredLogger;
}

export class SecretManager {
  private readonly store = new Map<string, SecretEntry>();
  private readonly logger: StructuredLogger;

  constructor(options: SecretManagerOptions) {
    this.logger = options.logger;
  }

  register(key: string, value: string, source: SecretSource): void {
    const now = Date.now();
    const existing = this.store.get(key);

    if (existing) {
      existing.updatedAt = now;
      // Replace entry to update value/source while preserving createdAt
      this.store.set(key, {
        key,
        value,
        source,
        createdAt: existing.createdAt,
        updatedAt: now,
      });
    } else {
      this.store.set(key, {
        key,
        value,
        source,
        createdAt: now,
        updatedAt: now,
      });
    }

    this.logger.log({
      sessionId: null,
      eventType: "secret:register",
      component: "secrets",
      payload: { key, source },
    });
  }

  get(key: string): string {
    const entry = this.store.get(key);
    if (!entry) {
      throw new SecretError(
        `Secret not found: "${key}"`,
        "SECRET_NOT_FOUND",
      );
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }

  revoke(key: string): boolean {
    const existed = this.store.delete(key);
    if (existed) {
      this.logger.log({
        sessionId: null,
        eventType: "secret:revoke",
        component: "secrets",
        payload: { key },
      });
    }
    return existed;
  }

  projectForTool(
    allowedKeys: readonly string[],
    sessionId: string,
    toolName: string,
  ): ReadonlyMap<string, string> {
    const projected = new Map<string, string>();

    for (const key of allowedKeys) {
      const entry = this.store.get(key);
      if (entry) {
        projected.set(key, entry.value);
        this.logger.log({
          sessionId,
          eventType: "secret:access",
          component: "secrets",
          payload: { toolName, key },
        });
      } else {
        this.logger.log({
          sessionId,
          eventType: "secret:access",
          component: "secrets",
          payload: { toolName, key, warning: "secret not found" },
        });
      }
    }

    return projected;
  }
}
