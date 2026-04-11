import type {
  ToolDescriptor,
  ToolHandler,
  ExecutionContext,
  ToolResult,
} from "../../types.js";

export const descriptor: ToolDescriptor = {
  name: "schedule-list",
  description:
    "List all scheduled tasks with their ID, name, cron expression, prompt, enabled status, and next fire time.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  capabilities: [],
};

export const handler: ToolHandler = {
  async execute(
    _params: Record<string, unknown>,
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

    const schedules = context.scheduler.getAll().map((s) => {
      const nextFire = s.id ? context.scheduler!.getNextFireTime(s.id) : null;
      return {
        id: s.id,
        name: s.name,
        cron: s.cron,
        prompt: s.prompt,
        enabled: s.enabled !== false,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        nextFireTime: nextFire?.toISOString() ?? null,
      };
    });

    return {
      success: true,
      output: schedules,
      durationMs: Date.now() - start,
    };
  },
};
