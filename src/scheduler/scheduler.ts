import {
  BetterClawsError,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage,
} from "../types.js";
import type { StructuredLogger } from "../logger/structured-logger.js";
import { parseCron, cronMatches, nextMatch, type CronExpression } from "./cron-parser.js";

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
  /** Epoch ms when this schedule was created. */
  readonly createdAt?: number;
  /** Epoch ms when this schedule was last updated. */
  readonly updatedAt?: number;
}

/** Runtime state for a schedule (enabled or disabled). */
interface StoredSchedule {
  definition: ScheduleDefinition;
  readonly id: string;
  cronExpr: CronExpression | null;
  lastFired: number | null;
}

// ── Scheduler (also acts as a ChannelAdapter) ───────────────────────────────

export interface SchedulerOptions {
  readonly schedules: readonly ScheduleDefinition[];
  readonly logger: StructuredLogger;
  /** Tick interval in ms. How often the scheduler checks for due jobs. Default: 30000 (30s). */
  readonly tickIntervalMs?: number;
  /** Path to the config file for persistence. */
  readonly configPath?: string;
  /** Raw config object (with env: references intact) for persistence. */
  readonly rawConfig?: Record<string, unknown>;
  /** Callback to save config to disk. */
  readonly saveConfig?: (config: Record<string, unknown>, path?: string) => Promise<void>;
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
  private readonly allSchedules = new Map<string, StoredSchedule>();

  private readonly configPath?: string;
  private readonly rawConfig?: Record<string, unknown>;
  private readonly saveConfigFn?: (config: Record<string, unknown>, path?: string) => Promise<void>;

  private callback: ((msg: InboundMessage) => void) | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastResults = new Map<string, OutboundMessage>();

  constructor(options: SchedulerOptions) {
    this.logger = options.logger;
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000;
    this.configPath = options.configPath;
    this.rawConfig = options.rawConfig;
    this.saveConfigFn = options.saveConfig;

    for (const def of options.schedules) {
      const id = def.id ?? this.nextId();
      const now = Date.now();
      const definition: ScheduleDefinition = {
        ...def,
        id,
        enabled: def.enabled !== false,
        createdAt: def.createdAt ?? now,
        updatedAt: def.updatedAt ?? now,
      };

      let cronExpr: CronExpression | null = null;
      if (definition.enabled !== false) {
        cronExpr = parseCron(def.cron);
      }

      this.allSchedules.set(id, {
        definition,
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

    const enabledCount = Array.from(this.allSchedules.values()).filter(
      (s) => s.definition.enabled !== false,
    ).length;

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "scheduler",
      payload: {
        action: "start",
        scheduleCount: enabledCount,
        totalCount: this.allSchedules.size,
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

  /** Get all enabled schedule IDs. */
  getScheduleIds(): readonly string[] {
    const ids: string[] = [];
    for (const [id, s] of this.allSchedules) {
      if (s.definition.enabled !== false) ids.push(id);
    }
    return ids;
  }

  /** Get a schedule's definition by ID. */
  getSchedule(id: string): ScheduleDefinition | undefined {
    return this.allSchedules.get(id)?.definition;
  }

  /** Get all schedule definitions (enabled and disabled). */
  getAll(): readonly ScheduleDefinition[] {
    return Array.from(this.allSchedules.values()).map((s) => s.definition);
  }

  /** Get the next fire time for a schedule. */
  getNextFireTime(id: string): Date | null {
    const stored = this.allSchedules.get(id);
    if (!stored?.cronExpr) return null;
    return nextMatch(stored.cronExpr);
  }

  /** Add a schedule at runtime. Returns the schedule ID. */
  async addSchedule(
    def: Omit<ScheduleDefinition, "id" | "createdAt" | "updatedAt">,
  ): Promise<string> {
    const id = this.nextId();
    const now = Date.now();
    const cronExpr = parseCron(def.cron);

    const definition: ScheduleDefinition = {
      ...def,
      id,
      enabled: def.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };

    this.allSchedules.set(id, {
      definition,
      id,
      cronExpr: definition.enabled !== false ? cronExpr : null,
      lastFired: null,
    });

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "scheduler",
      payload: { action: "schedule_added", id, name: def.name, cron: def.cron },
    });

    await this.persist();
    return id;
  }

  /** Update a schedule's fields. Returns the updated definition. */
  async updateSchedule(
    id: string,
    partial: Partial<Pick<ScheduleDefinition, "name" | "cron" | "prompt" | "enabled">>,
  ): Promise<ScheduleDefinition> {
    const stored = this.allSchedules.get(id);
    if (!stored) {
      throw new SchedulerError(`Schedule "${id}" not found`, "SCHEDULE_NOT_FOUND");
    }

    const prev = stored.definition;
    const now = Date.now();
    const definition: ScheduleDefinition = {
      ...prev,
      ...(partial.name !== undefined ? { name: partial.name } : {}),
      ...(partial.cron !== undefined ? { cron: partial.cron } : {}),
      ...(partial.prompt !== undefined ? { prompt: partial.prompt } : {}),
      ...(partial.enabled !== undefined ? { enabled: partial.enabled } : {}),
      updatedAt: now,
    };

    // Re-parse cron if the expression or enabled state changed
    const cronChanged = partial.cron !== undefined && partial.cron !== prev.cron;
    const enabledChanged = partial.enabled !== undefined && partial.enabled !== (prev.enabled !== false);

    if (cronChanged && definition.enabled !== false) {
      stored.cronExpr = parseCron(definition.cron);
    } else if (enabledChanged) {
      stored.cronExpr = definition.enabled !== false ? parseCron(definition.cron) : null;
    }

    stored.definition = definition;

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "scheduler",
      payload: { action: "schedule_updated", id, fields: Object.keys(partial) },
    });

    await this.persist();
    return definition;
  }

  /** Enable or disable a schedule. */
  async setEnabled(id: string, enabled: boolean): Promise<ScheduleDefinition> {
    return this.updateSchedule(id, { enabled });
  }

  /** Enable or disable all schedules. */
  async setAllEnabled(enabled: boolean): Promise<void> {
    for (const [, stored] of this.allSchedules) {
      const prev = stored.definition;
      const now = Date.now();
      stored.definition = { ...prev, enabled, updatedAt: now };
      stored.cronExpr = enabled ? parseCron(stored.definition.cron) : null;
    }

    this.logger.log({
      sessionId: null,
      eventType: "config:change",
      component: "scheduler",
      payload: { action: "schedule_bulk_update", enabled, count: this.allSchedules.size },
    });

    await this.persist();
  }

  /** Remove a schedule at runtime. */
  async removeSchedule(id: string): Promise<boolean> {
    const removed = this.allSchedules.delete(id);
    if (removed) {
      this.logger.log({
        sessionId: null,
        eventType: "config:change",
        component: "scheduler",
        payload: { action: "schedule_removed", id },
      });
      await this.persist();
    }
    return removed;
  }

  // ── Tick loop ─────────────────────────────────────────────────────────────

  /** Check all schedules and fire any that are due. Exposed for testing. */
  tick(now: Date = new Date()): void {
    if (!this.running) return;

    for (const [, schedule] of this.allSchedules) {
      if (!schedule.cronExpr) continue;

      if (!cronMatches(schedule.cronExpr, now)) continue;

      // Prevent double-firing within the same minute
      const minuteKey = Math.floor(now.getTime() / 60_000);
      if (schedule.lastFired !== null && schedule.lastFired === minuteKey) continue;

      schedule.lastFired = minuteKey;
      this.fireSchedule(schedule, now);
    }
  }

  private fireSchedule(schedule: StoredSchedule, now: Date): void {
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

  // ── Persistence ───────────────────────────────────────────────────────────

  private nextId(): string {
    let max = 0;
    for (const id of this.allSchedules.keys()) {
      const n = parseInt(id, 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
    return String(max + 1);
  }

  private async persist(): Promise<void> {
    if (!this.saveConfigFn || !this.rawConfig) return;

    const schedules = Array.from(this.allSchedules.values()).map((s) => ({
      id: s.definition.id,
      name: s.definition.name,
      cron: s.definition.cron,
      prompt: s.definition.prompt,
      ...(s.definition.target ? { target: s.definition.target } : {}),
      enabled: s.definition.enabled !== false,
      createdAt: s.definition.createdAt,
      updatedAt: s.definition.updatedAt,
    }));

    this.rawConfig["schedules"] = schedules;
    await this.saveConfigFn(this.rawConfig, this.configPath);
  }
}
