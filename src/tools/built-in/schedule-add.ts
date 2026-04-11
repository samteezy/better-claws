import type {
  ToolDescriptor,
  ToolHandler,
  ExecutionContext,
  ToolResult,
} from "../../types.js";
import { parseCron } from "../../scheduler/cron-parser.js";

export const descriptor: ToolDescriptor = {
  name: "schedule-add",
  description:
    "Create a new scheduled task that runs a prompt on a cron schedule. Returns the created schedule with its assigned ID.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Human-readable name for the scheduled task",
      },
      cron: {
        type: "string",
        description: "Cron expression (5-field: minute hour day-of-month month day-of-week)",
      },
      prompt: {
        type: "string",
        description: "The prompt text to execute when the schedule fires",
      },
      enabled: {
        type: "boolean",
        description: "Whether the schedule is enabled. Defaults to true.",
      },
    },
    required: ["name", "cron", "prompt"],
  },
  capabilities: [],
};

export const handler: ToolHandler = {
  async execute(
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const start = Date.now();

    if (!context.scheduler) {
      return {
        success: false,
        output: null,
        error: "Scheduling is not configured",
        durationMs: Date.now() - start,
      };
    }

    const name = params["name"];
    const cron = params["cron"];
    const prompt = params["prompt"];
    const enabled = params["enabled"];

    if (typeof name !== "string" || name.length === 0) {
      return {
        success: false,
        output: null,
        error: "Missing required parameter: name",
        durationMs: Date.now() - start,
      };
    }

    if (typeof cron !== "string" || cron.length === 0) {
      return {
        success: false,
        output: null,
        error: "Missing required parameter: cron",
        durationMs: Date.now() - start,
      };
    }

    if (typeof prompt !== "string" || prompt.length === 0) {
      return {
        success: false,
        output: null,
        error: "Missing required parameter: prompt",
        durationMs: Date.now() - start,
      };
    }

    // Validate cron expression before creating
    try {
      parseCron(cron);
    } catch {
      return {
        success: false,
        output: null,
        error: `Invalid cron expression: "${cron}". Expected 5 space-separated fields: minute hour day-of-month month day-of-week`,
        durationMs: Date.now() - start,
      };
    }

    const id = await context.scheduler.addSchedule({
      name,
      cron,
      prompt,
      enabled: typeof enabled === "boolean" ? enabled : true,
    });

    const created = context.scheduler.getSchedule(id);

    return {
      success: true,
      output: {
        id,
        ...created,
      },
      durationMs: Date.now() - start,
    };
  },
};
