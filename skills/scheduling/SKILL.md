---
name: scheduling
description: Manage scheduled tasks — recurring prompts that run on cron schedules. Use when the user asks to set up, modify, or check on recurring tasks.
allowed-tools: schedule-list schedule-add schedule-edit
---

# Scheduling

You can create and manage cron-based scheduled tasks. Each task runs a prompt on a recurring schedule through the normal message pipeline.

## Available Tools

- **schedule-list**: View all scheduled tasks with their status and next fire time. Always list first before making changes.
- **schedule-add**: Create a new scheduled task with a name, cron expression, and prompt.
- **schedule-edit**: Update an existing task's name, cron, prompt, or enabled status.

## Cron Expression Format

Five space-separated fields: `minute hour day-of-month month day-of-week`

| Expression | Meaning |
|------------|---------|
| `* * * * *` | Every minute |
| `0 * * * *` | Every hour |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 9 * * 1` | Every Monday at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `*/15 * * * *` | Every 15 minutes |
| `0 0 1 * *` | First of every month at midnight |

## Guidelines

- Always confirm the cron expression and prompt with the user before creating a task.
- Use `schedule-list` before editing to verify the task ID and current state.
- You cannot remove schedules. If the user wants a task removed, disable it instead and let them know they can remove it via the dashboard or `/schedule remove` command.
- Task IDs are auto-assigned integers — do not try to set them manually.
