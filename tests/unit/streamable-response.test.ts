import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StreamableResponse } from "../../src/router/streamable-response.js";
import type { StreamEvent } from "../../src/types.js";

describe("StreamableResponse", () => {
  describe("stream consumption", () => {
    it("yields all events in order from async generator source", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "Hello" };
        yield { type: "text-delta", delta: " world" };
        yield { type: "done", text: "Hello world", usage: { promptTokens: 10, completionTokens: 5 } };
      }

      const response = new StreamableResponse(eventSource());
      const events: StreamEvent[] = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      assert.equal(events.length, 3);
      assert.deepEqual(events[0], { type: "text-delta", delta: "Hello" });
      assert.deepEqual(events[1], { type: "text-delta", delta: " world" });
      assert.deepEqual(events[2], {
        type: "done",
        text: "Hello world",
        usage: { promptTokens: 10, completionTokens: 5 },
      });
    });

    it("handles AsyncIterable (non-generator) source", async () => {
      const iterable: AsyncIterable<StreamEvent> = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: "text-delta", delta: "test" };
          yield { type: "done", text: "test", usage: { promptTokens: 1, completionTokens: 1 } };
        },
      };

      const response = new StreamableResponse(iterable);
      const events: StreamEvent[] = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      assert.equal(events.length, 2);
    });

    it("allows sequential consumers to iterate stream independently with separate cursors", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "a" };
        yield { type: "text-delta", delta: "b" };
        yield { type: "done", text: "ab", usage: { promptTokens: 1, completionTokens: 1 } };
      }

      const response = new StreamableResponse(eventSource());

      // First consumer reads all events
      const consumer1Events: StreamEvent[] = [];
      for await (const event of response.stream) {
        consumer1Events.push(event);
      }

      // Second consumer starts after first is done, reads from buffer
      const consumer2Events: StreamEvent[] = [];
      for await (const event of response.stream) {
        consumer2Events.push(event);
      }

      // Both consumers should see all events from the buffer
      assert.equal(consumer1Events.length, 3);
      assert.equal(consumer2Events.length, 3);
      assert.deepEqual(consumer1Events[0], { type: "text-delta", delta: "a" });
      assert.deepEqual(consumer2Events[0], { type: "text-delta", delta: "a" });
    });

    it("handles empty stream (only done event)", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "done", text: "", usage: { promptTokens: 0, completionTokens: 0 } };
      }

      const response = new StreamableResponse(eventSource());
      const events: StreamEvent[] = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "done");
    });
  });

  describe(".text promise", () => {
    it("resolves to text from done event", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "Hello" };
        yield { type: "done", text: "Hello world", usage: { promptTokens: 10, completionTokens: 5 } };
      }

      const response = new StreamableResponse(eventSource());
      const text = await response.text;

      assert.equal(text, "Hello world");
    });

    it("resolves to empty string for empty text in done event", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "done", text: "", usage: { promptTokens: 0, completionTokens: 0 } };
      }

      const response = new StreamableResponse(eventSource());
      const text = await response.text;

      assert.equal(text, "");
    });


    it("rejects with error if source yields non-error, then throws", async () => {
      const sourceError = new Error("Unexpected error");
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "partial" };
        throw sourceError;
      }

      const response = new StreamableResponse(eventSource());

      try {
        await assert.rejects(
          async () => {
            // Try both promises; whichever rejects first will trigger the error
            await Promise.race([response.text, response.usage]);
          },
          (err: unknown) => err === sourceError,
        );
      } finally {
        // Ensure both rejections are handled
        await Promise.all([
          response.text.catch(() => {
            /* expected */
          }),
          response.usage.catch(() => {
            /* expected */
          }),
        ]);
      }
    });

    it("captures generic error thrown from source", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        throw "not an Error object";
      }

      const response = new StreamableResponse(eventSource());

      await assert.rejects(
        async () => {
          await response.text;
        },
      );
    });
  });

  describe(".usage promise", () => {
    it("resolves to usage from done event", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "text" };
        yield { type: "done", text: "text", usage: { promptTokens: 42, completionTokens: 17 } };
      }

      const response = new StreamableResponse(eventSource());
      const usage = await response.usage;

      assert.deepEqual(usage, { promptTokens: 42, completionTokens: 17 });
    });

    it("resolves to zero usage for empty response", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "done", text: "", usage: { promptTokens: 0, completionTokens: 0 } };
      }

      const response = new StreamableResponse(eventSource());
      const usage = await response.usage;

      assert.deepEqual(usage, { promptTokens: 0, completionTokens: 0 });
    });

    it("rejects with error if source throws", async () => {
      const sourceError = new Error("Stream error");
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        throw sourceError;
      }

      const response = new StreamableResponse(eventSource());

      try {
        await assert.rejects(
          async () => {
            await response.usage;
          },
          (err: unknown) => err === sourceError,
        );
      } finally {
        // Ensure text promise rejection is handled
        await response.text.catch(() => {
          /* expected */
        });
      }
    });

    it("catches rejections even if promises are not awaited", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        throw new Error("Expected error");
      }

      const response = new StreamableResponse(eventSource());
      // Catch the rejection so it doesn't cause unhandled rejection warnings
      response.usage.catch(() => {
        // Expected to reject
      });

      // The text promise should also be rejected
      await assert.rejects(
        async () => {
          await response.text;
        },
      );
    });

    it("usage and text both resolve independently", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "content" };
        yield { type: "done", text: "content", usage: { promptTokens: 5, completionTokens: 3 } };
      }

      const response = new StreamableResponse(eventSource());

      const [text, usage] = await Promise.all([response.text, response.usage]);

      assert.equal(text, "content");
      assert.deepEqual(usage, { promptTokens: 5, completionTokens: 3 });
    });
  });

  describe("onComplete callback", () => {
    it("calls onComplete callback when done event is received", async () => {
      let callbackCalled = false;
      let callbackEvent: unknown = null;

      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "hello" };
        yield { type: "done", text: "hello", usage: { promptTokens: 1, completionTokens: 1 } };
      }

      const response = new StreamableResponse(eventSource(), (event) => {
        callbackCalled = true;
        callbackEvent = event;
      });

      await response.text;

      assert.ok(callbackCalled);
      assert.ok(callbackEvent && typeof callbackEvent === "object");
      assert.equal((callbackEvent as Record<string, unknown>)["type"], "done");
      assert.equal((callbackEvent as Record<string, unknown>)["text"], "hello");
    });

    it("calls onComplete before text promise resolves", async () => {
      const callOrder: string[] = [];

      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "done", text: "test", usage: { promptTokens: 0, completionTokens: 0 } };
      }

      const response = new StreamableResponse(eventSource(), () => {
        callOrder.push("onComplete");
      });

      const textPromise = response.text.then(() => {
        callOrder.push("text:resolved");
      });

      await textPromise;

      // onComplete should be called before text resolves
      assert.equal(callOrder[0], "onComplete");
      assert.equal(callOrder[1], "text:resolved");
    });

    it("supports async onComplete callback", async () => {
      let callbackExecuted = false;

      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "done", text: "test", usage: { promptTokens: 1, completionTokens: 1 } };
      }

      const response = new StreamableResponse(eventSource(), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        callbackExecuted = true;
      });

      await response.text;
      assert.ok(callbackExecuted);
    });

    it("does not call onComplete if stream does not reach done", async () => {
      let callbackCalled = false;

      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "incomplete" };
      }

      const response = new StreamableResponse(eventSource(), () => {
        callbackCalled = true;
      });

      // Read stream but never reaches done
      for await (const _event of response.stream) {
        // Just consume
      }

      assert.ok(!callbackCalled);
    });

    it("passes correct done event to callback", async () => {
      const passedEvent: Array<StreamEvent & { type: "done" }> = [];

      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "part1" };
        yield { type: "text-delta", delta: "part2" };
        yield { type: "done", text: "part1part2", usage: { promptTokens: 100, completionTokens: 50 } };
      }

      const response = new StreamableResponse(eventSource(), (event) => {
        passedEvent.push(event);
      });

      await response.text;

      assert.equal(passedEvent.length, 1);
      assert.deepEqual(passedEvent[0], {
        type: "done",
        text: "part1part2",
        usage: { promptTokens: 100, completionTokens: 50 },
      });
    });
  });

  describe("error handling", () => {
    it("pushes error event to stream when source throws", async () => {
      const sourceError = new Error("Source error message");
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "start" };
        throw sourceError;
      }

      const response = new StreamableResponse(eventSource());
      // Catch the rejection to avoid unhandled rejection warnings
      response.text.catch(() => {
        // Expected to reject
      });
      response.usage.catch(() => {
        // Expected to reject
      });

      const events: StreamEvent[] = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      assert.ok(events.some((e) => e.type === "error"));
      const errorEvent = events.find((e) => e.type === "error");
      assert.equal(errorEvent?.type, "error");
      assert.ok(errorEvent?.type === "error" && errorEvent.message === "Source error message");
    });

    it("captures error message from Error object", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        throw new Error("Custom error");
      }

      const response = new StreamableResponse(eventSource());
      // Catch the rejection to avoid unhandled rejection warnings
      response.text.catch(() => {
        // Expected to reject
      });
      response.usage.catch(() => {
        // Expected to reject
      });

      const events: StreamEvent[] = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === "error");
      assert.ok(errorEvent?.type === "error" && errorEvent.message === "Custom error");
    });

    it("uses generic message for non-Error throws", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        throw "string error";
      }

      const response = new StreamableResponse(eventSource());
      // Catch the rejection to avoid unhandled rejection warnings
      response.text.catch(() => {
        // Expected to reject
      });
      response.usage.catch(() => {
        // Expected to reject
      });

      const events: StreamEvent[] = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === "error");
      assert.ok(errorEvent?.type === "error" && errorEvent.message === "Stream failed");
    });

    it("rejects text promise on stream error", async () => {
      const testError = new Error("Test error");
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        throw testError;
      }

      const response = new StreamableResponse(eventSource());

      await assert.rejects(
        async () => {
          await response.text;
        },
        (err: unknown) => err === testError,
      );
    });

    it("rejects usage promise on stream error", async () => {
      const testError = new Error("Test error");
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        throw testError;
      }

      const response = new StreamableResponse(eventSource());
      // Catch the text rejection to avoid unhandled rejection warnings
      response.text.catch(() => {
        // Expected to reject
      });

      await assert.rejects(
        async () => {
          await response.usage;
        },
        (err: unknown) => err === testError,
      );
    });
  });

  describe("StreamableResponse.fromText()", () => {
    it("creates response with non-empty text", async () => {
      const response = StreamableResponse.fromText("Hello world");
      const text = await response.text;

      assert.equal(text, "Hello world");
    });

    it("creates response with empty text", async () => {
      const response = StreamableResponse.fromText("");
      const text = await response.text;

      assert.equal(text, "");
    });

    it("yields text-delta event for non-empty text", async () => {
      const response = StreamableResponse.fromText("test content");
      const events: StreamEvent[] = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      assert.equal(events.length, 2);
      assert.deepEqual(events[0], { type: "text-delta", delta: "test content" });
    });

    it("yields only done event for empty text", async () => {
      const response = StreamableResponse.fromText("");
      const events: StreamEvent[] = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "done");
    });

    it("yields done event with correct text and zero usage", async () => {
      const response = StreamableResponse.fromText("example");
      const events: StreamEvent[] = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      const doneEvent = events.find((e) => e.type === "done");
      assert.deepEqual(doneEvent, {
        type: "done",
        text: "example",
        usage: { promptTokens: 0, completionTokens: 0 },
      });
    });

    it("resolves usage promise with zero tokens", async () => {
      const response = StreamableResponse.fromText("text");
      const usage = await response.usage;

      assert.deepEqual(usage, { promptTokens: 0, completionTokens: 0 });
    });

    it("handles multi-line text", async () => {
      const multiLineText = "line1\nline2\nline3";
      const response = StreamableResponse.fromText(multiLineText);
      const text = await response.text;

      assert.equal(text, multiLineText);
    });

    it("handles text with special characters", async () => {
      const specialText = "Hello\nWorld\t\r\n!@#$%^&*()";
      const response = StreamableResponse.fromText(specialText);
      const text = await response.text;

      assert.equal(text, specialText);
    });
  });

  describe("complex scenarios", () => {
    it("handles many sequential text-delta events", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        for (let i = 0; i < 100; i++) {
          yield { type: "text-delta", delta: `chunk-${i}` };
        }
        yield { type: "done", text: "all chunks", usage: { promptTokens: 1000, completionTokens: 500 } };
      }

      const response = new StreamableResponse(eventSource());
      const events: StreamEvent[] = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      const deltaEvents = events.filter((e) => e.type === "text-delta");
      assert.equal(deltaEvents.length, 100);
      assert.equal(events[events.length - 1]?.type, "done");
    });

    it("handles mixed event types", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "text1" };
        yield {
          type: "tool-start",
          toolCall: { id: "call-1", type: "function" as const, function: { name: "tool1", arguments: '{}' } },
        };
        yield { type: "text-delta", delta: "text2" };
        yield { type: "tool-result", toolName: "tool1", output: { result: "value" } };
        yield { type: "text-delta", delta: "text3" };
        yield { type: "done", text: "complete", usage: { promptTokens: 50, completionTokens: 25 } };
      }

      const response = new StreamableResponse(eventSource());
      const events: StreamEvent[] = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      assert.equal(events.length, 6);
      assert.equal(events.filter((e) => e.type === "text-delta").length, 3);
      assert.equal(events.filter((e) => e.type === "tool-start").length, 1);
      assert.equal(events.filter((e) => e.type === "tool-result").length, 1);
    });

    it("resolves both promises before stream consumption finishes", async () => {
      async function* eventSource(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", delta: "data" };
        yield { type: "done", text: "data", usage: { promptTokens: 10, completionTokens: 5 } };
      }

      const response = new StreamableResponse(eventSource());

      // Start consuming text and usage concurrently, before fully consuming stream
      const textPromise = response.text;
      const usagePromise = response.usage;

      const text = await textPromise;
      const usage = await usagePromise;

      assert.equal(text, "data");
      assert.deepEqual(usage, { promptTokens: 10, completionTokens: 5 });

      // Stream should still be consumable
      const events: StreamEvent[] = [];
      for await (const event of response.stream) {
        events.push(event);
      }

      assert.equal(events.length, 2);
    });
  });
});
