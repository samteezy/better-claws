import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  handler as scheduleListHandler,
  descriptor as scheduleListDescriptor,
} from "../../src/tools/built-in/schedule-list.js";
import {
  handler as scheduleAddHandler,
  descriptor as scheduleAddDescriptor,
} from "../../src/tools/built-in/schedule-add.js";
import {
  handler as scheduleEditHandler,
  descriptor as scheduleEditDescriptor,
} from "../../src/tools/built-in/schedule-edit.js";
import {
  Scheduler,
  type ScheduleDefinition,
} from "../../src/scheduler/scheduler.js";
import type { ExecutionContext, ToolResult } from "../../src/types.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

function createMockLogger() {
  const logs: Array<Record<string, unknown>> = [];
  return {
    logs,
    log(e: Record<string, unknown>) {
      logs.push(e);
    },
    async flush() {},
    async close() {},
  } as unknown as StructuredLogger & { logs: typeof logs };
}

function createScheduler(schedules: ScheduleDefinition[] = []) {
  const logger = createMockLogger();
  const scheduler = new Scheduler({
    schedules,
    logger,
    tickIntervalMs: 50,
  });
  return { scheduler, logger };
}

function createContext(scheduler?: Scheduler): ExecutionContext {
  return {
    sessionId: "test-session",
    capabilities: [],
    scratchDir: "/tmp/test",
    timeout: 30000,
    secrets: new Map(),
    scheduler,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("schedule-list", () => {
  it("returns empty array when no schedules exist", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleListHandler.execute({}, context)) as ToolResult;

    assert.equal(result.success, true);
    assert.deepEqual(result.output, []);
    assert.equal(result.error, undefined);
    assert.equal(typeof result.durationMs, "number");
    assert.ok(result.durationMs >= 0);
  });

  it("returns all schedules with metadata", async () => {
    const now = Date.now();
    const { scheduler } = createScheduler([
      {
        id: "s1",
        name: "Schedule One",
        cron: "*/5 * * * *",
        prompt: "first prompt",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "s2",
        name: "Schedule Two",
        cron: "0 9 * * *",
        prompt: "second prompt",
        enabled: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleListHandler.execute({}, context)) as ToolResult;

    assert.equal(result.success, true);
    const schedules = result.output as Array<Record<string, unknown>>;
    assert.equal(schedules.length, 2);

    const s1 = schedules.find((s) => s["id"] === "s1");
    assert.ok(s1);
    assert.equal(s1["name"], "Schedule One");
    assert.equal(s1["cron"], "*/5 * * * *");
    assert.equal(s1["prompt"], "first prompt");
    assert.equal(s1["enabled"], true);
    assert.equal(s1["createdAt"], now);
    assert.equal(s1["updatedAt"], now);
    assert.ok(s1["nextFireTime"]); // Should have next fire time

    const s2 = schedules.find((s) => s["id"] === "s2");
    assert.ok(s2);
    assert.equal(s2["enabled"], false);
    assert.equal(s2["nextFireTime"], null); // Disabled schedules have no next fire time
  });

  it("returns error when scheduler not in context", async () => {
    const context = createContext(undefined);

    const result = (await scheduleListHandler.execute({}, context)) as ToolResult;

    assert.equal(result.success, false);
    assert.equal(result.output, null);
    assert.ok(result.error);
    assert.match(result.error, /[Ss]cheduling is not configured/);
  });

  it("descriptor has correct name and no capabilities", () => {
    assert.equal(scheduleListDescriptor.name, "schedule-list");
    assert.ok(scheduleListDescriptor.description.length > 0);
    assert.deepEqual(scheduleListDescriptor.capabilities, []);
    assert.deepEqual(scheduleListDescriptor.parameters.required, []);
  });

  it("descriptor parameters are empty object", () => {
    assert.deepEqual(scheduleListDescriptor.parameters.properties, {});
  });
});

describe("schedule-add", () => {
  it("creates schedule with auto-assigned ID", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleAddHandler.execute(
      {
        name: "New Schedule",
        cron: "*/10 * * * *",
        prompt: "test prompt",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, true);
    assert.ok(result.output);
    const output = result.output as Record<string, unknown>;
    assert.ok(output["id"]);
    assert.equal(output["name"], "New Schedule");
    assert.equal(output["cron"], "*/10 * * * *");
    assert.equal(output["prompt"], "test prompt");
    assert.equal(output["enabled"], true);

    // Verify it was added to scheduler
    const schedules = scheduler.getAll();
    assert.equal(schedules.length, 1);
  });

  it("returns error on missing name", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleAddHandler.execute(
      {
        cron: "*/5 * * * *",
        prompt: "test",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Mm]issing required parameter: name/);
  });

  it("returns error on empty string name", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleAddHandler.execute(
      {
        name: "",
        cron: "*/5 * * * *",
        prompt: "test",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Mm]issing required parameter: name/);
  });

  it("returns error on missing cron", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleAddHandler.execute(
      {
        name: "Test",
        prompt: "test",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Mm]issing required parameter: cron/);
  });

  it("returns error on empty string cron", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleAddHandler.execute(
      {
        name: "Test",
        cron: "",
        prompt: "test",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Mm]issing required parameter: cron/);
  });

  it("returns error on missing prompt", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleAddHandler.execute(
      {
        name: "Test",
        cron: "*/5 * * * *",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Mm]issing required parameter: prompt/);
  });

  it("returns error on empty string prompt", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleAddHandler.execute(
      {
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Mm]issing required parameter: prompt/);
  });

  it("returns error on invalid cron expression", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleAddHandler.execute(
      {
        name: "Bad Cron",
        cron: "invalid cron",
        prompt: "test",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Ii]nvalid cron expression/);
  });

  it("returns error when scheduler not in context", async () => {
    const context = createContext(undefined);

    const result = (await scheduleAddHandler.execute(
      {
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Ss]cheduling is not configured/);
  });

  it("respects enabled parameter set to false", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleAddHandler.execute(
      {
        name: "Disabled Schedule",
        cron: "*/5 * * * *",
        prompt: "test",
        enabled: false,
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, true);
    const output = result.output as Record<string, unknown>;
    assert.equal(output["enabled"], false);

    // Verify it's disabled in scheduler
    const id = output["id"] as string;
    const schedule = scheduler.getSchedule(id);
    assert.ok(schedule);
    assert.equal(schedule.enabled, false);
  });

  it("respects enabled parameter set to true", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleAddHandler.execute(
      {
        name: "Enabled Schedule",
        cron: "*/5 * * * *",
        prompt: "test",
        enabled: true,
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, true);
    const output = result.output as Record<string, unknown>;
    assert.equal(output["enabled"], true);
  });

  it("defaults enabled to true when not provided", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    const result = (await scheduleAddHandler.execute(
      {
        name: "Default Enabled",
        cron: "*/5 * * * *",
        prompt: "test",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, true);
    const output = result.output as Record<string, unknown>;
    assert.equal(output["enabled"], true);
  });

  it("descriptor has correct name and required params", () => {
    assert.equal(scheduleAddDescriptor.name, "schedule-add");
    assert.ok(scheduleAddDescriptor.description.length > 0);
    assert.deepEqual(scheduleAddDescriptor.capabilities, []);
    assert.deepEqual(scheduleAddDescriptor.parameters.required, [
      "name",
      "cron",
      "prompt",
    ]);
  });

  it("descriptor includes all parameters", () => {
    const props = scheduleAddDescriptor.parameters.properties;
    assert.ok(props && "name" in props);
    assert.ok(props && "cron" in props);
    assert.ok(props && "prompt" in props);
    assert.ok(props && "enabled" in props);
  });
});

describe("schedule-edit", () => {
  it("updates schedule name successfully", async () => {
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Original Name",
        cron: "*/5 * * * *",
        prompt: "test",
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        id: "edit-1",
        name: "Updated Name",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, true);
    const output = result.output as Record<string, unknown>;
    assert.equal(output["name"], "Updated Name");

    const schedule = scheduler.getSchedule("edit-1");
    assert.ok(schedule);
    assert.equal(schedule.name, "Updated Name");
  });

  it("updates schedule cron expression", async () => {
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        id: "edit-1",
        cron: "0 9 * * *",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, true);
    const output = result.output as Record<string, unknown>;
    assert.equal(output["cron"], "0 9 * * *");
  });

  it("updates schedule prompt", async () => {
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "original prompt",
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        id: "edit-1",
        prompt: "new prompt",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, true);
    const output = result.output as Record<string, unknown>;
    assert.equal(output["prompt"], "new prompt");
  });

  it("returns error for non-existent ID", async () => {
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        id: "nonexistent",
        name: "Updated",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /not found|does not exist/i);
  });

  it("returns error on missing id parameter", async () => {
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        name: "Updated",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Mm]issing required parameter: id/);
  });

  it("returns error on empty string id", async () => {
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        id: "",
        name: "Updated",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Mm]issing required parameter: id/);
  });

  it("returns error on invalid cron expression", async () => {
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        id: "edit-1",
        cron: "bad cron",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Ii]nvalid cron expression/);
  });

  it("returns error when scheduler not in context", async () => {
    const context = createContext(undefined);

    const result = (await scheduleEditHandler.execute(
      {
        id: "test",
        name: "Updated",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /[Ss]cheduling is not configured/);
  });

  it("can toggle enabled field to false", async () => {
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
        enabled: true,
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        id: "edit-1",
        enabled: false,
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, true);
    const output = result.output as Record<string, unknown>;
    assert.equal(output["enabled"], false);

    const schedule = scheduler.getSchedule("edit-1");
    assert.ok(schedule);
    assert.equal(schedule.enabled, false);
  });

  it("can toggle enabled field to true", async () => {
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
        enabled: false,
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        id: "edit-1",
        enabled: true,
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, true);
    const output = result.output as Record<string, unknown>;
    assert.equal(output["enabled"], true);
  });

  it("updates createdAt and updatedAt timestamps", async () => {
    const now = Date.now();
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
        createdAt: now - 10000,
        updatedAt: now - 10000,
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        id: "edit-1",
        name: "Updated",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, true);
    const output = result.output as Record<string, unknown>;
    const createdAt = output["createdAt"] as number;
    const updatedAt = output["updatedAt"] as number;

    assert.equal(createdAt, now - 10000); // Should not change
    assert.ok(updatedAt > now - 10000); // Should be updated
  });

  it("can update multiple fields at once", async () => {
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Original",
        cron: "*/5 * * * *",
        prompt: "original",
        enabled: true,
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        id: "edit-1",
        name: "Updated Name",
        cron: "0 9 * * *",
        prompt: "updated prompt",
        enabled: false,
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, true);
    const output = result.output as Record<string, unknown>;
    assert.equal(output["name"], "Updated Name");
    assert.equal(output["cron"], "0 9 * * *");
    assert.equal(output["prompt"], "updated prompt");
    assert.equal(output["enabled"], false);
  });

  it("returns error on invalid cron when updating multiple fields", async () => {
    const { scheduler } = createScheduler([
      {
        id: "edit-1",
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
      },
    ]);
    const context = createContext(scheduler);

    const result = (await scheduleEditHandler.execute(
      {
        id: "edit-1",
        name: "Updated",
        cron: "bad cron",
      },
      context,
    )) as ToolResult;

    assert.equal(result.success, false);
    // Original schedule should be unchanged
    const schedule = scheduler.getSchedule("edit-1");
    assert.ok(schedule);
    assert.equal(schedule.name, "Test");
  });

  it("descriptor has correct name and required params", () => {
    assert.equal(scheduleEditDescriptor.name, "schedule-edit");
    assert.ok(scheduleEditDescriptor.description.length > 0);
    assert.deepEqual(scheduleEditDescriptor.capabilities, []);
    assert.deepEqual(scheduleEditDescriptor.parameters.required, ["id"]);
  });

  it("descriptor includes all optional parameters", () => {
    const props = scheduleEditDescriptor.parameters.properties;
    assert.ok(props && "id" in props);
    assert.ok(props && "name" in props);
    assert.ok(props && "cron" in props);
    assert.ok(props && "prompt" in props);
    assert.ok(props && "enabled" in props);
  });
});

describe("schedule tools integration", () => {
  it("workflow: add, list, then edit", async () => {
    const { scheduler } = createScheduler([]);
    const context = createContext(scheduler);

    // Add a schedule
    const addResult = (await scheduleAddHandler.execute(
      {
        name: "Workflow Test",
        cron: "*/5 * * * *",
        prompt: "initial",
      },
      context,
    )) as ToolResult;
    assert.equal(addResult.success, true);
    const scheduleId = (addResult.output as Record<string, unknown>)["id"] as string;

    // List schedules
    const listResult = (await scheduleListHandler.execute({}, context)) as ToolResult;
    assert.equal(listResult.success, true);
    const schedules = listResult.output as Array<Record<string, unknown>>;
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]!["id"], scheduleId);

    // Edit the schedule
    const editResult = (await scheduleEditHandler.execute(
      {
        id: scheduleId,
        name: "Workflow Test Updated",
        prompt: "updated",
      },
      context,
    )) as ToolResult;
    assert.equal(editResult.success, true);

    // List again to verify changes
    const listResult2 = (await scheduleListHandler.execute({}, context)) as ToolResult;
    const schedules2 = listResult2.output as Array<Record<string, unknown>>;
    assert.equal(schedules2[0]!["name"], "Workflow Test Updated");
    assert.equal(schedules2[0]!["prompt"], "updated");
  });

  it("all tools measure execution duration", async () => {
    const { scheduler } = createScheduler([
      {
        id: "s1",
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
      },
    ]);
    const context = createContext(scheduler);

    const listResult = (await scheduleListHandler.execute({}, context)) as ToolResult;
    assert.ok(typeof listResult.durationMs === "number");
    assert.ok(listResult.durationMs >= 0);

    const addResult = (await scheduleAddHandler.execute(
      {
        name: "Test",
        cron: "*/5 * * * *",
        prompt: "test",
      },
      context,
    )) as ToolResult;
    assert.ok(typeof addResult.durationMs === "number");
    assert.ok(addResult.durationMs >= 0);

    const editResult = (await scheduleEditHandler.execute(
      {
        id: "s1",
        name: "Updated",
      },
      context,
    )) as ToolResult;
    assert.ok(typeof editResult.durationMs === "number");
    assert.ok(editResult.durationMs >= 0);
  });
});
