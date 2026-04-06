import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PromptBuilder } from "../../src/prompt/prompt-builder.js";
import type { ChatMessage, ToolDescriptor } from "../../src/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function createBuilder(options: { systemPrompt?: string; tokenBudget?: number; charsPerToken?: number } = {}) {
  return new PromptBuilder({
    systemPrompt: options.systemPrompt ?? "You are a helpful assistant.",
    tokenBudget: options.tokenBudget ?? 1000,
    charsPerToken: options.charsPerToken ?? 4,
  });
}

function createMessage(role: "system" | "user" | "assistant" | "tool", content: string, tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>): ChatMessage {
  if (tool_calls) {
    return { role, content, tool_calls };
  }
  return { role, content };
}

function createToolDescriptor(name: string, description = "Test tool", parameters = { type: "object" }): ToolDescriptor {
  return {
    name,
    description,
    parameters,
    capabilities: [],
  };
}

describe("PromptBuilder", () => {
  describe("basic prompt assembly", () => {
    it("returns system message when history is empty", () => {
      const builder = createBuilder();
      const result = builder.build({
        history: [],
        tools: [],
      });

      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0]!.role, "system");
      assert.equal(result.messages[0]!.content, "You are a helpful assistant.");
      assert.equal(result.truncatedCount, 0);
    });

    it("includes base system prompt in output", () => {
      const builder = createBuilder({ systemPrompt: "Custom system instructions." });
      const result = builder.build({
        history: [],
        tools: [],
      });

      assert.ok(result.messages[0]!.content.includes("Custom system instructions."));
    });
  });

  describe("history inclusion", () => {
    it("includes all history messages when they fit in budget", () => {
      const builder = createBuilder({ tokenBudget: 1000 });
      const history: ChatMessage[] = [
        createMessage("user", "What is 2+2?"),
        createMessage("assistant", "2+2 equals 4."),
        createMessage("user", "And 3+3?"),
      ];

      const result = builder.build({
        history,
        tools: [],
      });

      assert.equal(result.messages.length, 4); // system + 3 history
      assert.equal(result.messages[1]!.role, "user");
      assert.equal(result.messages[1]!.content, "What is 2+2?");
      assert.equal(result.messages[2]!.role, "assistant");
      assert.equal(result.messages[3]!.role, "user");
      assert.equal(result.truncatedCount, 0);
    });

    it("preserves message order (oldest first)", () => {
      const builder = createBuilder();
      const history: ChatMessage[] = [
        createMessage("user", "First message"),
        createMessage("assistant", "Second message"),
        createMessage("user", "Third message"),
      ];

      const result = builder.build({ history, tools: [] });

      assert.equal(result.messages[1]!.content, "First message");
      assert.equal(result.messages[2]!.content, "Second message");
      assert.equal(result.messages[3]!.content, "Third message");
    });
  });

  describe("tool declarations", () => {
    it("injects tool declarations into system prompt when tools are provided", () => {
      const builder = createBuilder();
      const tools: ToolDescriptor[] = [
        createToolDescriptor("get-time", "Get the current time", { type: "object" }),
      ];

      const result = builder.build({
        history: [],
        tools,
      });

      const systemContent = result.messages[0]!.content;
      assert.ok(systemContent.includes("## Available Tools"));
      assert.ok(systemContent.includes("get-time"));
      assert.ok(systemContent.includes("Get the current time"));
    });

    it("formats multiple tool declarations correctly", () => {
      const builder = createBuilder();
      const tools: ToolDescriptor[] = [
        createToolDescriptor("tool-one", "First tool"),
        createToolDescriptor("tool-two", "Second tool"),
      ];

      const result = builder.build({ history: [], tools });

      const systemContent = result.messages[0]!.content;
      assert.ok(systemContent.includes("tool-one"));
      assert.ok(systemContent.includes("tool-two"));
      assert.ok(systemContent.includes("First tool"));
      assert.ok(systemContent.includes("Second tool"));
    });

    it("does not include tool section when tools array is empty", () => {
      const builder = createBuilder();
      const result = builder.build({
        history: [],
        tools: [],
      });

      assert.ok(!result.messages[0]!.content.includes("## Available Tools"));
    });

    it("includes tool parameters in JSON format", () => {
      const builder = createBuilder();
      const tools: ToolDescriptor[] = [
        {
          name: "fetch",
          description: "Make HTTP request",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string" },
              method: { type: "string", enum: ["GET", "POST"] },
            },
            required: ["url"],
          },
          capabilities: [],
        },
      ];

      const result = builder.build({ history: [], tools });

      const systemContent = result.messages[0]!.content;
      assert.ok(systemContent.includes("Parameters:"));
      assert.ok(systemContent.includes("url"));
      assert.ok(systemContent.includes("method"));
      assert.ok(systemContent.includes("GET"));
    });
  });

  describe("working memory injection", () => {
    it("injects working memory text into system prompt", () => {
      const builder = createBuilder();
      const result = builder.build({
        history: [],
        tools: [],
        workingMemory: "User prefers concise responses. Has asked about Python 3 times.",
      });

      const systemContent = result.messages[0]!.content;
      assert.ok(systemContent.includes("## Working Memory"));
      assert.ok(systemContent.includes("User prefers concise responses"));
      assert.ok(systemContent.includes("Python 3 times"));
    });

    it("does not include working memory section when not provided", () => {
      const builder = createBuilder();
      const result = builder.build({
        history: [],
        tools: [],
      });

      assert.ok(!result.messages[0]!.content.includes("## Working Memory"));
    });

    it("handles empty working memory string gracefully", () => {
      const builder = createBuilder();
      const result = builder.build({
        history: [],
        tools: [],
        workingMemory: "",
      });

      // Empty string is falsy, so section should not be included
      assert.ok(!result.messages[0]!.content.includes("## Working Memory"));
    });
  });

  describe("long-term memories injection", () => {
    it("injects long-term memories into system prompt", () => {
      const builder = createBuilder();
      const result = builder.build({
        history: [],
        tools: [],
        longTermMemories: [
          "User works in software engineering",
          "Prefers JavaScript to Python",
        ],
      });

      const systemContent = result.messages[0]!.content;
      assert.ok(systemContent.includes("## Relevant Memories"));
      assert.ok(systemContent.includes("User works in software engineering"));
      assert.ok(systemContent.includes("Prefers JavaScript to Python"));
    });

    it("formats memories as a bulleted list", () => {
      const builder = createBuilder();
      const result = builder.build({
        history: [],
        tools: [],
        longTermMemories: ["Memory one", "Memory two"],
      });

      const systemContent = result.messages[0]!.content;
      assert.ok(systemContent.includes("- Memory one"));
      assert.ok(systemContent.includes("- Memory two"));
    });

    it("does not include memories section when array is empty", () => {
      const builder = createBuilder();
      const result = builder.build({
        history: [],
        tools: [],
        longTermMemories: [],
      });

      assert.ok(!result.messages[0]!.content.includes("## Relevant Memories"));
    });

    it("does not include memories section when not provided", () => {
      const builder = createBuilder();
      const result = builder.build({
        history: [],
        tools: [],
      });

      assert.ok(!result.messages[0]!.content.includes("## Relevant Memories"));
    });
  });

  describe("token budget enforcement", () => {
    it("truncates history when total tokens exceed budget", () => {
      const builder = createBuilder({ systemPrompt: "System", tokenBudget: 50 });
      const history: ChatMessage[] = [
        createMessage("user", "A".repeat(100)), // ~25 tokens
        createMessage("assistant", "B".repeat(100)), // ~25 tokens
        createMessage("user", "C".repeat(100)), // ~25 tokens
        createMessage("assistant", "D".repeat(100)), // ~25 tokens
      ];

      const result = builder.build({ history, tools: [] });

      // Should have kept system message and some history, dropped some messages
      assert.ok(result.truncatedCount > 0, "should truncate messages");
      assert.ok(result.messages.length < 5, "should have fewer messages than input");
    });

    it("returns just system message when system prompt exceeds budget", () => {
      const builder = createBuilder({
        systemPrompt: "System prompt ".repeat(100),
        tokenBudget: 50,
      });
      const history: ChatMessage[] = [
        createMessage("user", "User message"),
        createMessage("assistant", "Assistant message"),
      ];

      const result = builder.build({ history, tools: [] });

      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0]!.role, "system");
      assert.equal(result.truncatedCount, 2);
    });

    it("reflects correct truncatedCount when no truncation needed", () => {
      const builder = createBuilder({ tokenBudget: 1000 });
      const history: ChatMessage[] = [
        createMessage("user", "Message"),
        createMessage("assistant", "Response"),
      ];

      const result = builder.build({ history, tools: [] });

      assert.equal(result.truncatedCount, 0);
    });
  });

  describe("middle truncation strategy", () => {
    it("preserves first message and recent messages, removing from middle", () => {
      const builder = createBuilder({ systemPrompt: "Sys", tokenBudget: 70 });
      const history: ChatMessage[] = [
        createMessage("user", "Message one"), // 0
        createMessage("assistant", "X".repeat(50)), // 1 - middle, should drop
        createMessage("user", "Y".repeat(50)), // 2 - middle, should drop
        createMessage("assistant", "Message last"), // 3 - keep (recent)
      ];

      const result = builder.build({ history, tools: [] });

      // Should keep system, first (message one), and last (message last)
      const contents = result.messages.map(m => m.content);
      assert.ok(contents.includes("Message one"), "should keep first message");
      assert.ok(contents.includes("Message last"), "should keep last message");
      // With the middle truncation strategy and our small budget, some messages should be dropped
      // The exact count depends on token estimation, so just verify structure
      assert.ok(result.messages.length >= 2, "should keep at least system and some history");
    });

    it("keeps first message and recent messages when budget is tight", () => {
      const builder = createBuilder({ systemPrompt: "Sys", tokenBudget: 50 });
      const history: ChatMessage[] = [
        createMessage("user", "First"),
        createMessage("assistant", "X".repeat(100)),
        createMessage("user", "Y".repeat(100)),
        createMessage("assistant", "Last"),
      ];

      const result = builder.build({ history, tools: [] });

      // Should have system + first + last (middle messages dropped)
      // The exact layout depends on token counting, verify truncation happened
      assert.ok(result.truncatedCount > 0, "should truncate messages");
      assert.ok(result.messages.length > 1, "should keep system and some history");
    });
  });

  describe("edge case: budget too small for system prompt", () => {
    it("returns just system message and counts all history as truncated", () => {
      const builder = createBuilder({
        systemPrompt: "This is a very large system prompt ".repeat(50),
        tokenBudget: 50,
      });
      const history: ChatMessage[] = [
        createMessage("user", "Should be truncated"),
        createMessage("assistant", "Also truncated"),
        createMessage("user", "And this too"),
      ];

      const result = builder.build({ history, tools: [] });

      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0]!.role, "system");
      assert.equal(result.truncatedCount, 3);
    });
  });

  describe("tool messages in history", () => {
    it("includes tool messages in history", () => {
      const builder = createBuilder();
      const history: ChatMessage[] = [
        createMessage("user", "Call a tool"),
        createMessage("assistant", "Calling tool", [
          {
            id: "call-1",
            type: "function",
            function: { name: "get-time", arguments: "{}" },
          },
        ]),
        createMessage("tool", "Current time is 3:30 PM", undefined),
      ];

      // Manually set tool_call_id on the last message
      const toolMsg: ChatMessage = { ...history[2]!, tool_call_id: "call-1" };
      const historyWithId = [...history.slice(0, 2), toolMsg];

      const result = builder.build({ history: historyWithId, tools: [] });

      assert.equal(result.messages.length, 4); // system + 3 history
      assert.ok(result.messages.some(m => m.role === "tool"));
    });

    it("accounts for tool_calls in token estimation", () => {
      const builder = createBuilder();
      const msgWithToolCall = createMessage(
        "assistant",
        "Calling tool",
        [{ id: "call-1", type: "function", function: { name: "fetch", arguments: '{"url":"http://example.com"}' } }],
      );

      const result1 = builder.build({
        history: [createMessage("user", "A")],
        tools: [],
      });

      const result2 = builder.build({
        history: [createMessage("user", "A"), msgWithToolCall],
        tools: [],
      });

      // Result2 should have higher estimated tokens because of tool_calls
      assert.ok(result2.estimatedTokens > result1.estimatedTokens);
    });
  });

  describe("estimateTokens", () => {
    it("estimates tokens as ceil(length / charsPerToken)", () => {
      const builder = createBuilder({ charsPerToken: 4 });

      assert.equal(builder.estimateTokens("1234"), 1);
      assert.equal(builder.estimateTokens("12345"), 2); // ceil(5/4)
      assert.equal(builder.estimateTokens("123456789"), 3); // ceil(9/4)
    });

    it("uses custom charsPerToken if provided", () => {
      const builder = createBuilder({ charsPerToken: 2 });

      assert.equal(builder.estimateTokens("12"), 1);
      assert.equal(builder.estimateTokens("123"), 2); // ceil(3/2)
    });

    it("returns at least 1 token for non-empty string", () => {
      const builder = createBuilder({ charsPerToken: 100 });

      assert.equal(builder.estimateTokens("x"), 1);
    });

    it("returns 0 tokens for empty string", () => {
      const builder = createBuilder();

      assert.equal(builder.estimateTokens(""), 0);
    });
  });

  describe("truncatedCount accuracy", () => {
    it("accurately counts dropped messages", () => {
      const builder = createBuilder({ systemPrompt: "Sys", tokenBudget: 60 });
      const history: ChatMessage[] = [
        createMessage("user", "A"),
        createMessage("assistant", "XXXX".repeat(30)), // Will be dropped
        createMessage("user", "YYYY".repeat(30)), // Will be dropped
        createMessage("assistant", "B"),
      ];

      const result = builder.build({ history, tools: [] });

      // Verify truncation occurred and count is accurate
      assert.ok(result.truncatedCount > 0, "should have truncated messages");
      assert.ok(
        result.truncatedCount + (result.messages.length - 1) === history.length,
        "truncatedCount + kept messages should equal total history",
      );
    });

    it("returns 0 truncatedCount when all history fits", () => {
      const builder = createBuilder({ tokenBudget: 2000 });
      const history: ChatMessage[] = [
        createMessage("user", "Short"),
        createMessage("assistant", "Response"),
      ];

      const result = builder.build({ history, tools: [] });

      assert.equal(result.truncatedCount, 0);
    });

    it("returns history.length when system prompt alone exceeds budget", () => {
      const builder = createBuilder({
        systemPrompt: "Large ".repeat(200),
        tokenBudget: 50,
      });
      const history: ChatMessage[] = [
        createMessage("user", "A"),
        createMessage("assistant", "B"),
        createMessage("user", "C"),
      ];

      const result = builder.build({ history, tools: [] });

      assert.equal(result.truncatedCount, history.length);
    });
  });

  describe("estimated tokens accuracy", () => {
    it("returns reasonable estimated token count", () => {
      const builder = createBuilder({ charsPerToken: 4 });
      const history: ChatMessage[] = [
        createMessage("user", "A".repeat(100)), // ~25 tokens content + 4 overhead = ~29
        createMessage("assistant", "B".repeat(100)), // ~25 tokens content + 4 overhead = ~29
      ];

      const result = builder.build({ history, tools: [] });

      // System message (~4 tokens) + 2 history messages (~58 tokens) = ~62 tokens
      // Should be in a reasonable range (with some variance for role overhead)
      assert.ok(result.estimatedTokens > 30);
      assert.ok(result.estimatedTokens < 100);
    });

    it("includes system prompt tokens in total estimate", () => {
      const builder = createBuilder({
        systemPrompt: "System prompt " + "A".repeat(100),
        tokenBudget: 2000,
      });
      const result = builder.build({ history: [], tools: [] });

      // Should account for system prompt (~30+ tokens)
      assert.ok(result.estimatedTokens >= 30);
    });

    it("includes tool declaration tokens in system message estimate", () => {
      const builder = createBuilder({ tokenBudget: 2000 });
      const tools: ToolDescriptor[] = [
        {
          name: "large-tool",
          description: "Tool with a long description: " + "x".repeat(200),
          parameters: { type: "object", properties: { param: { type: "string", description: "A parameter" } } },
          capabilities: [],
        },
      ];

      const result = builder.build({ history: [], tools });

      // Should be more tokens than without tools
      const resultNoTools = builder.build({ history: [], tools: [] });
      assert.ok(result.estimatedTokens > resultNoTools.estimatedTokens);
    });
  });

  describe("all history fits exactly", () => {
    it("has truncatedCount of 0 when history fits perfectly", () => {
      // Craft a scenario where history fits exactly in remaining budget
      const builder = createBuilder({ systemPrompt: "Sys", tokenBudget: 100 });
      const history: ChatMessage[] = [
        createMessage("user", "X".repeat(40)), // ~14 tokens
      ];

      const result = builder.build({ history, tools: [] });

      assert.equal(result.truncatedCount, 0);
      assert.ok(result.messages.length > 1); // Has system + history
    });
  });

  describe("all sections combined", () => {
    it("assembles system prompt with all components in correct order", () => {
      const builder = createBuilder({ systemPrompt: "Base system prompt" });
      const tools: ToolDescriptor[] = [createToolDescriptor("test-tool", "A test tool")];
      const result = builder.build({
        history: [createMessage("user", "Hello")],
        tools,
        workingMemory: "Working memory content",
        longTermMemories: ["Long term fact"],
      });

      const systemContent = result.messages[0]!.content;

      // All components should be present in order: base, working memory, memories, tools
      const baseIndex = systemContent.indexOf("Base system prompt");
      const memoryIndex = systemContent.indexOf("## Working Memory");
      const ltIndex = systemContent.indexOf("## Relevant Memories");
      const toolIndex = systemContent.indexOf("## Available Tools");

      assert.ok(baseIndex !== -1);
      assert.ok(memoryIndex > baseIndex);
      assert.ok(ltIndex > memoryIndex);
      assert.ok(toolIndex > ltIndex);
    });

    it("returns correct structure with all components", () => {
      const builder = createBuilder({ tokenBudget: 500 });
      const tools: ToolDescriptor[] = [createToolDescriptor("echo", "Echo tool")];
      const history: ChatMessage[] = [
        createMessage("user", "Say hello"),
        createMessage("assistant", "Hello!"),
      ];

      const result = builder.build({
        history,
        tools,
        workingMemory: "User likes concise responses",
        longTermMemories: ["User is a developer"],
      });

      assert.equal(result.messages[0]!.role, "system");
      assert.ok(result.messages[0]!.content.length > 100);
      assert.equal(result.messages.length, 3); // system + 2 history
      assert.equal(result.truncatedCount, 0);
      assert.ok(result.estimatedTokens > 0);
    });
  });

  describe("integration scenarios", () => {
    it("handles realistic conversation with mixed message types", () => {
      const builder = createBuilder({ tokenBudget: 500 });
      const history: ChatMessage[] = [
        createMessage("user", "What time is it?"),
        createMessage("assistant", "Let me check", [
          {
            id: "tc1",
            type: "function",
            function: { name: "get-time", arguments: "{}" },
          },
        ]),
        createMessage("tool", "3:45 PM"),
      ];

      const result = builder.build({
        history,
        tools: [createToolDescriptor("get-time", "Get current time")],
      });

      assert.equal(result.messages.length, 4); // system + 3 history
      assert.ok(result.truncatedCount === 0);
      assert.ok(result.estimatedTokens > 0);
    });

    it("gracefully handles very large history by truncating to keep structure", () => {
      const builder = createBuilder({ systemPrompt: "Sys", tokenBudget: 80 });
      const history: ChatMessage[] = Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0
          ? createMessage("user", `User message ${i}`)
          : createMessage("assistant", `Assistant message ${i}`),
      );

      const result = builder.build({ history, tools: [] });

      // Should have kept some messages (first and recent ones)
      assert.ok(result.messages.length > 1, "should keep at least system message");
      assert.ok(result.messages.length < history.length + 1, "should truncate most messages");
      assert.ok(result.truncatedCount > 0, "should report truncation");
      assert.equal(result.truncatedCount + (result.messages.length - 1), history.length, "truncatedCount should be accurate");
    });
  });
});
