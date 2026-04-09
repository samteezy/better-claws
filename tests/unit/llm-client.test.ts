import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSSEStream } from "../../src/llm/llm-client.js";
import type { LlmStreamChunk } from "../../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a ReadableStream from SSE text data.
 */
function sseStream(data: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

/**
 * Collects all chunks from an async generator into an array.
 */
async function collectChunks(
  gen: AsyncGenerator<LlmStreamChunk>,
): Promise<LlmStreamChunk[]> {
  const chunks: LlmStreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("parseSSEStream", () => {
  describe("basic text streaming", () => {
    it("parses multiple text delta chunks", async () => {
      const sseData = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: " " } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 4);
      assert.equal(chunks[0]?.delta, "Hello");
      assert.equal(chunks[0]?.done, false);
      assert.equal(chunks[1]?.delta, " ");
      assert.equal(chunks[1]?.done, false);
      assert.equal(chunks[2]?.delta, "world");
      assert.equal(chunks[2]?.done, false);
      assert.equal(chunks[3]?.delta, "");
      assert.equal(chunks[3]?.done, true);
    });

    it("handles empty content in delta", async () => {
      const sseData = `data: ${JSON.stringify({ choices: [{ delta: { content: "" } }] })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 2);
      assert.equal(chunks[0]?.delta, "");
      assert.equal(chunks[0]?.done, false);
    });

    it("handles null content in delta", async () => {
      const sseData = `data: ${JSON.stringify({ choices: [{ delta: { content: null } }] })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 2);
      assert.equal(chunks[0]?.delta, "");
      assert.equal(chunks[0]?.done, false);
    });

    it("handles missing content in delta", async () => {
      const sseData = `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 2);
      assert.equal(chunks[0]?.delta, "");
      assert.equal(chunks[0]?.done, false);
    });
  });

  describe("[DONE] signal", () => {
    it("stops parsing at [DONE]", async () => {
      const sseData = `data: ${JSON.stringify({ choices: [{ delta: { content: "start" } }] })}\n\ndata: [DONE]\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: "ignored" } }] })}\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 2);
      assert.equal(chunks[0]?.delta, "start");
      assert.equal(chunks[1]?.delta, "");
      assert.equal(chunks[1]?.done, true);
    });

    it("yields done chunk when [DONE] is encountered", async () => {
      const sseData = `data: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 1);
      assert.equal(chunks[0]?.delta, "");
      assert.equal(chunks[0]?.done, true);
    });
  });

  describe("single tool call delta", () => {
    it("parses tool call at index 0", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_123",
              type: "function",
              function: { name: "get_weather", arguments: '{"city"' },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 2);
      assert.deepEqual(chunks[0]?.toolCallDeltas, [
        {
          index: 0,
          id: "call_123",
          type: "function",
          function: { name: "get_weather", arguments: '{"city"' },
        },
      ]);
      assert.equal(chunks[0]?.delta, "");
      assert.equal(chunks[0]?.done, false);
    });

    it("preserves index field for single tool call", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "tool_1",
              type: "function",
              function: { name: "test_fn" },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));
      const delta = chunks[0]?.toolCallDeltas?.[0];

      assert.equal(delta?.index, 0);
    });

    it("handles tool call with partial function name", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: "get_" },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));
      const delta = chunks[0]?.toolCallDeltas?.[0];

      assert.equal(delta?.function?.name, "get_");
    });

    it("handles tool call with only arguments fragment", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"' },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));
      const delta = chunks[0]?.toolCallDeltas?.[0];

      assert.equal(delta?.function?.arguments, '{"');
    });
  });

  describe("multiple parallel tool call deltas", () => {
    it("parses multiple tool calls in same chunk at different indices", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                type: "function",
                function: { name: "search", arguments: '{"q":"' },
              },
              {
                index: 1,
                id: "call_b",
                type: "function",
                function: { name: "calc", arguments: '{"x":' },
              },
            ],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 2);
      assert.equal(chunks[0]?.toolCallDeltas?.length, 2);

      const delta0 = chunks[0]?.toolCallDeltas?.[0];
      assert.equal(delta0?.index, 0);
      assert.equal(delta0?.id, "call_a");
      assert.equal(delta0?.function?.name, "search");

      const delta1 = chunks[0]?.toolCallDeltas?.[1];
      assert.equal(delta1?.index, 1);
      assert.equal(delta1?.id, "call_b");
      assert.equal(delta1?.function?.name, "calc");
    });

    it("preserves index field for all tool calls", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: "a" } },
              { index: 1, function: { arguments: "b" } },
              { index: 2, function: { arguments: "c" } },
            ],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));
      const deltas = chunks[0]?.toolCallDeltas;

      assert.equal(deltas?.[0]?.index, 0);
      assert.equal(deltas?.[1]?.index, 1);
      assert.equal(deltas?.[2]?.index, 2);
    });

    it("includes text delta alongside tool call deltas", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "Processing...",
            tool_calls: [
              { index: 0, function: { name: "fn1" } },
              { index: 1, function: { name: "fn2" } },
            ],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.delta, "Processing...");
      assert.equal(chunks[0]?.toolCallDeltas?.length, 2);
    });
  });

  describe("tool call argument fragments across chunks", () => {
    it("accumulates arguments over multiple chunks for same index", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"' },
            }],
          },
        }],
      })}\n\ndata: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: 'city":' },
            }],
          },
        }],
      })}\n\ndata: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '"NYC"}' },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 4);
      // Each chunk yields independently (the client would accumulate)
      assert.equal(chunks[0]?.toolCallDeltas?.[0]?.function?.arguments, '{"');
      assert.equal(chunks[1]?.toolCallDeltas?.[0]?.function?.arguments, 'city":');
      assert.equal(chunks[2]?.toolCallDeltas?.[0]?.function?.arguments, '"NYC"}');
    });

    it("handles name fragments before arguments for same index", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_x",
              type: "function",
              function: { name: "get_" },
            }],
          },
        }],
      })}\n\ndata: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: "weather" },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 3);
      assert.equal(chunks[0]?.toolCallDeltas?.[0]?.function?.name, "get_");
      assert.equal(chunks[1]?.toolCallDeltas?.[0]?.function?.name, "weather");
    });

    it("handles multiple indices with arguments accumulating separately", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '{"a"' } },
              { index: 1, function: { arguments: '{"b"' } },
            ],
          },
        }],
      })}\n\ndata: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: ':1}' } },
              { index: 1, function: { arguments: ':2}' } },
            ],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      // First chunk has both tools with first fragments
      assert.equal(chunks[0]?.toolCallDeltas?.[0]?.function?.arguments, '{"a"');
      assert.equal(chunks[0]?.toolCallDeltas?.[1]?.function?.arguments, '{"b"');

      // Second chunk has both tools with continuation fragments
      assert.equal(chunks[1]?.toolCallDeltas?.[0]?.function?.arguments, ':1}');
      assert.equal(chunks[1]?.toolCallDeltas?.[1]?.function?.arguments, ':2}');
    });
  });

  describe("mixed text and tool call deltas", () => {
    it("yields both text and tool calls in same chunk", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "Calling function...",
            tool_calls: [{
              index: 0,
              id: "call_123",
              type: "function",
              function: { name: "execute", arguments: '{}' },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 2);
      assert.equal(chunks[0]?.delta, "Calling function...");
      assert.equal(chunks[0]?.toolCallDeltas?.length, 1);
      assert.equal(chunks[0]?.toolCallDeltas?.[0]?.function?.name, "execute");
    });

    it("yields text delta, then tool calls in separate chunks", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { content: "Processing" },
        }],
      })}\n\ndata: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              type: "function",
              function: { name: "process" },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 3);
      assert.equal(chunks[0]?.delta, "Processing");
      assert.equal(chunks[0]?.toolCallDeltas, undefined);
      assert.equal(chunks[1]?.toolCallDeltas?.length, 1);
    });

    it("handles text followed by multiple tool calls", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { content: "Using tools" },
        }],
      })}\n\ndata: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, function: { name: "tool1" } },
              { index: 1, function: { name: "tool2" } },
              { index: 2, function: { name: "tool3" } },
            ],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 3);
      assert.equal(chunks[0]?.delta, "Using tools");
      assert.equal(chunks[1]?.toolCallDeltas?.length, 3);
      for (let i = 0; i < 3; i++) {
        assert.equal(chunks[1]?.toolCallDeltas?.[i]?.index, i);
      }
    });
  });

  describe("edge cases and malformed input", () => {
    it("skips invalid JSON in SSE data", async () => {
      const sseData = `data: {invalid json}\n\ndata: ${JSON.stringify({
        choices: [{
          delta: { content: "valid" },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 2);
      assert.equal(chunks[0]?.delta, "valid");
    });

    it("skips chunks with no choices", async () => {
      const sseData = `data: ${JSON.stringify({})}\n\ndata: ${JSON.stringify({
        choices: [{
          delta: { content: "has choices" },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 2);
      assert.equal(chunks[0]?.delta, "has choices");
    });

    it("skips chunks with no delta", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{ message: { content: "no delta" } }],
      })}\n\ndata: ${JSON.stringify({
        choices: [{
          delta: { content: "has delta" },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 2);
      assert.equal(chunks[0]?.delta, "has delta");
    });

    it("handles lines not starting with data:", async () => {
      const sseData = `comment: this is ignored\ndata: ${JSON.stringify({
        choices: [{
          delta: { content: "processed" },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 2);
      assert.equal(chunks[0]?.delta, "processed");
    });

    it("handles finish_reason null as done=false", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { content: "text" },
          finish_reason: null,
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.done, false);
    });

    it("handles finish_reason undefined as done=false", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { content: "text" },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.done, false);
    });

    it("handles finish_reason=stop as done=true", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { content: "text" },
          finish_reason: "stop",
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.done, true);
    });
  });

  describe("optional tool call fields", () => {
    it("omits optional id when not present", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              type: "function",
              function: { name: "fn" },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));
      const delta = chunks[0]?.toolCallDeltas?.[0];

      assert.equal(delta?.id, undefined);
      assert.equal(delta?.type, "function");
    });

    it("omits optional type when not present", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              function: { name: "fn" },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));
      const delta = chunks[0]?.toolCallDeltas?.[0];

      assert.equal(delta?.type, undefined);
      assert.equal(delta?.id, "call_1");
    });

    it("omits optional function when not present", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));
      const delta = chunks[0]?.toolCallDeltas?.[0];

      assert.equal(delta?.function, undefined);
      assert.equal(delta?.id, "call_1");
    });

    it("omits optional function.name when not present", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: "{}" },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));
      const delta = chunks[0]?.toolCallDeltas?.[0];

      assert.equal(delta?.function?.name, undefined);
      assert.equal(delta?.function?.arguments, "{}");
    });

    it("omits optional function.arguments when not present", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: "fn" },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));
      const delta = chunks[0]?.toolCallDeltas?.[0];

      assert.equal(delta?.function?.arguments, undefined);
      assert.equal(delta?.function?.name, "fn");
    });
  });

  describe("empty and whitespace handling", () => {
    it("handles empty tool_calls array", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "text",
            tool_calls: [],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.delta, "text");
      assert.equal(chunks[0]?.toolCallDeltas, undefined);
    });

    it("handles extra whitespace around data lines", async () => {
      const sseData = `data:   ${JSON.stringify({
        choices: [{
          delta: { content: "spaced" },
        }],
      })}   \n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.delta, "spaced");
    });

    it("handles multiple newlines between chunks", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { content: "first" },
        }],
      })}\n\n\n\ndata: ${JSON.stringify({
        choices: [{
          delta: { content: "second" },
        }],
      })}\n\n\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 3);
      assert.equal(chunks[0]?.delta, "first");
      assert.equal(chunks[1]?.delta, "second");
    });
  });

  describe("done flag behavior", () => {
    it("sets done=false for regular chunks", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { content: "text" },
          finish_reason: null,
        }],
      })}\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.done, false);
    });

    it("sets done=true when finish_reason is a string", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { content: "final" },
          finish_reason: "length",
        }],
      })}\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.done, true);
    });

    it("sets done=true for [DONE] chunk", async () => {
      const sseData = `data: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.done, true);
    });
  });

  describe("reasoning delta extraction", () => {
    it("populates reasoningDelta from delta.reasoning field", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { reasoning: "Let me think about this..." },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.reasoningDelta, "Let me think about this...");
      assert.equal(chunks[0]?.delta, "");
      assert.equal(chunks[0]?.done, false);
    });

    it("populates reasoningDelta from delta.reasoning_content field", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { reasoning_content: "Considering the options..." },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.reasoningDelta, "Considering the options...");
      assert.equal(chunks[0]?.delta, "");
      assert.equal(chunks[0]?.done, false);
    });

    it("prefers delta.reasoning over delta.reasoning_content", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            reasoning: "Primary reasoning",
            reasoning_content: "Fallback reasoning",
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.reasoningDelta, "Primary reasoning");
    });

    it("accumulates reasoning across multiple chunks", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { reasoning: "First part " },
        }],
      })}\n\ndata: ${JSON.stringify({
        choices: [{
          delta: { reasoning: "second part " },
        }],
      })}\n\ndata: ${JSON.stringify({
        choices: [{
          delta: { reasoning: "third part" },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks.length, 4);
      assert.equal(chunks[0]?.reasoningDelta, "First part ");
      assert.equal(chunks[1]?.reasoningDelta, "second part ");
      assert.equal(chunks[2]?.reasoningDelta, "third part");
    });

    it("omits reasoningDelta when reasoning is not present", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { content: "Just text" },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.reasoningDelta, undefined);
      assert.equal(chunks[0]?.delta, "Just text");
    });

    it("handles null reasoning as absent", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { content: "text", reasoning: null },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.reasoningDelta, undefined);
      assert.equal(chunks[0]?.delta, "text");
    });

    it("emits reasoning and text delta in same chunk", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            reasoning: "Thinking...",
            content: "Response text",
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.reasoningDelta, "Thinking...");
      assert.equal(chunks[0]?.delta, "Response text");
      assert.equal(chunks[0]?.done, false);
    });

    it("emits reasoning and tool call deltas together", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: {
            reasoning: "I need to call a tool",
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{"q":"' },
            }],
          },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      assert.equal(chunks[0]?.reasoningDelta, "I need to call a tool");
      assert.equal(chunks[0]?.toolCallDeltas?.length, 1);
      assert.equal(chunks[0]?.toolCallDeltas?.[0]?.function?.name, "search");
      assert.equal(chunks[0]?.delta, "");
    });

    it("handles empty reasoning string", async () => {
      const sseData = `data: ${JSON.stringify({
        choices: [{
          delta: { reasoning: "" },
        }],
      })}\n\ndata: [DONE]\n\n`;

      const chunks = await collectChunks(parseSSEStream(sseStream(sseData)));

      // Empty string reasoning is treated as absent (falsy), so reasoningDelta is undefined
      assert.equal(chunks[0]?.reasoningDelta, undefined);
      assert.equal(chunks[0]?.done, false);
    });
  });
});
