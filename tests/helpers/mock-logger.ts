import type { StructuredLogger } from "../../src/logger/structured-logger.js";

export function createMockLogger(): StructuredLogger & { logs: Array<Record<string, unknown>> } {
  const logs: Array<Record<string, unknown>> = [];
  return {
    logs,
    log(e: Record<string, unknown>) { logs.push(e); },
    async flush() {},
    async close() {},
  } as unknown as StructuredLogger & { logs: typeof logs };
}
