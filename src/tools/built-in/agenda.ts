import { toErrorMessage } from "../../utils/errors.js";
import { missingParamResult } from "./tool-helpers.js";
import type { AgendaStore } from "../../memory/agenda-store.js";
import type {
  AgendaItemType,
  AgendaItemStatus,
  ToolDescriptor,
  ToolHandler,
  ExecutionContext,
  ToolResult,
} from "../../types.js";

/** Singleton AgendaStore, set by bootstrap. */
export let agendaStoreInstance: AgendaStore | null = null;

export function setAgendaStore(store: AgendaStore): void {
  agendaStoreInstance = store;
}

/**
 * Maps sessionId → senderId so the tool can scope items to the right user.
 * Populated by MessageRouter when messages arrive.
 */
export const sessionSenderRegistry = new Map<string, string>();

export function registerSessionSender(sessionId: string, senderId: string): void {
  sessionSenderRegistry.set(sessionId, senderId);
}

const ITEM_TYPES: readonly AgendaItemType[] = ["follow-up", "user-clarification", "capability-gap", "general"];
const ITEM_STATUSES: readonly AgendaItemStatus[] = ["pending", "raised", "snoozed", "resolved"];
const PRIORITIES = ["low", "normal", "high"] as const;

export const descriptor: ToolDescriptor = {
  name: "agenda",
  description:
    "Manage your personal agenda — a list of items you want to raise with the user in a future interaction. Use 'add' when you notice something that needs follow-up, needs clarification, or reveals a capability gap. Use 'list' to review pending items. Use 'resolve' when an item has been addressed. Use 'snooze' to defer an item. Use 'update' to edit an item.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "resolve", "snooze", "update"],
        description: "The operation to perform.",
      },
      id: {
        type: "string",
        description: "Item ID. Required for 'resolve', 'snooze', and 'update'.",
      },
      content: {
        type: "string",
        description: "What you want to raise with the user. Required for 'add'. Optional for 'update'.",
      },
      type: {
        type: "string",
        enum: ITEM_TYPES,
        description: "Category of the item. Required for 'add'.",
      },
      priority: {
        type: "string",
        enum: PRIORITIES,
        description: "Priority level. Default: 'normal'.",
      },
      context: {
        type: "string",
        description: "Brief note about why you are adding this item. Optional for 'add'.",
      },
      status: {
        type: "string",
        enum: ITEM_STATUSES,
        description: "Filter by status. Optional for 'list'. Defaults to showing pending and raised items.",
      },
      snoozeMinutes: {
        type: "number",
        description: "Minutes to snooze the item. Required for 'snooze'.",
      },
    },
    required: ["action"],
  },
  capabilities: [],
};

export const handler: ToolHandler = {
  async execute(
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const start = Date.now();
    const action = params["action"] as string;

    if (!agendaStoreInstance) {
      return { success: false, output: null, error: "Agenda store is not available", durationMs: Date.now() - start };
    }

    const senderId = sessionSenderRegistry.get(context.sessionId);
    if (!senderId) {
      return { success: false, output: null, error: "Could not resolve sender for this session", durationMs: Date.now() - start };
    }

    try {
      switch (action) {
        case "add": {
          const content = params["content"] as string | undefined;
          const type = params["type"] as AgendaItemType | undefined;
          if (!content || !type) {
            return { success: false, output: null, error: "Action 'add' requires 'content' and 'type'", durationMs: Date.now() - start };
          }
          if (!ITEM_TYPES.includes(type)) {
            return { success: false, output: null, error: `Invalid type. Must be one of: ${ITEM_TYPES.join(", ")}`, durationMs: Date.now() - start };
          }
          const priority = (params["priority"] as (typeof PRIORITIES)[number] | undefined) ?? "normal";
          const itemContext = params["context"] as string | undefined;
          const id = await agendaStoreInstance.add({
            senderId,
            type,
            content,
            status: "pending",
            priority,
            context: itemContext,
            sourceSessionId: context.sessionId,
          });
          return { success: true, output: { action: "add", id, content, type, priority }, durationMs: Date.now() - start };
        }

        case "list": {
          const statusFilter = params["status"] as AgendaItemStatus | undefined;
          const items = statusFilter
            ? agendaStoreInstance.listAll(senderId).filter((i) => i.status === statusFilter)
            : agendaStoreInstance.listPending(senderId);
          return {
            success: true,
            output: {
              action: "list",
              count: items.length,
              items: items.map((i) => ({
                id: i.id,
                type: i.type,
                priority: i.priority,
                status: i.status,
                content: i.content,
                context: i.context,
                addedAt: new Date(i.addedAt).toISOString(),
                lastRaisedAt: i.lastRaisedAt ? new Date(i.lastRaisedAt).toISOString() : undefined,
              })),
            },
            durationMs: Date.now() - start,
          };
        }

        case "resolve": {
          const id = params["id"] as string | undefined;
          if (!id) return missingParamResult("id", start);
          const item = await agendaStoreInstance.resolve(id);
          return { success: true, output: { action: "resolve", id, content: item.content }, durationMs: Date.now() - start };
        }

        case "snooze": {
          const id = params["id"] as string | undefined;
          const minutes = params["snoozeMinutes"] as number | undefined;
          if (!id) return missingParamResult("id", start);
          if (minutes === undefined) return missingParamResult("snoozeMinutes", start);
          const untilMs = Date.now() + minutes * 60_000;
          const item = await agendaStoreInstance.snooze(id, untilMs);
          return {
            success: true,
            output: { action: "snooze", id, content: item.content, snoozeUntil: new Date(untilMs).toISOString() },
            durationMs: Date.now() - start,
          };
        }

        case "update": {
          const id = params["id"] as string | undefined;
          if (!id) return missingParamResult("id", start);
          const newContent = params["content"] as string | undefined;
          const newPriority = params["priority"] as (typeof PRIORITIES)[number] | undefined;
          if (newContent === undefined && newPriority === undefined) {
            return { success: false, output: null, error: "Action 'update' requires at least one of 'content' or 'priority'", durationMs: Date.now() - start };
          }
          const patch: { content?: string; priority?: "low" | "normal" | "high" } = {};
          if (newContent !== undefined) patch.content = newContent;
          if (newPriority !== undefined) patch.priority = newPriority;
          const updated = await agendaStoreInstance.update(id, patch);
          return { success: true, output: { action: "update", id, content: updated.content, priority: updated.priority }, durationMs: Date.now() - start };
        }

        default:
          return { success: false, output: null, error: `Unknown action: "${action}". Valid: add, list, resolve, snooze, update`, durationMs: Date.now() - start };
      }
    } catch (err) {
      return { success: false, output: null, error: toErrorMessage(err), durationMs: Date.now() - start };
    }
  },
};
