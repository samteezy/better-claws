import type { BuiltInToolModule } from "../../types.js";
import * as shell from "./shell.js";
import * as fileRead from "./file-read.js";
import * as fileWrite from "./file-write.js";
import * as webFetch from "./web-fetch.js";
import * as memoryUpdate from "./memory-update.js";

export const builtInTools: readonly BuiltInToolModule[] = [
  shell,
  fileRead,
  fileWrite,
  webFetch,
  memoryUpdate,
];
