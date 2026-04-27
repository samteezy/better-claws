import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Scheduler,
  type ScheduleDefinition,
} from "../../src/scheduler/scheduler.js";
import { CronParseError } from "../../src/scheduler/cron-parser.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { InboundMessage } from "../../src/types.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

function createMockLogger() {
  const logs: Array<Record<string, unknown>> = [];
  return {
    logs,
    log(e: Record<string, unknown>) { logs.push(e); },
    async flush() {},
    async close() {},
  } as unknown as StructuredLogger & { logs: typeof logs };
}

function makeScheduler(
  schedules: ScheduleDefinition[],
  overrides?: {
    tickIntervalMs?: number;
    logger?: ReturnType<typeof createMockLogger>;
    saveConfig?: (config: Record<string, unknown>, path?: string) => Promise<void>;
    rawConfig?: Record<string, unknown>;
    configPath?: string;
  },
) {
  const logger = overrides?.logger ?? createMockLogger();
  const scheduler = new Scheduler({
    schedules,
    logger,
    tickIntervalMs: overrides?.tickIntervalMs ?? 50,
    saveConfig: overrides?.saveConfig,
    rawConfig: overrides?.rawConfig,
    configPath: overrides?.configPath,
  });
  return { scheduler, logger };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Scheduler", () => {
  describe("constructor and ChannelAdapter interface", () => {
    it("has correct id and name", () => {
      const { scheduler } = makeScheduler([]);
      assert.equal(scheduler.id, "cron");
      assert.equal(scheduler.name, "Cron Scheduler");
    });

    it("implements all ChannelAdapter methods", () => {
      const { scheduler } = makeScheduler([]);
      assert.equal(typeof scheduler.start, "function");
      assert.equal(typeof scheduler.stop, "function");
      assert.equal(typeof scheduler.onMessage, "function");
      assert.equal(typeof scheduler.send, "function");
    });

    it("loads enabled schedules and skips disabled ones", () => {
      const { scheduler } = makeScheduler([
        { name: "Active", cron: "*/5 * * * *", prompt: "do stuff" },
        { name: "Disabled", cron: "0 9 * * *", prompt: "nope", enabled: false },
      ]);
      assert.equal(scheduler.getScheduleIds().length, 1);
    });

    it("throws CronParseError for invalid cron expression", () => {
      assert.throws(
        () => makeScheduler([{ name: "Bad", cron: "invalid", prompt: "x" }]),
        (err: unknown) => err instanceof CronParseError,
      );
    });
  });

  describe("start / stop", () => {
    it("logs start event with schedule count", async () => {
      const { scheduler, logger } = makeScheduler([
        { name: "Test", cron: "*/5 * * * *", prompt: "hello" },
      ]);

      await scheduler.start();
      await scheduler.stop();

      const startLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "start",
      );
      assert.ok(startLog);
      assert.equal((startLog["payload"] as Record<string, unknown>)["scheduleCount"], 1);
    });

    it("logs stop event", async () => {
      const { scheduler, logger } = makeScheduler([]);
      await scheduler.start();
      await scheduler.stop();

      const stopLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "stop",
      );
      assert.ok(stopLog);
    });
  });

  describe("tick() and schedule firing", () => {
    it("fires schedule when cron matches current time", async () => {
      const { scheduler } = makeScheduler([
        { id: "test-1", name: "Every minute", cron: "* * * * *", prompt: "ping" },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();

      // Manually tick with a specific time
      scheduler.tick(new Date(2024, 0, 1, 12, 30, 0));

      assert.equal(received.length, 1);
      assert.equal(received[0]!.text, "ping");
      assert.equal(received[0]!.adapterId, "cron");
      assert.ok(received[0]!.channelId.startsWith("cron:test-1:"));
      assert.equal(received[0]!.senderId, "scheduler");

      await scheduler.stop();
    });

    it("does not fire when cron does not match", async () => {
      const { scheduler } = makeScheduler([
        { id: "test-1", name: "Noon only", cron: "0 12 * * *", prompt: "noon" },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();
      // 11:30 does not match "0 12"
      scheduler.tick(new Date(2024, 0, 1, 11, 30, 0));

      assert.equal(received.length, 0);

      await scheduler.stop();
    });

    it("prevents double-firing within the same minute", async () => {
      const { scheduler } = makeScheduler([
        { id: "test-1", name: "Every minute", cron: "* * * * *", prompt: "tick" },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();

      const time = new Date(2024, 0, 1, 12, 30, 0);
      scheduler.tick(time);
      scheduler.tick(new Date(time.getTime() + 15_000)); // 15 seconds later, same minute

      assert.equal(received.length, 1);

      await scheduler.stop();
    });

    it("fires again in the next minute", async () => {
      const { scheduler } = makeScheduler([
        { id: "test-1", name: "Every minute", cron: "* * * * *", prompt: "tick" },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();

      scheduler.tick(new Date(2024, 0, 1, 12, 30, 0));
      scheduler.tick(new Date(2024, 0, 1, 12, 31, 0));

      assert.equal(received.length, 2);

      await scheduler.stop();
    });

    it("fires multiple schedules at the same time", async () => {
      const { scheduler } = makeScheduler([
        { id: "s1", name: "First", cron: "* * * * *", prompt: "one" },
        { id: "s2", name: "Second", cron: "* * * * *", prompt: "two" },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();
      scheduler.tick(new Date(2024, 0, 1, 12, 0, 0));

      assert.equal(received.length, 2);
      const texts = received.map((m) => m.text);
      assert.ok(texts.includes("one"));
      assert.ok(texts.includes("two"));

      await scheduler.stop();
    });

    it("fireSchedule produces a channelId that includes a timestamp component", async () => {
      const { scheduler } = makeScheduler([
        { id: "ts-test", name: "Timestamp test", cron: "* * * * *", prompt: "ping" },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();

      const fireTime = new Date(2024, 0, 1, 12, 30, 0);
      scheduler.tick(fireTime);

      assert.equal(received.length, 1);
      // channelId should be cron:<id>:<timestamp>
      const parts = received[0]!.channelId.split(":");
      assert.equal(parts[0], "cron");
      assert.equal(parts[1], "ts-test");
      assert.equal(parts[2], String(fireTime.getTime()));

      await scheduler.stop();
    });

    it("two consecutive fires for the same schedule produce different channelIds", async () => {
      const { scheduler } = makeScheduler([
        { id: "unique-test", name: "Unique channels", cron: "* * * * *", prompt: "go" },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();

      scheduler.tick(new Date(2024, 0, 1, 12, 0, 0));
      scheduler.tick(new Date(2024, 0, 1, 12, 1, 0));

      assert.equal(received.length, 2);
      assert.notEqual(received[0]!.channelId, received[1]!.channelId);

      await scheduler.stop();
    });

    it("includes schedule metadata in raw field", async () => {
      const { scheduler } = makeScheduler([
        {
          id: "meta-test",
          name: "With Target",
          cron: "* * * * *",
          prompt: "report",
          target: { adapterId: "telegram", channelId: "123" },
        },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();
      scheduler.tick(new Date(2024, 0, 1, 12, 0, 0));

      const raw = received[0]!.raw as Record<string, unknown>;
      assert.equal(raw["scheduleId"], "meta-test");
      assert.equal(raw["scheduleName"], "With Target");
      assert.deepEqual(raw["target"], { adapterId: "telegram", channelId: "123" });

      await scheduler.stop();
    });
  });

  describe("send()", () => {
    it("stores results and logs outbound", async () => {
      const { scheduler, logger } = makeScheduler([]);

      await scheduler.send("cron:test-1:1704067200000", { channelId: "cron:test-1:1704067200000", text: "result" });

      const result = scheduler.getLastResult("test-1");
      assert.ok(result);
      assert.equal(result.text, "result");

      const outLog = logger.logs.find(
        (l) => l["eventType"] === "message:outbound" && l["component"] === "scheduler",
      );
      assert.ok(outLog);
    });
  });

  describe("runtime schedule management", () => {
    it("addSchedule() adds a new schedule", async () => {
      const { scheduler, logger } = makeScheduler([]);

      const id = await scheduler.addSchedule({
        name: "Dynamic",
        cron: "*/10 * * * *",
        prompt: "dynamic task",
      });

      assert.ok(id);
      assert.equal(scheduler.getScheduleIds().length, 1);
      assert.equal(scheduler.getSchedule(id)!.name, "Dynamic");

      const addLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "schedule_added",
      );
      assert.ok(addLog);
    });

    it("removeSchedule() removes a schedule", async () => {
      const { scheduler, logger } = makeScheduler([
        { id: "to-remove", name: "Remove me", cron: "* * * * *", prompt: "x" },
      ]);

      assert.equal(await scheduler.removeSchedule("to-remove"), true);
      assert.equal(scheduler.getScheduleIds().length, 0);
      assert.equal(await scheduler.removeSchedule("to-remove"), false); // already gone

      const removeLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "schedule_removed",
      );
      assert.ok(removeLog);
    });

    it("dynamically added schedule fires on next tick", async () => {
      const { scheduler } = makeScheduler([]);
      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();

      await scheduler.addSchedule({
        name: "Dynamic",
        cron: "* * * * *",
        prompt: "dynamic!",
      });

      scheduler.tick(new Date(2024, 0, 1, 12, 0, 0));

      assert.equal(received.length, 1);
      assert.equal(received[0]!.text, "dynamic!");

      await scheduler.stop();
    });
  });

  describe("logging", () => {
    it("logs schedule_fired with provenance", async () => {
      const { scheduler, logger } = makeScheduler([
        { id: "log-test", name: "Log Test", cron: "* * * * *", prompt: "x" },
      ]);

      scheduler.onMessage(() => {});
      await scheduler.start();
      scheduler.tick(new Date(2024, 0, 1, 12, 0, 0));
      await scheduler.stop();

      const fireLog = logger.logs.find(
        (l) => l["eventType"] === "message:inbound" &&
          l["component"] === "scheduler" &&
          (l["payload"] as Record<string, unknown>)["action"] === "schedule_fired",
      );
      assert.ok(fireLog);

      const payload = fireLog["payload"] as Record<string, unknown>;
      assert.equal(payload["scheduleId"], "log-test");
      assert.equal(payload["scheduleName"], "Log Test");
    });

    it("all scheduler events use component 'scheduler'", async () => {
      const { scheduler, logger } = makeScheduler([
        { id: "comp-test", name: "Test", cron: "* * * * *", prompt: "x" },
      ]);

      scheduler.onMessage(() => {});
      await scheduler.start();
      scheduler.tick(new Date(2024, 0, 1, 12, 0, 0));
      await scheduler.stop();

      const schedulerLogs = logger.logs.filter(
        (l) => l["component"] === "scheduler",
      );
      assert.ok(schedulerLogs.length >= 3); // start, fire, stop
    });
  });

  describe("integration: scheduler as ChannelAdapter with router", () => {
    it("scheduled message flows through handleMessage when wired to router", async () => {
      // This test validates the contract: scheduler fires InboundMessage,
      // router calls handleMessage, router calls adapter.send() with result
      const { scheduler } = makeScheduler([
        { id: "integ-1", name: "Integration", cron: "* * * * *", prompt: "What time is it?" },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();
      scheduler.tick(new Date(2024, 0, 1, 9, 0, 0));

      assert.equal(received.length, 1);
      assert.equal(received[0]!.adapterId, "cron");
      assert.equal(received[0]!.text, "What time is it?");

      // Simulate what the router would do: send back a response
      await scheduler.send(received[0]!.channelId, {
        channelId: received[0]!.channelId,
        text: "It is 9:00 AM",
      });

      const result = scheduler.getLastResult("integ-1");
      assert.ok(result);
      assert.equal(result.text, "It is 9:00 AM");

      await scheduler.stop();
    });
  });

  describe("persistence and CRUD", () => {
    it("getAll() returns enabled + disabled schedules", () => {
      const { scheduler } = makeScheduler([
        { id: "enabled-1", name: "Enabled", cron: "* * * * *", prompt: "go" },
        { id: "disabled-1", name: "Disabled", cron: "0 9 * * *", prompt: "nope", enabled: false },
      ]);

      const all = scheduler.getAll();
      assert.equal(all.length, 2);

      const ids = all.map((s) => s.id);
      assert.ok(ids.includes("enabled-1"));
      assert.ok(ids.includes("disabled-1"));

      const disabledSchedule = all.find((s) => s.id === "disabled-1");
      assert.equal(disabledSchedule!.enabled, false);
    });

    it("updateSchedule() merges fields and updates updatedAt", async () => {
      const { scheduler } = makeScheduler([
        { id: "upd-1", name: "Original", cron: "* * * * *", prompt: "orig" },
      ]);

      const original = scheduler.getSchedule("upd-1")!;
      const originalUpdatedAt = original.updatedAt!;

      // Wait a tick to ensure updatedAt changes
      await new Promise((r) => setTimeout(r, 1));

      const updated = await scheduler.updateSchedule("upd-1", { name: "Changed" });

      assert.equal(updated.name, "Changed");
      assert.equal(updated.cron, "* * * * *"); // unchanged
      assert.equal(updated.prompt, "orig"); // unchanged
      assert.ok(updated.updatedAt! > originalUpdatedAt);
    });

    it("updateSchedule() throws SchedulerError on unknown ID", async () => {
      const { scheduler } = makeScheduler([]);

      await assert.rejects(
        () => scheduler.updateSchedule("nonexistent", { name: "nope" }),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes('Schedule "nonexistent" not found'),
      );
    });

    it("updateSchedule() re-parses cron when expression changes", async () => {
      const { scheduler } = makeScheduler([
        { id: "cron-upd", name: "Cron test", cron: "0 12 * * *", prompt: "noon" },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();

      // Original cron matches noon
      scheduler.tick(new Date(2024, 0, 1, 12, 0, 0));
      assert.equal(received.length, 1);

      // Update cron to 9 AM
      await scheduler.updateSchedule("cron-upd", { cron: "0 9 * * *" });

      // Tick at 9 AM, should fire with new cron
      scheduler.tick(new Date(2024, 0, 2, 9, 0, 0));
      assert.equal(received.length, 2);

      // Tick at noon, should NOT fire
      scheduler.tick(new Date(2024, 0, 2, 12, 0, 0));
      assert.equal(received.length, 2);

      await scheduler.stop();
    });

    it("setEnabled() disables a schedule", async () => {
      const { scheduler } = makeScheduler([
        { id: "disable-test", name: "Disable me", cron: "* * * * *", prompt: "fire" },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();

      // Fire before disabling
      scheduler.tick(new Date(2024, 0, 1, 12, 0, 0));
      assert.equal(received.length, 1);

      // Disable
      await scheduler.setEnabled("disable-test", false);

      // Should not fire after disabling
      scheduler.tick(new Date(2024, 0, 1, 12, 1, 0));
      assert.equal(received.length, 1);

      await scheduler.stop();
    });

    it("setEnabled() re-enables a disabled schedule", async () => {
      const { scheduler } = makeScheduler([
        {
          id: "reenable-test",
          name: "Re-enable me",
          cron: "* * * * *",
          prompt: "fire",
          enabled: false,
        },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();

      // Should not fire while disabled
      scheduler.tick(new Date(2024, 0, 1, 12, 0, 0));
      assert.equal(received.length, 0);

      // Re-enable
      await scheduler.setEnabled("reenable-test", true);

      // Should fire after re-enabling
      scheduler.tick(new Date(2024, 0, 1, 12, 1, 0));
      assert.equal(received.length, 1);

      await scheduler.stop();
    });

    it("setAllEnabled(false) disables all schedules", async () => {
      const { scheduler } = makeScheduler([
        { id: "s1", name: "First", cron: "* * * * *", prompt: "one" },
        { id: "s2", name: "Second", cron: "* * * * *", prompt: "two" },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();

      // Both fire initially
      scheduler.tick(new Date(2024, 0, 1, 12, 0, 0));
      assert.equal(received.length, 2);

      // Disable all
      await scheduler.setAllEnabled(false);

      // None should fire
      scheduler.tick(new Date(2024, 0, 1, 12, 1, 0));
      assert.equal(received.length, 2);

      await scheduler.stop();
    });

    it("setAllEnabled(true) enables all schedules", async () => {
      const { scheduler } = makeScheduler([
        {
          id: "d1",
          name: "Disabled 1",
          cron: "* * * * *",
          prompt: "one",
          enabled: false,
        },
        {
          id: "d2",
          name: "Disabled 2",
          cron: "* * * * *",
          prompt: "two",
          enabled: false,
        },
      ]);

      const received: InboundMessage[] = [];
      scheduler.onMessage((msg) => received.push(msg));

      await scheduler.start();

      // Should not fire while disabled
      scheduler.tick(new Date(2024, 0, 1, 12, 0, 0));
      assert.equal(received.length, 0);

      // Enable all
      await scheduler.setAllEnabled(true);

      // Both should fire now
      scheduler.tick(new Date(2024, 0, 1, 12, 1, 0));
      assert.equal(received.length, 2);

      await scheduler.stop();
    });

    it("nextId() auto-increments", async () => {
      const { scheduler } = makeScheduler([]);

      const id1 = await scheduler.addSchedule({
        name: "First",
        cron: "* * * * *",
        prompt: "1",
      });
      assert.equal(id1, "1");

      const id2 = await scheduler.addSchedule({
        name: "Second",
        cron: "* * * * *",
        prompt: "2",
      });
      assert.equal(id2, "2");

      const id3 = await scheduler.addSchedule({
        name: "Third",
        cron: "* * * * *",
        prompt: "3",
      });
      assert.equal(id3, "3");
    });

    it("nextId() handles gaps in IDs", async () => {
      // Create a scheduler with non-sequential IDs
      const { scheduler } = makeScheduler([
        { id: "1", name: "First", cron: "* * * * *", prompt: "x" },
        { id: "5", name: "Fifth", cron: "* * * * *", prompt: "x" },
      ]);

      const newId = await scheduler.addSchedule({
        name: "Next",
        cron: "* * * * *",
        prompt: "x",
      });

      // Should be max + 1
      assert.equal(newId, "6");
    });

    it("persist() is called on addSchedule", async () => {
      const saved: Array<{ config: Record<string, unknown>; path?: string }> = [];
      const mockSave = async (config: Record<string, unknown>, path?: string) => {
        saved.push({ config, path });
      };
      const rawConfig = {};

      const { scheduler } = makeScheduler([], {
        saveConfig: mockSave,
        rawConfig,
        configPath: "/fake/path",
      });

      await scheduler.addSchedule({
        name: "Persist test",
        cron: "* * * * *",
        prompt: "test",
      });

      assert.equal(saved.length, 1);
      assert.ok(saved[0]!.config);
    });

    it("persist() is called on updateSchedule", async () => {
      const saved: Array<{ config: Record<string, unknown>; path?: string }> = [];
      const mockSave = async (config: Record<string, unknown>, path?: string) => {
        saved.push({ config, path });
      };
      const rawConfig = {};

      const { scheduler } = makeScheduler([
        { id: "upd-test", name: "Update", cron: "* * * * *", prompt: "x" },
      ], { saveConfig: mockSave, rawConfig });

      await scheduler.updateSchedule("upd-test", { name: "Updated" });

      assert.equal(saved.length, 1);
    });

    it("persist() is called on setEnabled", async () => {
      const saved: Array<{ config: Record<string, unknown>; path?: string }> = [];
      const mockSave = async (config: Record<string, unknown>, path?: string) => {
        saved.push({ config, path });
      };
      const rawConfig = {};

      const { scheduler } = makeScheduler([
        { id: "en-test", name: "Enable test", cron: "* * * * *", prompt: "x" },
      ], { saveConfig: mockSave, rawConfig });

      await scheduler.setEnabled("en-test", false);

      assert.equal(saved.length, 1);
    });

    it("persist() is called on setAllEnabled", async () => {
      const saved: Array<{ config: Record<string, unknown>; path?: string }> = [];
      const mockSave = async (config: Record<string, unknown>, path?: string) => {
        saved.push({ config, path });
      };
      const rawConfig = {};

      const { scheduler } = makeScheduler([
        { id: "a1", name: "All 1", cron: "* * * * *", prompt: "x" },
        { id: "a2", name: "All 2", cron: "* * * * *", prompt: "x" },
      ], { saveConfig: mockSave, rawConfig });

      await scheduler.setAllEnabled(false);

      assert.equal(saved.length, 1);
    });

    it("persist() is called on removeSchedule", async () => {
      const saved: Array<{ config: Record<string, unknown>; path?: string }> = [];
      const mockSave = async (config: Record<string, unknown>, path?: string) => {
        saved.push({ config, path });
      };
      const rawConfig = {};

      const { scheduler } = makeScheduler([
        { id: "rm-test", name: "Remove test", cron: "* * * * *", prompt: "x" },
      ], { saveConfig: mockSave, rawConfig });

      await scheduler.removeSchedule("rm-test");

      assert.equal(saved.length, 1);
    });

    it("persist() writes correct data to rawConfig.schedules", async () => {
      let savedConfig: Record<string, unknown> | null = null;
      const mockSave = async (config: Record<string, unknown>) => {
        savedConfig = config;
      };
      const rawConfig = {};

      const { scheduler } = makeScheduler([
        {
          id: "persist-data",
          name: "Data test",
          cron: "0 9 * * *",
          prompt: "test prompt",
          target: { adapterId: "telegram", channelId: "123" },
        },
      ], { saveConfig: mockSave, rawConfig });

      await scheduler.addSchedule({
        name: "Added schedule",
        cron: "*/5 * * * *",
        prompt: "added",
      });

      assert.ok(savedConfig);
      const schedules = savedConfig["schedules"] as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(schedules));
      assert.equal(schedules.length, 2);

      // Check the original schedule is preserved
      const original = schedules.find((s) => s.id === "persist-data");
      assert.ok(original);
      assert.equal(original!.name, "Data test");
      assert.equal(original!.cron, "0 9 * * *");
      assert.deepEqual(original!.target, { adapterId: "telegram", channelId: "123" });

      // Check the added schedule
      const added = schedules.find((s) => s.name === "Added schedule");
      assert.ok(added);
      assert.equal(added!.cron, "*/5 * * * *");
    });

    it("constructor preserves disabled schedules in getAll()", () => {
      const { scheduler } = makeScheduler([
        { id: "enabled", name: "Enabled", cron: "* * * * *", prompt: "x" },
        {
          id: "disabled",
          name: "Disabled",
          cron: "* * * * *",
          prompt: "x",
          enabled: false,
        },
      ]);

      const all = scheduler.getAll();
      assert.equal(all.length, 2);

      const allIds = all.map((s) => s.id);
      assert.ok(allIds.includes("disabled"));
    });

    it("constructor does not include disabled schedules in getScheduleIds()", () => {
      const { scheduler } = makeScheduler([
        { id: "enabled", name: "Enabled", cron: "* * * * *", prompt: "x" },
        {
          id: "disabled",
          name: "Disabled",
          cron: "* * * * *",
          prompt: "x",
          enabled: false,
        },
      ]);

      const ids = scheduler.getScheduleIds();
      assert.equal(ids.length, 1);
      assert.ok(ids.includes("enabled"));
      assert.ok(!ids.includes("disabled"));
    });
  });
});
