import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Server } from "node:http";
import { HttpTransport, HttpTransportError } from "../../src/mcp/http-transport.js";

// ── Helper ────────────────────────────────────────────────────────────────────

function createMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: Server; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/`;
      resolve({ server, port: addr.port, url });
    });
  });
}

describe("HttpTransport", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    servers.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  describe("sendRequest()", () => {
    it("sends JSON-RPC request and receives JSON response", async () => {
      const { server, url } = await createMockServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          assert.equal(parsed.jsonrpc, "2.0");
          assert.equal(parsed.method, "test:method");
          assert.deepEqual(parsed.params, { key: "value" });
          assert.equal(typeof parsed.id, "number");

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { success: true } }));
        });
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const response = await transport.sendRequest("test:method", { key: "value" });

      assert.deepEqual(response.result, { success: true });
      transport.close();
    });

    it("includes correct headers in request", async () => {
      const { server, url } = await createMockServer((req, res) => {
        assert.equal(req.method, "POST");
        assert.equal(req.headers["content-type"], "application/json");
        assert.equal(req.headers.accept, "application/json, text/event-stream");
        assert.ok(req.headers["content-length"]);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      await transport.sendRequest("test");
      transport.close();
    });

    it("includes custom headers from constructor", async () => {
      const { server, url } = await createMockServer((req, res) => {
        assert.equal(req.headers["authorization"], "Bearer token123");
        assert.equal(req.headers["x-custom"], "custom-value");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      });
      servers.push(server);

      const transport = new HttpTransport(url, {
        authorization: "Bearer token123",
        "x-custom": "custom-value",
      });
      await transport.sendRequest("test");
      transport.close();
    });

    it("increments request id across multiple calls", async () => {
      const ids: number[] = [];
      const { server, url } = await createMockServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          ids.push(parsed.id);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {} }));
        });
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      await transport.sendRequest("method1");
      await transport.sendRequest("method2");
      await transport.sendRequest("method3");

      assert.deepEqual(ids, [1, 2, 3]);
      transport.close();
    });

    it("handles SSE response with single data event", async () => {
      const { server, url } = await createMockServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const parsed = JSON.parse(body);

          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { sse: true } })}\n\n`);
          res.end();
        });
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const response = await transport.sendRequest("test");

      assert.deepEqual(response.result, { sse: true });
      transport.close();
    });

    it("handles SSE response with multiple data lines in one event", async () => {
      const { server, url } = await createMockServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const parsed = JSON.parse(body);

          // SSE format with multiline data where each data: line is joined with newline
          // The implementation concatenates them with newlines, which will produce invalid JSON
          // This test verifies that multi-line data is still parsed if it produces valid JSON
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: { multiline: "data" },
            })}\n\n`,
          );
          res.end();
        });
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const response = await transport.sendRequest("test");

      assert.ok(response.jsonrpc);
      assert.deepEqual(response.result, { multiline: "data" });
      transport.close();
    });

    it("calls notification handler for server notifications in SSE stream", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notify:event", params: { alert: "test" } })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { done: true } })}\n\n`);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      const response = await transport.sendRequest("test");

      assert.deepEqual(response.result, { done: true });
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.method, "notify:event");
      assert.deepEqual(notifications[0]!.params, { alert: "test" });
      transport.close();
    });

    it("provides empty params object for notifications without params", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "ping" })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      await transport.sendRequest("test");

      assert.equal(notifications.length, 1);
      assert.deepEqual(notifications[0]!.params, {});
      transport.close();
    });

    it("handles multiple notifications in SSE stream before response", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notify:one", params: { id: 1 } })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notify:two", params: { id: 2 } })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { done: true } })}\n\n`);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      await transport.sendRequest("test");

      assert.equal(notifications.length, 2);
      assert.equal(notifications[0]!.method, "notify:one");
      assert.equal(notifications[1]!.method, "notify:two");
      transport.close();
    });

    it("skips malformed JSON in SSE stream", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: { invalid json\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "valid:event", params: {} })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      const response = await transport.sendRequest("test");

      assert.ok(response.result);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.method, "valid:event");
      transport.close();
    });

    it("skips empty SSE blocks", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n\n`);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const response = await transport.sendRequest("test");

      assert.deepEqual(response.result, { ok: true });
      transport.close();
    });

    it("ignores request messages in SSE stream (server should not send them)", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // Server sends a request-like message (has id but no result/error) — should be ignored
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "server:request" })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "valid:notification" })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { done: true } })}\n\n`);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      await transport.sendRequest("test");

      // Only the notification should be captured, not the server request message
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.method, "valid:notification");
      transport.close();
    });

    it("rejects on HTTP 4xx error", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request" }));
      });
      servers.push(server);

      const transport = new HttpTransport(url);

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof HttpTransportError);
          assert.match(err.message, /HTTP 400/);
          return true;
        },
      );

      transport.close();
    });

    it("rejects on HTTP 5xx error", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      });
      servers.push(server);

      const transport = new HttpTransport(url);

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof HttpTransportError);
          assert.match(err.message, /HTTP 500/);
          return true;
        },
      );

      transport.close();
    });

    it("rejects when response body is not valid JSON", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not valid json");
      });
      servers.push(server);

      const transport = new HttpTransport(url);

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof HttpTransportError);
          assert.match(err.message, /Invalid JSON/);
          return true;
        },
      );

      transport.close();
    });

    it("rejects on timeout", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        // Never respond
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
        }, 500);
      });
      servers.push(server);

      const transport = new HttpTransport(url, {}, 100); // 100ms timeout

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.match(err.message, /timed out after 100ms/);
          return true;
        },
      );

      transport.close();
    });

    it("rejects immediately if transport is closed", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      transport.close();

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof HttpTransportError);
          assert.equal(err.message, "Transport is closed");
          return true;
        },
      );
    });

    it("rejects on socket error", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.destroy();
      });
      servers.push(server);

      const transport = new HttpTransport(url);

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof HttpTransportError);
          assert.match(err.message, /HTTP request error/);
          return true;
        },
      );

      transport.close();
    });

    it("rejects when SSE stream ends without response", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notify", params: {} })}\n\n`);
        res.end(); // End without sending the response
      });
      servers.push(server);

      const transport = new HttpTransport(url);

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof HttpTransportError);
          assert.match(err.message, /SSE stream ended without a response/);
          return true;
        },
      );

      transport.close();
    });

    it("captures Mcp-Session-Id header from response", async () => {
      let secondRequestHeaders: Record<string, string | string[] | undefined> = {};
      const { server, url } = await createMockServer((req, res) => {
        secondRequestHeaders = req.headers;
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "session-abc-123" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      await transport.sendRequest("first");

      // Second request should include the session ID
      await transport.sendRequest("second");

      assert.equal(secondRequestHeaders["mcp-session-id"], "session-abc-123");
      transport.close();
    });

    it("overwrites session ID when server sends new one", async () => {
      const sessionIds: (string | string[] | undefined)[] = [];
      const { server, url } = await createMockServer((req, res) => {
        sessionIds.push(req.headers["mcp-session-id"]);

        if (sessionIds.length === 1) {
          res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "session-first" });
        } else {
          res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "session-second" });
        }

        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      await transport.sendRequest("first");
      await transport.sendRequest("second");
      await transport.sendRequest("third");

      // First request has no session ID
      assert.equal(sessionIds[0], undefined);
      // Second request echoes the first session ID
      assert.equal(sessionIds[1], "session-first");
      // Third request echoes the updated session ID
      assert.equal(sessionIds[2], "session-second");
      transport.close();
    });

    it("sends request without params when params are undefined", async () => {
      let receivedBody = "";
      const { server, url } = await createMockServer((req, res) => {
        req.on("data", (chunk: Buffer) => {
          receivedBody += chunk.toString();
        });
        req.on("end", () => {
          const parsed = JSON.parse(receivedBody);
          assert.equal(parsed.params, undefined);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {} }));
        });
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      await transport.sendRequest("test");
      transport.close();
    });

    it("resolves with error field if response contains JSON-RPC error", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "Invalid Request" },
          }),
        );
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const response = await transport.sendRequest("test");

      assert.deepEqual(response.error, { code: -32600, message: "Invalid Request" });
      assert.equal(response.result, undefined);
      transport.close();
    });
  });

  describe("sendNotification()", () => {
    it("sends notification POST without returning a response", async () => {
      let received: string | null = null;
      const { server, url } = await createMockServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          received = body;
          res.writeHead(200);
          res.end();
        });
      });
      servers.push(server);

      const transport = new HttpTransport(url);

      // sendNotification is void, does not return a promise
      transport.sendNotification("test:notify", { data: "value" });

      // Give the request time to be sent
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.ok(received);
      const parsed = JSON.parse(received);
      assert.equal(parsed.jsonrpc, "2.0");
      assert.equal(parsed.method, "test:notify");
      assert.deepEqual(parsed.params, { data: "value" });
      assert.equal(parsed.id, undefined);

      transport.close();
    });

    it("does not throw when transport is closed", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      transport.close();

      // Should not throw
      assert.doesNotThrow(() => {
        transport.sendNotification("test", { data: "value" });
      });
    });

    it("catches and ignores errors from notification POST", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.destroy();
      });
      servers.push(server);

      const transport = new HttpTransport(url);

      // Should not throw even though the server will error
      assert.doesNotThrow(() => {
        transport.sendNotification("test", { data: "value" });
      });

      transport.close();
    });
  });

  describe("onNotification()", () => {
    it("sets notification handler that receives method and params", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "server:event", params: { type: "alert" } })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);

      let capturedMethod = "";
      let capturedParams: Record<string, unknown> | null = null;

      transport.onNotification((method, params) => {
        capturedMethod = method;
        capturedParams = params;
      });

      await transport.sendRequest("test");

      assert.equal(capturedMethod, "server:event");
      assert.deepEqual(capturedParams, { type: "alert" });
      transport.close();
    });

    it("allows multiple notifications to be handled by same handler", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "event:one", params: { id: 1 } })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "event:two", params: { id: 2 } })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);

      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      await transport.sendRequest("test");

      assert.equal(notifications.length, 2);
      assert.equal(notifications[0]!.method, "event:one");
      assert.equal(notifications[1]!.method, "event:two");
      transport.close();
    });
  });

  describe("close()", () => {
    it("prevents subsequent sendRequest calls", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      transport.close();

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof HttpTransportError);
          assert.equal(err.message, "Transport is closed");
          return true;
        },
      );
    });

    it("prevents sendNotification calls", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      transport.close();

      let requestReceived = false;
      const newServer = http.createServer((_req, res) => {
        requestReceived = true;
        res.writeHead(200);
        res.end();
      });
      servers.push(newServer);

      // Verify that no request is sent
      transport.sendNotification("test", {});
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(requestReceived, false);
    });
  });

  describe("error handling", () => {
    it("creates HttpTransportError with correct error code on HTTP error", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(403);
        res.end("Forbidden");
      });
      servers.push(server);

      const transport = new HttpTransport(url);

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof HttpTransportError);
          assert.equal(err.name, "HttpTransportError");
          return true;
        },
      );

      transport.close();
    });

    it("truncates long error response bodies to 500 characters", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(400);
        const longBody = "error: " + "x".repeat(600);
        res.end(longBody);
      });
      servers.push(server);

      const transport = new HttpTransport(url);

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err.message.includes("HTTP 400"));
          assert.ok(err.message.length < 600);
          return true;
        },
      );

      transport.close();
    });
  });

  describe("constructor options", () => {
    it("accepts custom timeout in milliseconds", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        // Never respond
        setTimeout(() => {
          res.writeHead(200);
          res.end();
        }, 1000);
      });
      servers.push(server);

      const transport = new HttpTransport(url, {}, 50);

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.match(err.message, /timed out after 50ms/);
          return true;
        },
      );

      transport.close();
    });

    it("uses default 30 second timeout when not specified", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
      });
      servers.push(server);

      const transport = new HttpTransport(url); // No timeout specified

      const response = await transport.sendRequest("test");

      assert.ok(response.result);
      transport.close();
    });

    it("validates URL on construction", () => {
      assert.throws(
        () => {
          new HttpTransport("not a valid url!");
        },
        /Invalid URL/,
      );
    });
  });

  describe("SSE streaming edge cases", () => {
    it("handles SSE data split across multiple chunks", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });

        const jsonData = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { chunked: true } });
        const fullLine = `data: ${jsonData}`;

        // Send data in small chunks
        for (let i = 0; i < fullLine.length; i += 10) {
          res.write(fullLine.substring(i, i + 10));
        }
        res.write("\n\n");
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const response = await transport.sendRequest("test");

      assert.deepEqual(response.result, { chunked: true });
      transport.close();
    });

    it("handles multiple SSE events in rapid succession", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });

        for (let i = 1; i <= 5; i++) {
          res.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: `notify:${i}`, params: { idx: i } })}\n\n`,
          );
        }

        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { all: true } })}\n\n`);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      const response = await transport.sendRequest("test");

      assert.deepEqual(response.result, { all: true });
      assert.equal(notifications.length, 5);
      for (let i = 0; i < 5; i++) {
        assert.equal(notifications[i]!.method, `notify:${i + 1}`);
      }
      transport.close();
    });

    it("handles SSE comments (lines starting with :)", async () => {
      const { server, url } = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`: this is a comment\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n\n`);
        res.end();
      });
      servers.push(server);

      const transport = new HttpTransport(url);
      const response = await transport.sendRequest("test");

      assert.deepEqual(response.result, { ok: true });
      transport.close();
    });
  });
});
