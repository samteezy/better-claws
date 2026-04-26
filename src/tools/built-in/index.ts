import type { BuiltInToolModule } from "../../types.js";
import * as shell from "./shell.js";
import * as fileRead from "./file-read.js";
import * as fileWrite from "./file-write.js";
import * as webFetch from "./web-fetch.js";
import * as memory from "./memory.js";
import * as scheduleList from "./schedule-list.js";
import * as scheduleAdd from "./schedule-add.js";
import * as scheduleEdit from "./schedule-edit.js";
import * as agenda from "./agenda.js";

export const builtInTools: readonly BuiltInToolModule[] = [
  shell,
  fileRead,
  fileWrite,
  webFetch,
  memory,
  scheduleList,
  scheduleAdd,
  scheduleEdit,
  agenda,
];
