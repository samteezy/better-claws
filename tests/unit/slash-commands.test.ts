import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SLASH_COMMANDS, MessageRouter, type SlashCommandDescriptor } from "../../src/router/message-router.js";

describe("SLASH_COMMANDS registry", () => {
  it("exports an array of slash command descriptors", () => {
    assert(Array.isArray(SLASH_COMMANDS), "SLASH_COMMANDS should be an array");
    assert(SLASH_COMMANDS.length > 0, "SLASH_COMMANDS should not be empty");
  });

  it("contains /new command with description and no args", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/new");
    assert(cmd !== undefined, "/new command should exist");
    assert.strictEqual(cmd.name, "/new");
    assert.strictEqual(cmd.description, "Archive the current session and start fresh");
    assert.strictEqual(cmd.args, undefined);
  });

  it("contains /reset command with description and no args", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/reset");
    assert(cmd !== undefined, "/reset command should exist");
    assert.strictEqual(cmd.name, "/reset");
    assert.strictEqual(cmd.description, "Wipe the current session entirely");
    assert.strictEqual(cmd.args, undefined);
  });

  it("contains /fork command with description and [sessionId] args", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/fork");
    assert(cmd !== undefined, "/fork command should exist");
    assert.strictEqual(cmd.name, "/fork");
    assert.strictEqual(cmd.description, "Fork the current (or a specific) session");
    assert.strictEqual(cmd.args, "[sessionId]");
  });

  it("contains /sessions command with description and no args", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/sessions");
    assert(cmd !== undefined, "/sessions command should exist");
    assert.strictEqual(cmd.name, "/sessions");
    assert.strictEqual(cmd.description, "List all sessions for your account");
    assert.strictEqual(cmd.args, undefined);
  });

  it("contains /schedule command with description and <subcommand> args", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/schedule");
    assert(cmd !== undefined, "/schedule command should exist");
    assert.strictEqual(cmd.name, "/schedule");
    assert.strictEqual(cmd.description, "Manage scheduled tasks");
    assert.strictEqual(cmd.args, "<subcommand>");
  });

  it("contains /compact command with description and no args", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/compact");
    assert(cmd !== undefined, "/compact command should exist");
    assert.strictEqual(cmd.name, "/compact");
    assert.strictEqual(cmd.description, "Compact the current session history");
    assert.strictEqual(cmd.args, undefined);
  });

  it("has exactly 7 commands", () => {
    assert.strictEqual(SLASH_COMMANDS.length, 7);
  });

  it("all commands have a name starting with /", () => {
    for (const cmd of SLASH_COMMANDS) {
      assert(
        cmd.name.startsWith("/"),
        `Command name "${cmd.name}" should start with /`
      );
    }
  });

  it("all commands have non-empty descriptions", () => {
    for (const cmd of SLASH_COMMANDS) {
      assert(
        cmd.description.length > 0,
        `Command "${cmd.name}" should have a non-empty description`
      );
      assert(
        typeof cmd.description === "string",
        `Command "${cmd.name}" description should be a string`
      );
    }
  });

  it("all command names are unique", () => {
    const names = new Set(SLASH_COMMANDS.map((c) => c.name));
    assert.strictEqual(
      names.size,
      SLASH_COMMANDS.length,
      "All command names should be unique"
    );
  });

  it("is a readonly array", () => {
    // SLASH_COMMANDS is declared as readonly in TypeScript
    // At runtime, we verify it's an array with the expected length
    assert(Array.isArray(SLASH_COMMANDS));
    assert.strictEqual(SLASH_COMMANDS.length, 7);
  });
});

describe("MessageRouter.getSlashCommands()", () => {
  it("returns the SLASH_COMMANDS array", () => {
    const commands = MessageRouter.getSlashCommands();
    assert.strictEqual(commands, SLASH_COMMANDS, "getSlashCommands should return SLASH_COMMANDS");
  });

  it("returns an array with 7 commands", () => {
    const commands = MessageRouter.getSlashCommands();
    assert.strictEqual(commands.length, 7);
  });

  it("returns commands in the expected order", () => {
    const commands = MessageRouter.getSlashCommands();
    const expectedOrder = ["/new", "/reset", "/fork", "/sessions", "/schedule", "/compact", "/stop"];
    const actualOrder = commands.map((c) => c.name);
    assert.deepStrictEqual(actualOrder, expectedOrder);
  });

  it("returns commands with consistent properties", () => {
    const commands = MessageRouter.getSlashCommands();
    for (const cmd of commands) {
      assert(typeof cmd.name === "string");
      assert(typeof cmd.description === "string");
      if (cmd.args !== undefined) {
        assert(typeof cmd.args === "string");
      }
    }
  });

  it("returns the same reference on multiple calls", () => {
    const first = MessageRouter.getSlashCommands();
    const second = MessageRouter.getSlashCommands();
    assert.strictEqual(first, second, "getSlashCommands should return the same reference");
  });
});

describe("SlashCommandDescriptor interface", () => {
  it("accepts valid command descriptors", () => {
    const validDescriptor: SlashCommandDescriptor = {
      name: "/test",
      description: "A test command",
    };
    assert.strictEqual(validDescriptor.name, "/test");
    assert.strictEqual(validDescriptor.description, "A test command");
    assert.strictEqual(validDescriptor.args, undefined);
  });

  it("accepts command descriptors with args", () => {
    const descriptorWithArgs: SlashCommandDescriptor = {
      name: "/test",
      description: "A test command",
      args: "[arg1]",
    };
    assert.strictEqual(descriptorWithArgs.args, "[arg1]");
  });

  it("validates readonly constraints", () => {
    const cmd = SLASH_COMMANDS[0];
    assert(cmd !== undefined, "First command should exist");
    // TypeScript enforces readonly at compile time; this just verifies the shape
    assert(cmd.name !== undefined);
    assert(cmd.description !== undefined);
  });
});
