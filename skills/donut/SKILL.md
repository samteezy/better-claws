---
name: donut
description: Memory-gathering interview — assess what you know about the user, identify gaps and stale knowledge, gather new information through conversation, and commit durable facts to long-term memory. Works whether you know nothing or quite a lot.
allowed-tools: memory
---

# Donut — Memory-Gathering Interview

This skill guides you through a principled memory-gathering conversation. The process is adaptive — it should feel different depending on whether you're meeting this person for the first time or checking in after working together for months. The underlying principles are the same either way.

---

## Phase 1: Assess What You Know

Before asking a single question, take stock of your current knowledge. Search across all major domains:

```
memory { action: "search", query: "user name role timezone organization" }
memory { action: "search", query: "projects tools languages frameworks stack" }
memory { action: "search", query: "preferences communication style tone confirmation" }
memory { action: "search", query: "goals recurring tasks standing instructions" }
```

For each result, note:
- **Recency** — when was this last confirmed? A fact from a recent session is more reliable than one from months ago.
- **Specificity** — is this a precise, actionable fact ("prefers bullet points over prose") or a vague generalization that may not hold?
- **Coverage** — which domains have good coverage? Which are sparse or empty?

Frame your opening based on what you found:
- **Nothing or very little known**: Open warmly — "Let's take a few minutes so I can get to know you." Then explore broadly.
- **Moderate knowledge**: Acknowledge what you know — "I know a bit about you from our past sessions. Let me check in and fill in the gaps."
- **Substantial knowledge**: Frame it as a refresh — "I already have quite a bit on file about you. Let's make sure everything's still accurate and see if there's anything new worth adding."

---

## Phase 2: Interview Principles

The interview is a conversation, not a form. Guide it using these principles:

### Ask for what you don't know first

Start with the domains where your knowledge is thinnest. If you have no record of their role or work context, begin there. If preferences are well-documented but goals are sparse, focus on goals. Don't re-ask things that are already accurate just to fill time.

### Group related questions naturally

Ask 2–3 related questions in a single message — enough to explore a topic without overwhelming. After they respond, briefly reflect what you heard before moving to the next area.

### Surface conflicts explicitly

When new information contradicts something already on file, say so rather than silently overwriting. Examples:

> "I seem to have you down as primarily a Python developer — has that changed, or is there something else I'm missing?"

> "My notes say you prefer I ask before executing tasks, but you just told me to just go ahead. Should I update that?"

Wait for confirmation before updating a conflicting memory. The user may clarify context ("that's for code changes, not file reads"), confirm a change ("yeah I've shifted on that"), or tell you the old record was simply wrong. Adjust accordingly.

### Probe for durability before you commit

Not everything worth discussing belongs in memory. Before writing, ask:

- **Is this stable?** Will this still be true next week, or is it specific to a current task?
- **Is this actionable?** Will knowing this actually change how I behave in future sessions?
- **Is this specific enough?** Vague generalities ("they like efficiency") aren't useful. Concrete, specific facts are.

If something is task-specific or ephemeral, don't commit it. If it's useful but uncertain, commit it with a note of that uncertainty in the content.

### Domains to cover

Cover these areas over the course of the conversation — not necessarily in order, and not necessarily all of them if they're already well-documented:

- **Identity**: name/how to address them, role, organization, timezone
- **Work context**: active projects, languages/frameworks/tools, repos or systems that come up regularly
- **Communication preferences**: verbosity, tone/formality, confirmation behavior, things that frustrate them about AI
- **Goals and standing instructions**: what they want to use BC for, recurring tasks to handle consistently, things they always want BC to remember

### Depth over breadth

It's better to understand a few things well than to collect shallow answers across every domain. If the user gives a rich answer about their work context, explore it with a follow-up. If they give a terse answer about preferences, accept it and move on.

---

## Phase 3: Commit to Memory

Commit as you go — don't wait until the end. If the session ends early, partial information is better than none.

Use `action: "set"` for all writes.

### Key naming convention

Use dotted namespaced keys for consistency and deduplication:

| Domain | Example keys |
|--------|-------------|
| Identity | `user.name`, `user.role`, `user.timezone`, `user.org` |
| Work context | `work.projects`, `work.stack`, `work.repos` |
| Preferences | `pref.verbosity`, `pref.formality`, `pref.confirmation`, `pref.frustrations` |
| Goals | `goal.primary`, `goal.recurring`, `goal.always-remember` |

For nuanced answers that don't fit a standard key cleanly, use a descriptive key with prose content (e.g., `pref.communication-style`, `work.context`). One rich entry is better than three thin ones.

### Category selection

| Domain | `category` |
|--------|-----------|
| Identity, work context | `fact` |
| Preferences | `correction` |
| Goals, standing instructions | `goal` |

### Deduplication

Calling `set` with an existing key updates the long-term entry in place rather than creating a duplicate. Prefer updating existing keys over inventing new ones for the same concept.

### Updating after a conflict

When you confirm that an existing memory needs to change, call `set` with the same key and the new content. If the situation is nuanced, encode that nuance in the content itself:

```
memory { action: "set", key: "pref.confirmation", category: "correction",
  content: "Execute autonomously for file operations and search. Always confirm before running shell commands or making commits." }
```

### Don't commit

- Current task context (e.g., "working on auth refactor this week")
- Things the user said are situational, not ongoing preferences
- Anything the user explicitly said they don't want remembered

---

## Phase 4: Close

After the conversation reaches a natural end:

1. Briefly summarize what you've updated — memories created, revised, or confirmed. Keep it to 3–5 items.
2. Call out any conflicts you resolved and how you resolved them.
3. Let them know they can run this again any time to refresh their profile.
4. Optionally suggest one concrete next step based on what you learned (e.g., setting up a recurring schedule, updating the system persona).
