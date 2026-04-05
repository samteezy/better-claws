import { randomUUID } from "node:crypto";
import {
  BetterClawsError,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import { parseCron, cronMatches, type CronExpression } from "./cron-parser.js";

export class SchedulerError extends BetterClawsError {
  constructor(message: string, code: string = "SCHEDULER_ERROR") {
    super(message, "scheduler", code);
    this.name = "SchedulerError";
  }
}

// ── Schedule definition ─────────────────────────────────────────────────────

export interface ScheduleDefinition {
  /** Unique identifier for this schedule. Auto-generated if not provided. */
  readonly id?: string;
  /** Human-readable name for logging/display. */
  readonly name: string;
  /** Cron expression (5-field: minute hour dom month dow). */
  readonly cron: string;
  /** The message text to inject into the pipeline when the schedule fires. */
  readonly prompt: string;
  /** Target adapter + channel for sending results. */
  readonly target?: {
    readonly adapterId: string;
    readonly channelId: string;
  };
  /** Whether this schedule is enabled. Default: true. */
  readonly enabled?: boolean;
}

/** Runtime state for an active schedule. */
interface ActiveSchedule {
  readonly definition: ScheduleDefinition;
  readonly id: string;
  readonly cronExpr: CronExpression;
  lastFired: number | null;
}

// ── Scheduler (also acts as a ChannelAdapter) ───────────────────────────────

export interface SchedulerOptions {
  readonly schedules: readonly ScheduleDefinition[];
  readonly logger: StructuredLogger;
  /** Tick interval in ms. How often the scheduler checks for due jobs. Default: 30000 (30s). */
  readonly tickIntervalMs?: number;
}

/**
 * Cron-based scheduler that implements ChannelAdapter.
 * When registered with the MessageRouter, scheduled tasks flow through
 * the same pipeline as user messages — including capability gate enforcement.
 *
 * The scheduler fires synthetic InboundMessages with `adapterId: "cron"`
 * at the times specified by each schedule's cron expression.
 */
export class Scheduler implements ChannelAdapter {
  readonly id = "cron";
  readonly name = "Cron Scheduler";

  private readonly logger: StructuredLogger;
  private readonly tickIntervalMs: number;
  private readonly activeSchedules = new Map<string, ActiveSchedule>();

  private callback: ((msg: InboundMessage) => void) | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastResults = new Map<string, OutboundMessage>();

  constructor(options: SchedulerOptions) {
    this.logger = options.logger;
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000;

    for (const def of options.schedules) {
      if (def.enabled === false) continue;

      const id = def.id ?? randomUUID();
      const cronExpr = parseCron(def.cron);

      this.activeSchedules.set(id, {
        definition: def,
        id,
        cronExpr,
        lastFired: null,
      });
    }
  }

  async start(): Promise<void> {
    this.running = true;

    this.tickTimer = setInterval(() => {
      this.tick();
    }, this.tickIntervalMs);

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "scheduler",
      payload: {
        action: "start",
        scheduleCount: this.activeSchedules.size,
        tickIntervalMs: this.tickIntervalMs,
      },
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "scheduler",
      payload: { action: "stop" },
    });
  }

  onMessage(callback: (msg: InboundMessage) => void): void {
    this.callback = callback;
  }

  async send(channelId: string, message: OutboundMessage): Promise<void> {
    // Store the result — can be forwarded to a target adapter by the router
    this.lastResults.set(channelId, message);

    this.logger.log({
      sessionId: null,
      eventType: "message:outbound",
      component: "scheduler",
      payload: {
        channelId,
        textLength: message.text.length,
      },
    });
  }

  /** Get the last result for a schedule channel. Useful for testing. */
  getLastResult(scheduleId: string): OutboundMessage | undefined {
    return this.lastResults.get(`cron:${scheduleId}`);
  }

  /** Get all active schedule IDs. */
  getScheduleIds(): readonly string[] {
    return Array.from(this.activeSchedules.keys());
  }

  /** Get a schedule's definition by ID. */
  getSchedule(id: string): ScheduleDefinition | undefined {
    return this.activeSchedules.get(id)?.definition;
  }

  /** Add a schedule at runtime. Returns the schedule ID. */
  addSchedule(def: ScheduleDefinition): string {
    const id = def.id ?? randomUUID();
    const cronExpr = parseCron(def.cron);

    this.activeSchedules.set(id, {
      definition: def,
      id,
      cronExpr,
      lastFired: null,
    });

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "scheduler",
      payload: { action: "schedule_added", id, name: def.name, cron: def.cron },
    });

    return id;
  }

  /** Remove a schedule at runtime. */
  removeSchedule(id: string): boolean {
    const removed = this.activeSchedules.delete(id);
    if (removed) {
      this.logger.log({
        sessionId: null,
        eventType: "config:change",
        component: "scheduler",
        payload: { action: "schedule_removed", id },
      });
    }
    return removed;
  }

  // ── Tick loop ─────────────────────────────────────────────────────────────

  /** Check all schedules and fire any that are due. Exposed for testing. */
  tick(now: Date = new Date()): void {
    if (!this.running) return;

    for (const [, schedule] of this.activeSchedules) {
      if (!cronMatches(schedule.cronExpr, now)) continue;

      // Prevent double-firing within the same minute
      const minuteKey = Math.floor(now.getTime() / 60_000);
      if (schedule.lastFired !== null && schedule.lastFired === minuteKey) continue;

      schedule.lastFired = minuteKey;
      this.fireSchedule(schedule, now);
    }
  }

  private fireSchedule(schedule: ActiveSchedule, now: Date): void {
    const channelId = `cron:${schedule.id}`;

    const message: InboundMessage = {
      id: `${schedule.id}-${now.getTime()}`,
      adapterId: "cron",
      channelId,
      senderId: "scheduler",
      text: schedule.definition.prompt,
      timestamp: now.getTime(),
      raw: {
        scheduleId: schedule.id,
        scheduleName: schedule.definition.name,
        cron: schedule.definition.cron,
        target: schedule.definition.target,
      },
    };

    this.logger.log({
      sessionId: null,
      eventType: "message:inbound",
      component: "scheduler",
      payload: {
        action: "schedule_fired",
        scheduleId: schedule.id,
        scheduleName: schedule.definition.name,
        cron: schedule.definition.cron,
      },
    });

    this.callback?.(message);
  }
}
