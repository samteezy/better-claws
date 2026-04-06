import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { JsonRpcTransport } from "../../src/mcp/json-rpc.js";

describe("JsonRpcTransport", () => {
  describe("sendRequest()", () => {
    it("writes a JSON-RPC request with incremented id to writable stream", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();
      const written: string[] = [];

      writable.on("data", (chunk: Buffer) => {
        written.push(chunk.toString());
      });

      const transport = new JsonRpcTransport(readable, writable);

      const promise = transport.sendRequest("test:method", { key: "value" });
      await new Promise((resolve) => setImmediate(resolve)); // Let event loop process write

      assert.equal(written.length, 1);
      const line = written[0];
      const parsed = JSON.parse(line!);

      assert.equal(parsed.jsonrpc, "2.0");
      assert.equal(parsed.id, 1);
      assert.equal(parsed.method, "test:method");
      assert.deepEqual(parsed.params, { key: "value" });

      // Clean up the pending promise
      transport.close();
      try {
        await promise;
      } catch {
        // expected to reject
      }
    });

    it("increments request id across multiple calls", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();
      const written: string[] = [];

      writable.on("data", (chunk: Buffer) => {
        written.push(chunk.toString());
      });

      const transport = new JsonRpcTransport(readable, writable);

      const p1 = transport.sendRequest("method1");
      await new Promise((resolve) => setImmediate(resolve));

      const p2 = transport.sendRequest("method2");
      await new Promise((resolve) => setImmediate(resolve));

      const p3 = transport.sendRequest("method3");
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(written.length, 3);
      const ids = written.map((line) => JSON.parse(line).id);
      assert.deepEqual(ids, [1, 2, 3]);

      transport.close();
      for (const p of [p1, p2, p3]) {
        try {
          await p;
        } catch {
          // expected
        }
      }
    });

    it("resolves with response when matching response is received", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const promise = transport.sendRequest("test:method");

      // Simulate server response
      readable.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { data: "success" } }) + "\n");

      const response = await promise;

      assert.deepEqual(response, {
        jsonrpc: "2.0",
        id: 1,
        result: { data: "success" },
      });
    });

    it("sends request without params when params are undefined", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();
      const written: string[] = [];

      writable.on("data", (chunk: Buffer) => {
        written.push(chunk.toString());
      });

      const transport = new JsonRpcTransport(readable, writable);

      const promise = transport.sendRequest("test:method");
      await new Promise((resolve) => setImmediate(resolve));

      const parsed = JSON.parse(written[0]!);
      assert.equal(parsed.params, undefined);

      transport.close();
      try {
        await promise;
      } catch {
        // expected
      }
    });

    it("rejects with timeout error after configured timeout", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable, 100); // 100ms timeout

      const promise = transport.sendRequest("slow:method");

      await assert.rejects(promise, (err: Error) => {
        assert.match(err.message, /timed out after 100ms/);
        return true;
      });
    });

    it("rejects immediately if transport is closed", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);
      transport.close();

      await assert.rejects(
        () => transport.sendRequest("test:method"),
        (err: Error) => {
          assert.equal(err.message, "Transport is closed");
          return true;
        },
      );
    });

    it("rejects all pending requests when close() is called", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable, 10_000);

      const promise1 = transport.sendRequest("method1");
      const promise2 = transport.sendRequest("method2");

      // Give requests time to register
      await new Promise((resolve) => setImmediate(resolve));

      transport.close();

      await assert.rejects(promise1, (err: Error) => {
        assert.equal(err.message, "Transport closed");
        return true;
      });

      await assert.rejects(promise2, (err: Error) => {
        assert.equal(err.message, "Transport closed");
        return true;
      });
    });
  });

  describe("sendNotification()", () => {
    it("writes notification JSON without id to writable stream", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();
      const written: string[] = [];

      writable.on("data", (chunk: Buffer) => {
        written.push(chunk.toString());
      });

      const transport = new JsonRpcTransport(readable, writable);

      transport.sendNotification("server:event", { value: 42 });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(written.length, 1);
      const parsed = JSON.parse(written[0]!);

      assert.equal(parsed.jsonrpc, "2.0");
      assert.equal(parsed.id, undefined);
      assert.equal(parsed.method, "server:event");
      assert.deepEqual(parsed.params, { value: 42 });

      transport.close();
    });

    it("does not write notification if transport is closed", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();
      const written: string[] = [];

      writable.on("data", (chunk: Buffer) => {
        written.push(chunk.toString());
      });

      const transport = new JsonRpcTransport(readable, writable);
      transport.close();

      transport.sendNotification("event", { data: "test" });
      await new Promise((resolve) => setImmediate(resolve));

      // Should not write anything
      assert.equal(written.length, 0);
    });
  });

  describe("onNotification()", () => {
    it("calls notification handler when server sends notification", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      readable.push(JSON.stringify({ jsonrpc: "2.0", method: "server:update", params: { status: "ready" } }) + "\n");

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.method, "server:update");
      assert.deepEqual(notifications[0]!.params, { status: "ready" });

      transport.close();
    });

    it("provides empty params object if notification has no params", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      readable.push(JSON.stringify({ jsonrpc: "2.0", method: "ping" }) + "\n");

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.method, "ping");
      assert.deepEqual(notifications[0]!.params, {});

      transport.close();
    });

    it("calls handler multiple times for multiple notifications", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      readable.push(JSON.stringify({ jsonrpc: "2.0", method: "event:one", params: { id: 1 } }) + "\n");
      readable.push(JSON.stringify({ jsonrpc: "2.0", method: "event:two", params: { id: 2 } }) + "\n");

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(notifications.length, 2);
      assert.equal(notifications[0]!.method, "event:one");
      assert.equal(notifications[1]!.method, "event:two");

      transport.close();
    });

    it("calls notification handler with correct arguments", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      let capturedMethod = "";
      let capturedParams: Record<string, unknown> | null = null;

      transport.onNotification((method, params) => {
        capturedMethod = method;
        capturedParams = params;
      });

      readable.push(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { test: true } }) + "\n");

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(capturedMethod, "event");
      assert.deepEqual(capturedParams, { test: true });

      transport.close();
    });
  });

  describe("message parsing", () => {
    it("silently skips malformed JSON lines", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      // Send: malformed JSON, then valid notification, then another malformed line
      readable.push("{ invalid json\n");
      readable.push(JSON.stringify({ jsonrpc: "2.0", method: "valid:event" }) + "\n");
      readable.push("not json at all\n");

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.method, "valid:event");

      transport.close();
    });

    it("handles multiple lines in a single data chunk", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      // Send two complete lines in one data event
      readable.push(
        JSON.stringify({ jsonrpc: "2.0", method: "event:one" }) +
          "\n" +
          JSON.stringify({ jsonrpc: "2.0", method: "event:two" }) +
          "\n",
      );

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(notifications.length, 2);
      assert.equal(notifications[0]!.method, "event:one");
      assert.equal(notifications[1]!.method, "event:two");

      transport.close();
    });

    it("handles partial lines split across multiple data chunks", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { test: true } });

      // Send line in pieces
      readable.push(line.substring(0, 20));
      await new Promise((resolve) => setImmediate(resolve));

      readable.push(line.substring(20, 40));
      await new Promise((resolve) => setImmediate(resolve));

      readable.push(line.substring(40) + "\n");
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.method, "event");

      transport.close();
    });

    it("skips empty lines", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      readable.push("\n\n");
      readable.push(JSON.stringify({ jsonrpc: "2.0", method: "event" }) + "\n");
      readable.push("\n");

      await new Promise((resolve) => setImmediate(resolve));

      // Should only have one notification despite empty lines
      assert.equal(notifications.length, 1);

      transport.close();
    });

    it("ignores request messages (client does not handle server requests)", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      // Send a request (which has an id and no result/error)
      readable.push(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "server:request", params: {} }) + "\n");

      // Follow with a valid notification
      readable.push(JSON.stringify({ jsonrpc: "2.0", method: "valid:notification" }) + "\n");

      await new Promise((resolve) => setImmediate(resolve));

      // Should only have the notification, not the request
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.method, "valid:notification");

      transport.close();
    });
  });

  describe("response matching", () => {
    it("matches response to correct request by id", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const promise1 = transport.sendRequest("method1");
      const promise2 = transport.sendRequest("method2");

      await new Promise((resolve) => setImmediate(resolve));

      // Send responses out of order
      readable.push(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { from: "method2" } }) + "\n");
      readable.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { from: "method1" } }) + "\n");

      const response1 = await promise1;
      const response2 = await promise2;

      assert.deepEqual(response1.result, { from: "method1" });
      assert.deepEqual(response2.result, { from: "method2" });

      transport.close();
    });

    it("ignores responses for unknown request ids", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const promise = transport.sendRequest("method");

      await new Promise((resolve) => setImmediate(resolve));

      // Send response with wrong id first
      readable.push(JSON.stringify({ jsonrpc: "2.0", id: 999, result: { data: "ignore" } }) + "\n");

      // Then send correct response
      readable.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { data: "correct" } }) + "\n");

      const response = await promise;

      assert.deepEqual(response.result, { data: "correct" });

      transport.close();
    });

    it("resolves with error field if response contains error", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);

      const promise = transport.sendRequest("failing:method");

      await new Promise((resolve) => setImmediate(resolve));

      readable.push(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32600, message: "Invalid Request" },
        }) + "\n",
      );

      const response = await promise;

      assert.deepEqual(response.error, { code: -32600, message: "Invalid Request" });
      assert.equal(response.result, undefined);

      transport.close();
    });
  });

  describe("close()", () => {
    it("prevents new requests after close", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable);
      transport.close();

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.equal(err.message, "Transport is closed");
          return true;
        },
      );
    });

    it("clears timers for pending requests", async () => {
      const readable = new PassThrough();
      const writable = new PassThrough();

      const transport = new JsonRpcTransport(readable, writable, 10_000);

      const promise = transport.sendRequest("method");

      await new Promise((resolve) => setImmediate(resolve));

      // Close should immediately reject without waiting for timeout
      const start = Date.now();
      transport.close();

      try {
        await promise;
      } catch (e) {
        const elapsed = Date.now() - start;
        // Should reject in < 100ms, not wait 10_000ms
        assert.ok(elapsed < 1000, `Took ${elapsed}ms, timeout was 10000ms`);
      }
    });
  });
});
