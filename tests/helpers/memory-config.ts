import type { MemoryConfig } from "../../src/types.js";

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxLongTermEntries: 2000,
  confidenceDecayRate: 0.01,
  staleThreshold: 0.2,
  curationIntervalMinutes: 60,
  curationEnabled: true,
  workingMemoryBudgetChars: 8192,
};
