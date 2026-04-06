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
  overrides?: { tickIntervalMs?: number; logger?: ReturnType<typeof createMockLogger> },
) {
  const logger = overrides?.logger ?? createMockLogger();
  const scheduler = new Scheduler({
    schedules,
    logger,
    tickIntervalMs: overrides?.tickIntervalMs ?? 50,
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
      assert.equal(received[0]!.channelId, "cron:test-1");
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

      await scheduler.send("cron:test-1", { channelId: "cron:test-1", text: "result" });

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

      const id = scheduler.addSchedule({
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

      assert.equal(scheduler.removeSchedule("to-remove"), true);
      assert.equal(scheduler.getScheduleIds().length, 0);
      assert.equal(scheduler.removeSchedule("to-remove"), false); // already gone

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

      scheduler.addSchedule({
        id: "dynamic-1",
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
});
