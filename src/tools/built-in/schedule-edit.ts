import { toErrorMessage } from "../../utils/errors.js";
import type {
  ToolDescriptor,
  ToolHandler,
  ExecutionContext,
  ToolResult,
} from "../../types.js";
import { parseCron } from "../../scheduler/cron-parser.js";

export const descriptor: ToolDescriptor = {
  name: "schedule-edit",
  description:
    "Update an existing scheduled task. Provide the schedule ID and any fields to change. Cannot remove schedules — only disable them.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The ID of the schedule to update",
      },
      name: {
        type: "string",
        description: "New name for the scheduled task",
      },
      cron: {
        type: "string",
        description: "New cron expression (5-field: minute hour day-of-month month day-of-week)",
      },
      prompt: {
        type: "string",
        description: "New prompt text",
      },
      enabled: {
        type: "boolean",
        description: "Enable or disable the schedule",
      },
    },
    required: ["id"],
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

    const id = params["id"];
    if (typeof id !== "string" || id.length === 0) {
      return {
        success: false,
        output: null,
        error: "Missing required parameter: id",
        durationMs: Date.now() - start,
      };
    }

    // Validate cron if provided
    const cron = params["cron"];
    if (cron !== undefined) {
      if (typeof cron !== "string" || cron.length === 0) {
        return {
          success: false,
          output: null,
          error: "Parameter 'cron' must be a non-empty string",
          durationMs: Date.now() - start,
        };
      }
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
    }

    const partial: Record<string, unknown> = {};
    if (params["name"] !== undefined) partial["name"] = params["name"];
    if (params["cron"] !== undefined) partial["cron"] = params["cron"];
    if (params["prompt"] !== undefined) partial["prompt"] = params["prompt"];
    if (params["enabled"] !== undefined) partial["enabled"] = params["enabled"];

    try {
      const updated = await context.scheduler.updateSchedule(
        id,
        partial as { name?: string; cron?: string; prompt?: string; enabled?: boolean },
      );
      return {
        success: true,
        output: updated,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: toErrorMessage(err),
        durationMs: Date.now() - start,
      };
    }
  },
};
