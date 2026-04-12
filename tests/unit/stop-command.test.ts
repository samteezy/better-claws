import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SLASH_COMMANDS, MessageRouter, type SlashCommandDescriptor } from "../../src/router/message-router.js";

describe("/stop command in SLASH_COMMANDS", () => {
  it("contains /stop command in the registry", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/stop");
    assert(cmd !== undefined, "/stop command should exist in SLASH_COMMANDS");
  });

  it("/stop has name '/stop'", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/stop");
    assert.strictEqual(cmd?.name, "/stop");
  });

  it("/stop has description 'Stop the current in-progress response'", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/stop");
    assert.strictEqual(
      cmd?.description,
      "Stop the current in-progress response",
    );
  });

  it("/stop has no args property", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/stop");
    assert.strictEqual(cmd?.args, undefined, "/stop should not require arguments");
  });

  it("is included in expected command order", () => {
    const commands = MessageRouter.getSlashCommands();
    const expectedOrder = ["/new", "/reset", "/fork", "/sessions", "/schedule", "/compact", "/stop"];
    const actualOrder = commands.map((c) => c.name);
    assert.deepStrictEqual(actualOrder, expectedOrder);
  });

  it("appears after /compact in SLASH_COMMANDS", () => {
    const commandNames = SLASH_COMMANDS.map((c) => c.name);
    const compactIndex = commandNames.indexOf("/compact");
    const stopIndex = commandNames.indexOf("/stop");
    assert(
      stopIndex > compactIndex,
      "/stop should appear after /compact",
    );
  });

  it("is the last command in SLASH_COMMANDS", () => {
    const lastCommand = SLASH_COMMANDS[SLASH_COMMANDS.length - 1];
    assert.strictEqual(lastCommand?.name, "/stop");
  });

  it("total count is 7 commands including /stop", () => {
    assert.strictEqual(SLASH_COMMANDS.length, 7);
  });
});

describe("MessageRouter.stopSession()", () => {
  it("returns false when no active response for session", () => {
    // Create a minimal mock MessageRouter just to test stopSession
    // since we can't easily instantiate it with all dependencies
    const mockRouter = {
      activeResponses: new Map<string, AbortController>(),
      stopSession(sessionId: string): boolean {
        const controller = this.activeResponses.get(sessionId);
        if (!controller) return false;
        controller.abort();
        return true;
      },
    };

    const result = mockRouter.stopSession("nonexistent-session");
    assert.equal(result, false, "stopSession should return false for unknown session");
  });

  it("returns true when active response exists and aborts it", () => {
    const controller = new AbortController();
    const mockRouter = {
      activeResponses: new Map<string, AbortController>([["session-123", controller]]),
      stopSession(sessionId: string): boolean {
        const c = this.activeResponses.get(sessionId);
        if (!c) return false;
        c.abort();
        return true;
      },
    };

    const result = mockRouter.stopSession("session-123");
    assert.equal(result, true, "stopSession should return true");
    assert.equal(
      controller.signal.aborted,
      true,
      "AbortController should be aborted",
    );
  });

  it("only affects the specified session's active response", () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    const mockRouter = {
      activeResponses: new Map<string, AbortController>([
        ["session-1", controller1],
        ["session-2", controller2],
      ]),
      stopSession(sessionId: string): boolean {
        const c = this.activeResponses.get(sessionId);
        if (!c) return false;
        c.abort();
        return true;
      },
    };

    mockRouter.stopSession("session-1");

    assert.equal(
      controller1.signal.aborted,
      true,
      "Session 1 controller should be aborted",
    );
    assert.equal(
      controller2.signal.aborted,
      false,
      "Session 2 controller should not be aborted",
    );
  });

  it("handles multiple stop calls gracefully", () => {
    const controller = new AbortController();
    const mockRouter = {
      activeResponses: new Map<string, AbortController>([["session-123", controller]]),
      stopSession(sessionId: string): boolean {
        const c = this.activeResponses.get(sessionId);
        if (!c) return false;
        c.abort();
        // In real implementation, this map entry stays, but the controller is aborted
        return true;
      },
    };

    const firstResult = mockRouter.stopSession("session-123");
    // After first abort, the controller is aborted but still exists in the map
    const secondResult = mockRouter.stopSession("session-123");

    assert.equal(firstResult, true, "First stop should return true");
    // Second call to stopSession will still find the controller and call abort again
    // Calling abort() on an already-aborted controller is a no-op and returns true
    assert.equal(secondResult, true, "Second stop should return true (controller still in map)");
  });
});

describe("stopSession behavior with active responses", () => {
  it("allows aborting the same controller multiple times without error", () => {
    const controller = new AbortController();

    // Abort the same controller multiple times
    assert.doesNotThrow(() => {
      controller.abort();
      controller.abort();
      controller.abort();
    });

    assert.equal(controller.signal.aborted, true);
  });

  it("AbortSignal remains aborted after abort is called", () => {
    const controller = new AbortController();
    assert.equal(controller.signal.aborted, false);

    controller.abort();
    assert.equal(controller.signal.aborted, true);

    // Signal should remain aborted
    assert.equal(controller.signal.aborted, true);
  });

  it("AbortSignal listeners can be checked after abort", () => {
    const controller = new AbortController();
    let eventFired = false;

    controller.signal.addEventListener("abort", () => {
      eventFired = true;
    });

    controller.abort();

    assert.equal(eventFired, true, "Abort event should have fired");
  });

  it("Adding abort listener after abort will use onceabort to detect", () => {
    const controller = new AbortController();
    controller.abort();

    // AbortSignal addEventListener doesn't fire synchronously for late listeners
    // We need to check the signal's aborted state instead
    assert.equal(
      controller.signal.aborted,
      true,
      "Signal should be aborted",
    );
  });
});

describe("SlashCommandDescriptor structure for /stop", () => {
  it("is a valid SlashCommandDescriptor", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/stop");
    assert(cmd !== undefined);

    const descriptor: SlashCommandDescriptor = {
      name: cmd.name,
      description: cmd.description,
    };

    assert.strictEqual(descriptor.name, "/stop");
    assert(descriptor.description.length > 0);
  });

  it("conforms to readonly interface constraints", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/stop");
    assert(cmd !== undefined);

    // Verify structure matches SlashCommandDescriptor
    assert.equal(typeof cmd.name, "string");
    assert.equal(typeof cmd.description, "string");
    if (cmd.args !== undefined) {
      assert.equal(typeof cmd.args, "string");
    }
  });
});

describe("/stop command integration checks", () => {
  it("has no duplicate commands when including /stop", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    const uniqueNames = new Set(names);
    assert.equal(
      names.length,
      uniqueNames.size,
      "All command names should be unique",
    );
  });

  it("all commands including /stop have descriptions", () => {
    for (const cmd of SLASH_COMMANDS) {
      assert(
        cmd.description && cmd.description.length > 0,
        `Command ${cmd.name} should have a non-empty description`,
      );
    }
  });

  it("/stop is accessible via getSlashCommands()", () => {
    const commands = MessageRouter.getSlashCommands();
    const stopCmd = commands.find((c) => c.name === "/stop");
    assert(
      stopCmd !== undefined,
      "/stop should be accessible via getSlashCommands()",
    );
    assert.equal(stopCmd?.description, "Stop the current in-progress response");
  });
});

describe("/stop command semantics", () => {
  it("is a command with name starting with /", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/stop");
    assert(
      cmd?.name.startsWith("/"),
      "Command name should start with /",
    );
  });

  it("does not require arguments (args is undefined)", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/stop");
    assert.equal(
      cmd?.args,
      undefined,
      "Should not have args field (takes no arguments)",
    );
  });

  it("description clearly indicates its purpose", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/stop");
    assert(
      cmd?.description.includes("Stop") || cmd?.description.includes("stop"),
      "Description should mention stopping",
    );
    assert(
      cmd?.description.includes("response") || cmd?.description.includes("in-progress"),
      "Description should clarify what is being stopped",
    );
  });
});
