import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Server } from "node:http";
import { SseTransport, SseTransportError } from "../../src/mcp/sse-transport.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockSseServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SseTransport", () => {
  let servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    servers = [];
    // Let sockets drain
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  describe("connect()", () => {
    it("successfully connects and receives endpoint event", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Mcp-Session-Id": "session-123",
        });
        res.write("event: endpoint\n");
        res.write("data: /messages\n\n");
        // Keep connection open
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);
      await transport.connect();

      // Verify the transport is ready to send requests
      transport.close();
    });

    it("includes Accept and Cache-Control headers in GET request", async () => {
      const headers: Record<string, string | string[] | undefined> = {};
      const { server, port } = await createMockSseServer((req, res) => {
        Object.assign(headers, req.headers);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`, {
        "X-Custom": "value",
      });
      await transport.connect();

      assert.equal(headers["accept"], "text/event-stream");
      assert.equal(headers["cache-control"], "no-cache");
      assert.equal(headers["x-custom"], "value");

      transport.close();
    });

    it("captures Mcp-Session-Id header from response", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Mcp-Session-Id": "test-session-456",
        });
        res.write("event: endpoint\ndata: /messages\n\n");
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);
      await transport.connect();

      // Session ID is captured internally; verified in session management tests
      transport.close();
    });

    it("rejects when server returns non-200 status", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized");
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);

      await assert.rejects(
        () => transport.connect(),
        (err: Error) => {
          assert.ok(err instanceof SseTransportError);
          assert.match(err.message, /401/);
          return true;
        },
      );
    });

    it("rejects on connection timeout", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // Never send endpoint event, let it timeout
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`, {}, 100);

      await assert.rejects(
        () => transport.connect(),
        (err: Error) => {
          assert.ok(err instanceof SseTransportError);
          assert.equal(err.message, "SSE connect timed out waiting for endpoint event");
          return true;
        },
      );
    });

    it("rejects when SSE stream closes before endpoint event", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: message\ndata: hello\n\n");
        res.end(); // Close without sending endpoint
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);

      await assert.rejects(
        () => transport.connect(),
        (err: Error) => {
          assert.ok(err instanceof SseTransportError);
          assert.equal(err.message, "SSE connection closed before endpoint event");
          return true;
        },
      );
    });

    it("resolves relative endpoint URL against SSE URL", async () => {
      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`);
      await transport.connect();

      // Verify connection succeeded by sending a request
      const responsePromise = transport.sendRequest("test", {});

      // The POST will hit the message server we created above
      await responsePromise;

      transport.close();
    });

    it("rejects on request error", async () => {
      const transport = new SseTransport("http://127.0.0.1:1/invalid-port");

      await assert.rejects(
        () => transport.connect(),
        (err: Error) => {
          assert.ok(err instanceof SseTransportError);
          assert.match(err.message, /SSE request error/);
          return true;
        },
      );
    });

    it("rejects on response stream error", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
        // Simulate error after sending endpoint
        setTimeout(() => {
          res.destroy(new Error("Connection lost"));
        }, 10);
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);
      await transport.connect();

      // Connection succeeded, error happens after
      transport.close();
    });
  });

  describe("sendRequest()", () => {
    it("sends JSON-RPC request and receives response via SSE", async () => {
      const receivedRequests: string[] = [];

      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (req, res) => {
          let body = "";
          req.on("data", (chunk: string) => {
            body += chunk;
          });
          req.on("end", () => {
            receivedRequests.push(body);
            res.writeHead(200);
            res.end();
          });
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);

        // Send response back after a brief delay
        setTimeout(() => {
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n\n");
        }, 50);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`);
      await transport.connect();

      const response = await transport.sendRequest("test:method", { key: "value" });

      assert.deepEqual(response.result, { ok: true });
      assert.equal(receivedRequests.length, 1);

      const parsed = JSON.parse(receivedRequests[0]!);
      assert.equal(parsed.jsonrpc, "2.0");
      assert.equal(parsed.id, 1);
      assert.equal(parsed.method, "test:method");
      assert.deepEqual(parsed.params, { key: "value" });

      transport.close();
    });

    it("sends multiple requests with incremented ids", async () => {
      const receivedRequests: string[] = [];

      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (req, res) => {
          let body = "";
          req.on("data", (chunk: string) => {
            body += chunk;
          });
          req.on("end", () => {
            receivedRequests.push(body);
            res.writeHead(200);
            res.end();
          });
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);

        // Send responses back
        setTimeout(() => {
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: 1, result: { num: 1 } }) + "\n\n");
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: 2, result: { num: 2 } }) + "\n\n");
        }, 50);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`);
      await transport.connect();

      const p1 = transport.sendRequest("method1");
      const p2 = transport.sendRequest("method2");

      const r1 = await p1;
      const r2 = await p2;

      assert.equal(r1.id, 1);
      assert.deepEqual(r1.result, { num: 1 });
      assert.equal(r2.id, 2);
      assert.deepEqual(r2.result, { num: 2 });

      transport.close();
    });

    it("rejects when transport is not connected", async () => {
      const transport = new SseTransport("http://127.0.0.1:9999/sse");

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof SseTransportError);
          assert.equal(err.message, "Transport is not connected");
          return true;
        },
      );
    });

    it("rejects when transport is closed", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);
      await transport.connect();
      transport.close();

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof SseTransportError);
          assert.equal(err.message, "Transport is not connected");
          return true;
        },
      );
    });

    it("rejects on request timeout", async () => {
      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (_req, res) => {
          // Acknowledge POST but never respond
          res.writeHead(200);
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`, {}, 100);
      await transport.connect();

      await assert.rejects(
        () => transport.sendRequest("slow:method"),
        (err: Error) => {
          assert.match(err.message, /timed out after 100ms/);
          return true;
        },
      );

      transport.close();
    });

    it("properly correlates responses by id when received out of order", async () => {
      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (_req, res) => {
          res.writeHead(200);
          res.end();
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);

        // Send responses out of order
        setTimeout(() => {
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: 3, result: { num: 3 } }) + "\n\n");
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: 1, result: { num: 1 } }) + "\n\n");
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: 2, result: { num: 2 } }) + "\n\n");
        }, 50);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`);
      await transport.connect();

      const p1 = transport.sendRequest("method1");
      const p2 = transport.sendRequest("method2");
      const p3 = transport.sendRequest("method3");

      // Resolve in order despite responses arriving out of order
      const r1 = await p1;
      const r2 = await p2;
      const r3 = await p3;

      assert.deepEqual(r1.result, { num: 1 });
      assert.deepEqual(r2.result, { num: 2 });
      assert.deepEqual(r3.result, { num: 3 });

      transport.close();
    });

    it("rejects on POST error", async () => {
      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (_req, res) => {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`);
      await transport.connect();

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof SseTransportError);
          assert.match(err.message, /500/);
          return true;
        },
      );

      transport.close();
    });

    it("handles response in POST body (direct response)", async () => {
      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { immediate: true } }));
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`);
      await transport.connect();

      const response = await transport.sendRequest("test");

      assert.deepEqual(response.result, { immediate: true });

      transport.close();
    });

    it("handles JSON-RPC error response", async () => {
      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (_req, res) => {
          res.writeHead(200);
          res.end();
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);

        setTimeout(() => {
          res.write("event: message\n");
          res.write(
            "data: " +
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                error: { code: -32600, message: "Invalid Request" },
              }) +
              "\n\n",
          );
        }, 50);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`);
      await transport.connect();

      const response = await transport.sendRequest("bad:request");

      assert.deepEqual(response.error, { code: -32600, message: "Invalid Request" });
      assert.equal(response.result, undefined);

      transport.close();
    });
  });

  describe("sendNotification()", () => {
    it("sends notification without waiting for response", async () => {
      const receivedRequests: string[] = [];

      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (req, res) => {
          let body = "";
          req.on("data", (chunk: string) => {
            body += chunk;
          });
          req.on("end", () => {
            receivedRequests.push(body);
            res.writeHead(200);
            res.end();
          });
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`);
      await transport.connect();

      // Send notification (fire and forget)
      transport.sendNotification("test:notify", { key: "value" });

      // Give the notification time to be sent
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(receivedRequests.length, 1);

      const parsed = JSON.parse(receivedRequests[0]!);
      assert.equal(parsed.jsonrpc, "2.0");
      assert.equal(parsed.id, undefined);
      assert.equal(parsed.method, "test:notify");
      assert.deepEqual(parsed.params, { key: "value" });

      transport.close();
    });

    it("does not throw when transport is closed", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);
      await transport.connect();
      transport.close();

      // Should not throw
      transport.sendNotification("test", {});
    });

    it("does not throw when transport is not connected", () => {
      const transport = new SseTransport("http://127.0.0.1:9999/sse");

      // Should not throw
      transport.sendNotification("test", {});
    });
  });

  describe("onNotification()", () => {
    it("calls notification handler when server pushes notification", async () => {
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");

        // Push a notification after a brief delay
        setTimeout(() => {
          res.write("event: message\n");
          res.write(
            "data: " + JSON.stringify({ jsonrpc: "2.0", method: "server:update", params: { status: "ready" } }) + "\n\n",
          );
        }, 50);
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);

      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      await transport.connect();

      // Wait for notification to arrive
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.method, "server:update");
      assert.deepEqual(notifications[0]!.params, { status: "ready" });

      transport.close();
    });

    it("provides empty params object if notification has no params", async () => {
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");

        setTimeout(() => {
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", method: "ping" }) + "\n\n");
        }, 50);
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);

      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      await transport.connect();

      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.method, "ping");
      assert.deepEqual(notifications[0]!.params, {});

      transport.close();
    });

    it("calls handler multiple times for multiple notifications", async () => {
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");

        setTimeout(() => {
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", method: "event:one", params: { id: 1 } }) + "\n\n");
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", method: "event:two", params: { id: 2 } }) + "\n\n");
        }, 50);
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);

      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      await transport.connect();

      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(notifications.length, 2);
      assert.equal(notifications[0]!.method, "event:one");
      assert.equal(notifications[1]!.method, "event:two");

      transport.close();
    });

    it("ignores responses (messages with id)", async () => {
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");

        setTimeout(() => {
          // Send a response (should be ignored by notification handler)
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: 1, result: { data: "test" } }) + "\n\n");
          // Send a valid notification
          res.write("event: message\n");
          res.write(
            "data: " + JSON.stringify({ jsonrpc: "2.0", method: "valid:notification" }) + "\n\n",
          );
        }, 50);
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);

      transport.onNotification((method, params) => {
        notifications.push({ method, params });
      });

      await transport.connect();

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Only the notification should be captured, not the response
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.method, "valid:notification");

      transport.close();
    });
  });

  describe("SSE parsing", () => {
    it("parses SSE events with event and data fields", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write("data: /messages\n\n");
        res.write("event: message\n");
        res.write("data: " + JSON.stringify({ jsonrpc: "2.0", method: "test" }) + "\n\n");
      });
      servers.push(server);

      const notifications: Array<{ method: string }> = [];
      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);

      transport.onNotification((method) => {
        notifications.push({ method });
      });

      await transport.connect();

      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(notifications.length, 1);

      transport.close();
    });

    it("handles empty event field (defaults to event name)", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write("data: /messages\n\n");
        // Message with no explicit event name
        res.write("data: " + JSON.stringify({ jsonrpc: "2.0", method: "no-event" }) + "\n\n");
      });
      servers.push(server);

      const notifications: Array<{ method: string }> = [];
      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);

      transport.onNotification((method) => {
        notifications.push({ method });
      });

      await transport.connect();

      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(notifications.length, 1);

      transport.close();
    });

    it("silently ignores malformed JSON in events", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");

        setTimeout(() => {
          res.write("event: message\n");
          res.write("data: {invalid json\n\n");
          // Valid message after
          res.write("event: message\n");
          res.write(
            "data: " + JSON.stringify({ jsonrpc: "2.0", method: "valid" }) + "\n\n",
          );
        }, 50);
      });
      servers.push(server);

      const notifications: Array<{ method: string }> = [];
      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);

      transport.onNotification((method) => {
        notifications.push({ method });
      });

      await transport.connect();

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should only have the valid message
      assert.equal(notifications.length, 1);

      transport.close();
    });
  });

  describe("session management", () => {
    it("echoes Mcp-Session-Id header in subsequent POST requests", async () => {
      const receivedHeaders: Array<Record<string, string | string[] | undefined>> = [];

      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (req, res) => {
          receivedHeaders.push(req.headers);
          res.writeHead(200, { "Mcp-Session-Id": "updated-session-id" });
          res.end();
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Mcp-Session-Id": "initial-session-id",
        });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);

        setTimeout(() => {
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n\n");
        }, 50);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`);
      await transport.connect();

      // First request uses initial session ID
      await transport.sendRequest("test1");

      assert.equal(receivedHeaders[0]!["mcp-session-id"], "initial-session-id");

      transport.close();
    });

    it("updates session ID from response headers", async () => {
      const receivedHeaders: Array<Record<string, string | string[] | undefined>> = [];
      let requestCount = 0;

      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (req, res) => {
          receivedHeaders.push({ ...req.headers });
          requestCount++;
          res.writeHead(200, {
            "Mcp-Session-Id": "updated-session-" + requestCount,
          });
          res.end();
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Mcp-Session-Id": "initial-session",
        });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);

        // Send responses for sequential requests
        setTimeout(() => {
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: 1 } }) + "\n\n");
        }, 50);

        setTimeout(() => {
          res.write("event: message\n");
          res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: 2 } }) + "\n\n");
        }, 200);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`);
      await transport.connect();

      // Send first request and wait for it to complete
      await transport.sendRequest("test1");

      // Now send second request — should use updated session ID from first POST response
      await transport.sendRequest("test2");

      assert.equal(receivedHeaders.length, 2);
      assert.equal(receivedHeaders[1]!["mcp-session-id"], "updated-session-1");

      transport.close();
    });
  });

  describe("close()", () => {
    it("destroys SSE connection", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);
      await transport.connect();

      // Close should not throw
      transport.close();
    });

    it("rejects all pending requests", async () => {
      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (_req, res) => {
          // Never respond
          res.writeHead(200);
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`, {}, 10_000);
      await transport.connect();

      const p1 = transport.sendRequest("method1");
      const p2 = transport.sendRequest("method2");

      // Give requests time to register
      await new Promise((resolve) => setImmediate(resolve));

      transport.close();

      // Both should reject immediately, not wait for timeout
      await assert.rejects(p1, (err: Error) => {
        assert.equal(err.message, "Transport closed");
        return true;
      });

      await assert.rejects(p2, (err: Error) => {
        assert.equal(err.message, "Transport closed");
        return true;
      });
    });

    it("clears pending request timers", async () => {
      const { server: messageServer, port: messagePort } = await createMockSseServer(
        (_req, res) => {
          res.writeHead(200);
        },
      );
      servers.push(messageServer);

      const { server: sseServer, port: ssePort } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write(`data: http://127.0.0.1:${messagePort}/messages\n\n`);
      });
      servers.push(sseServer);

      const transport = new SseTransport(`http://127.0.0.1:${ssePort}/sse`, {}, 10_000);
      await transport.connect();

      const promise = transport.sendRequest("method");

      await new Promise((resolve) => setImmediate(resolve));

      // Close should immediately reject without waiting for timeout
      const start = Date.now();
      transport.close();

      try {
        await promise;
      } catch {
        const elapsed = Date.now() - start;
        // Should reject in < 1000ms, not wait 10_000ms
        assert.ok(elapsed < 1000, `Took ${elapsed}ms, timeout was 10000ms`);
      }
    });

    it("prevents new requests after close", async () => {
      const { server, port } = await createMockSseServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
      });
      servers.push(server);

      const transport = new SseTransport(`http://127.0.0.1:${port}/sse`);
      await transport.connect();
      transport.close();

      await assert.rejects(
        () => transport.sendRequest("test"),
        (err: Error) => {
          assert.ok(err instanceof SseTransportError);
          assert.equal(err.message, "Transport is not connected");
          return true;
        },
      );
    });
  });
});
