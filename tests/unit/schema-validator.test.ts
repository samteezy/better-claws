import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSchema, SchemaValidationError } from "../../src/utils/schema-validator.js";
import type { JsonSchema } from "../../src/types.js";

describe("validateSchema", () => {
  // ── Empty schema ──────────────────────────────────────────────────────────

  describe("empty schema", () => {
    it("allows any value", () => {
      const schema: JsonSchema = {};
      const result = validateSchema("anything", schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("allows null", () => {
      const schema: JsonSchema = {};
      const result = validateSchema(null, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("allows array", () => {
      const schema: JsonSchema = {};
      const result = validateSchema([1, 2, 3], schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("allows object", () => {
      const schema: JsonSchema = {};
      const result = validateSchema({ foo: "bar" }, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });
  });

  // ── Type checking: string ─────────────────────────────────────────────────

  describe("type: string", () => {
    const schema: JsonSchema = { type: "string" };

    it("accepts valid string", () => {
      const result = validateSchema("hello", schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("accepts empty string", () => {
      const result = validateSchema("", schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("rejects number as string", () => {
      const result = validateSchema(42, schema);
      assert.equal(result.valid, false);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0]!, /expected string, got number/);
    });

    it("rejects boolean as string", () => {
      const result = validateSchema(true, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected string, got boolean/);
    });

    it("rejects null as string", () => {
      const result = validateSchema(null, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected string, got null/);
    });

    it("rejects array as string", () => {
      const result = validateSchema([], schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected string, got array/);
    });

    it("rejects object as string", () => {
      const result = validateSchema({}, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected string, got object/);
    });
  });

  // ── Type checking: number ─────────────────────────────────────────────────

  describe("type: number", () => {
    const schema: JsonSchema = { type: "number" };

    it("accepts integer", () => {
      const result = validateSchema(42, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("accepts float", () => {
      const result = validateSchema(3.14, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("accepts negative number", () => {
      const result = validateSchema(-10.5, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("accepts zero", () => {
      const result = validateSchema(0, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("rejects NaN", () => {
      const result = validateSchema(Number.NaN, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected number, got number/);
    });

    it("rejects string as number", () => {
      const result = validateSchema("42", schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected number, got string/);
    });

    it("rejects null as number", () => {
      const result = validateSchema(null, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected number, got null/);
    });
  });

  // ── Type checking: integer ────────────────────────────────────────────────

  describe("type: integer", () => {
    const schema: JsonSchema = { type: "integer" };

    it("accepts positive integer", () => {
      const result = validateSchema(42, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("accepts negative integer", () => {
      const result = validateSchema(-10, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("accepts zero", () => {
      const result = validateSchema(0, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("rejects float", () => {
      const result = validateSchema(3.5, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected integer, got number/);
    });

    it("rejects 3.0 (float representation)", () => {
      const result = validateSchema(3.0, schema);
      assert.equal(result.valid, true);
    });

    it("rejects string as integer", () => {
      const result = validateSchema("42", schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected integer, got string/);
    });

    it("rejects NaN", () => {
      const result = validateSchema(Number.NaN, schema);
      assert.equal(result.valid, false);
    });
  });

  // ── Type checking: boolean ────────────────────────────────────────────────

  describe("type: boolean", () => {
    const schema: JsonSchema = { type: "boolean" };

    it("accepts true", () => {
      const result = validateSchema(true, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("accepts false", () => {
      const result = validateSchema(false, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("rejects number as boolean", () => {
      const result = validateSchema(1, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected boolean, got number/);
    });

    it("rejects string as boolean", () => {
      const result = validateSchema("true", schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected boolean, got string/);
    });

    it("rejects null as boolean", () => {
      const result = validateSchema(null, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected boolean, got null/);
    });
  });

  // ── Type checking: null ───────────────────────────────────────────────────

  describe("type: null", () => {
    const schema: JsonSchema = { type: "null" };

    it("accepts null", () => {
      const result = validateSchema(null, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("rejects string as null", () => {
      const result = validateSchema("null", schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected null, got string/);
    });

    it("rejects number as null", () => {
      const result = validateSchema(0, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected null, got number/);
    });

    it("rejects boolean as null", () => {
      const result = validateSchema(false, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected null, got boolean/);
    });
  });

  // ── Type checking: object ─────────────────────────────────────────────────

  describe("type: object", () => {
    it("accepts plain object", () => {
      const schema: JsonSchema = { type: "object" };
      const result = validateSchema({ foo: "bar" }, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("accepts empty object", () => {
      const schema: JsonSchema = { type: "object" };
      const result = validateSchema({}, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("rejects null as object (typeof null === 'object' edge case)", () => {
      const schema: JsonSchema = { type: "object" };
      const result = validateSchema(null, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected object, got null/);
    });

    it("rejects array as object", () => {
      const schema: JsonSchema = { type: "object" };
      const result = validateSchema([1, 2], schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected object, got array/);
    });

    it("rejects string as object", () => {
      const schema: JsonSchema = { type: "object" };
      const result = validateSchema("not an object", schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected object, got string/);
    });
  });

  // ── Type checking: array ──────────────────────────────────────────────────

  describe("type: array", () => {
    it("accepts empty array", () => {
      const schema: JsonSchema = { type: "array" };
      const result = validateSchema([], schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("accepts array of numbers", () => {
      const schema: JsonSchema = { type: "array" };
      const result = validateSchema([1, 2, 3], schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("accepts array of mixed types", () => {
      const schema: JsonSchema = { type: "array" };
      const result = validateSchema([1, "two", true, null], schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("rejects object as array", () => {
      const schema: JsonSchema = { type: "array" };
      const result = validateSchema({}, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected array, got object/);
    });

    it("rejects null as array", () => {
      const schema: JsonSchema = { type: "array" };
      const result = validateSchema(null, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected array, got null/);
    });

    it("rejects string as array", () => {
      const schema: JsonSchema = { type: "array" };
      const result = validateSchema("not an array", schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected array, got string/);
    });
  });

  // ── Required fields ───────────────────────────────────────────────────────

  describe("required fields", () => {
    it("object with all required fields passes", () => {
      const schema: JsonSchema = {
        type: "object",
        required: ["name", "age"],
      };
      const result = validateSchema({ name: "Alice", age: 30 }, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("object with required field and extras passes", () => {
      const schema: JsonSchema = {
        type: "object",
        required: ["name"],
      };
      const result = validateSchema({ name: "Alice", age: 30, email: "alice@example.com" }, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("object missing required field fails", () => {
      const schema: JsonSchema = {
        type: "object",
        required: ["name", "age"],
      };
      const result = validateSchema({ name: "Alice" }, schema);
      assert.equal(result.valid, false);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0]!, /age: required property missing/);
    });

    it("object missing multiple required fields fails", () => {
      const schema: JsonSchema = {
        type: "object",
        required: ["name", "age", "email"],
      };
      const result = validateSchema({ name: "Alice" }, schema);
      assert.equal(result.valid, false);
      assert.equal(result.errors.length, 2);
      assert.match(result.errors[0]!, /age: required property missing/);
      assert.match(result.errors[1]!, /email: required property missing/);
    });

    it("empty object with required fields fails", () => {
      const schema: JsonSchema = {
        type: "object",
        required: ["name"],
      };
      const result = validateSchema({}, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /name: required property missing/);
    });
  });

  // ── Properties (nested) ───────────────────────────────────────────────────

  describe("properties (nested validation)", () => {
    it("object with valid properties passes", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      };
      const result = validateSchema({ name: "Alice", age: 30 }, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("object with invalid property type fails", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      };
      const result = validateSchema({ name: "Alice", age: "thirty" }, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /age: expected number, got string/);
    });

    it("only validates properties that are defined in schema when additionalProperties: true", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: true,
      };
      const result = validateSchema({ name: "Alice", age: "thirty", extra: true }, schema);
      assert.equal(result.valid, true);
    });

    it("skips properties not present in object", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      };
      const result = validateSchema({ name: "Alice" }, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("includes property path in error message", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
          },
        },
      };
      const result = validateSchema({ user: { name: 42 } }, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /user\.name: expected string, got number/);
    });
  });

  // ── Array items validation ────────────────────────────────────────────────

  describe("array items", () => {
    it("array with valid items passes", () => {
      const schema: JsonSchema = {
        type: "array",
        items: { type: "number" },
      };
      const result = validateSchema([1, 2, 3], schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("array with invalid item fails", () => {
      const schema: JsonSchema = {
        type: "array",
        items: { type: "number" },
      };
      const result = validateSchema([1, "two", 3], schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /\[1\]: expected number, got string/);
    });

    it("array with multiple invalid items reports all errors", () => {
      const schema: JsonSchema = {
        type: "array",
        items: { type: "number" },
      };
      const result = validateSchema([1, "two", "three"], schema);
      assert.equal(result.valid, false);
      assert.equal(result.errors.length, 2);
      assert.match(result.errors[0]!, /\[1\]/);
      assert.match(result.errors[1]!, /\[2\]/);
    });

    it("empty array passes", () => {
      const schema: JsonSchema = {
        type: "array",
        items: { type: "string" },
      };
      const result = validateSchema([], schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("array of objects with property validation", () => {
      const schema: JsonSchema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
          },
        },
      };
      const result = validateSchema([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }], schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("array of objects with invalid nested property", () => {
      const schema: JsonSchema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
          },
        },
      };
      const result = validateSchema(
        [{ id: 1, name: "Alice" }, { id: "two", name: "Bob" }],
        schema
      );
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /\[1\]\.id: expected number, got string/);
    });
  });

  // ── Enum validation ───────────────────────────────────────────────────────

  describe("enum", () => {
    it("value in enum passes", () => {
      const schema: JsonSchema = { enum: ["red", "green", "blue"] };
      const result = validateSchema("red", schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("value not in enum fails", () => {
      const schema: JsonSchema = { enum: ["red", "green", "blue"] };
      const result = validateSchema("yellow", schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /value must be one of/);
    });

    it("enum with numbers", () => {
      const schema: JsonSchema = { enum: [1, 2, 3] };
      const result = validateSchema(2, schema);
      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });

    it("enum with mixed types", () => {
      const schema: JsonSchema = { enum: ["a", 1, true, null] };
      const result = validateSchema(1, schema);
      assert.equal(result.valid, true);
    });

    it("enum with null", () => {
      const schema: JsonSchema = { enum: ["red", null, "blue"] };
      const result = validateSchema(null, schema);
      assert.equal(result.valid, true);
    });

    it("enum with objects (deep equality via JSON stringify)", () => {
      const schema: JsonSchema = { enum: [{ id: 1 }, { id: 2 }] };
      const result = validateSchema({ id: 1 }, schema);
      assert.equal(result.valid, true);
    });

    it("enum with similar but different object fails", () => {
      const schema: JsonSchema = { enum: [{ id: 1, name: "Alice" }] };
      const result = validateSchema({ id: 1 }, schema);
      assert.equal(result.valid, false);
    });

    it("enum error message includes list of allowed values", () => {
      const schema: JsonSchema = { enum: ["red", "green"] };
      const result = validateSchema("blue", schema);
      assert.match(result.errors[0]!, /\[\"red\", \"green\"\]/);
    });

    it("enum with type constraint works together", () => {
      const schema: JsonSchema = { type: "number", enum: [1, 2, 3] };
      const result = validateSchema(2, schema);
      assert.equal(result.valid, true);
    });

    it("enum passes before type check fails (enum is independent)", () => {
      const schema: JsonSchema = { type: "string", enum: ["red", 1, true] };
      const result = validateSchema(1, schema);
      assert.equal(result.valid, false);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0]!, /expected string, got number/);
    });
  });

  // ── Deeply nested validation ──────────────────────────────────────────────

  describe("deeply nested objects", () => {
    it("validates three levels deep", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                properties: {
                  level3: { type: "string" },
                },
              },
            },
          },
        },
      };
      const result = validateSchema(
        { level1: { level2: { level3: "value" } } },
        schema
      );
      assert.equal(result.valid, true);
    });

    it("reports error with full path in deeply nested object", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                properties: {
                  level3: { type: "number" },
                },
              },
            },
          },
        },
      };
      const result = validateSchema(
        { level1: { level2: { level3: "not a number" } } },
        schema
      );
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /level1\.level2\.level3: expected number, got string/);
    });

    it("validates arrays of objects with nested objects", () => {
      const schema: JsonSchema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        },
      };
      const result = validateSchema(
        [{ user: { name: "Alice" } }, { user: { name: "Bob" } }],
        schema
      );
      assert.equal(result.valid, true);
    });

    it("reports path in deeply nested array item", () => {
      const schema: JsonSchema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        },
      };
      const result = validateSchema(
        [{ user: { name: "Alice" } }, { user: { name: 123 } }],
        schema
      );
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /\[1\]\.user\.name: expected string, got number/);
    });
  });

  // ── Extra properties (strict mode) ───────────────────────────────────────────

  describe("extra properties", () => {
    it("rejects properties not in schema by default", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      };
      const result = validateSchema({ name: "Alice", age: 30, email: "alice@example.com" }, schema);
      assert.equal(result.valid, false);
      assert.equal(result.errors.length, 2);
      assert.match(result.errors[0]!, /unexpected property/);
    });

    it("rejects extra properties even with valid declared properties", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      };
      const result = validateSchema({ name: "Alice", age: "thirty" }, schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /unexpected property/);
    });

    it("allows properties not in schema when additionalProperties: true", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: true,
      };
      const result = validateSchema({ name: "Alice", age: 30, email: "alice@example.com" }, schema);
      assert.equal(result.valid, true);
    });

    it("only validates declared properties, extra properties allowed when additionalProperties: true", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: true,
      };
      const result = validateSchema({ name: "Alice", age: "thirty", extra: true }, schema);
      assert.equal(result.valid, true);
    });

    it("rejects object with only extra properties (no declared properties present)", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      };
      const result = validateSchema({ age: 30, email: "alice@example.com" }, schema);
      assert.equal(result.valid, false);
      assert.equal(result.errors.length, 2);
    });
  });

  // ── Unknown type strictness ───────────────────────────────────────────────────

  describe("unknown type", () => {
    it("rejects unknown type string (not a standard JSON Schema type)", () => {
      const schema: JsonSchema = { type: "foobar" as never };
      const result = validateSchema("any value", schema);
      assert.equal(result.valid, false);
      assert.match(result.errors[0]!, /expected foobar/);
    });

    it("rejects unknown type even for null", () => {
      const schema: JsonSchema = { type: "unknowntype" as never };
      const result = validateSchema(null, schema);
      assert.equal(result.valid, false);
    });

    it("rejects unknown type for any value type", () => {
      const schema: JsonSchema = { type: "custom" as never };
      const result = validateSchema({ key: "value" }, schema);
      assert.equal(result.valid, false);
    });

    it("rejects unknown type even with no other constraints", () => {
      const schema: JsonSchema = { type: "invalidtype" as never };
      const result = validateSchema(42, schema);
      assert.equal(result.valid, false);
    });
  });

  // ── Combined constraints ──────────────────────────────────────────────────

  describe("combined constraints", () => {
    it("object with required fields and property validation", () => {
      const schema: JsonSchema = {
        type: "object",
        required: ["name", "email"],
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          age: { type: "number" },
        },
      };
      const result = validateSchema({ name: "Alice", email: "alice@example.com", age: 30 }, schema);
      assert.equal(result.valid, true);
    });

    it("reports both missing required and type errors", () => {
      const schema: JsonSchema = {
        type: "object",
        required: ["name", "email"],
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          age: { type: "number" },
        },
      };
      const result = validateSchema({ name: "Alice", age: "thirty" }, schema);
      assert.equal(result.valid, false);
      assert.equal(result.errors.length, 2);
      assert.match(result.errors[0]!, /email: required property missing/);
      assert.match(result.errors[1]!, /age: expected number, got string/);
    });

    it("array of objects with required properties", () => {
      const schema: JsonSchema = {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "number" },
            name: { type: "string" },
          },
        },
      };
      const result = validateSchema(
        [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }],
        schema
      );
      assert.equal(result.valid, true);
    });

    it("collects all validation errors from array of objects", () => {
      const schema: JsonSchema = {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "number" },
            name: { type: "string" },
          },
        },
      };
      const result = validateSchema(
        [
          { id: 1, name: "Alice" },
          { id: "two", name: 123 },
          { id: 3 },
        ],
        schema
      );
      assert.equal(result.valid, false);
      assert.equal(result.errors.length, 3);
      assert.match(result.errors[0]!, /\[1\]\.id: expected number, got string/);
      assert.match(result.errors[1]!, /\[1\]\.name: expected string, got number/);
      assert.match(result.errors[2]!, /\[2\]\.name: required property missing/);
    });
  });

  // ── Error message format ──────────────────────────────────────────────────

  describe("error message format", () => {
    it("root level error uses 'root' as path", () => {
      const schema: JsonSchema = { type: "string" };
      const result = validateSchema(42, schema);
      assert.match(result.errors[0]!, /^root: /);
    });

    it("single-level property uses property name", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      };
      const result = validateSchema({ name: 42 }, schema);
      assert.match(result.errors[0]!, /^name: /);
    });

    it("nested property includes dots", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
          },
        },
      };
      const result = validateSchema({ user: { name: 42 } }, schema);
      assert.match(result.errors[0]!, /^user\.name: /);
    });

    it("array item includes bracket notation", () => {
      const schema: JsonSchema = {
        type: "array",
        items: { type: "number" },
      };
      const result = validateSchema(["not a number"], schema);
      assert.match(result.errors[0]!, /^\[0\]: /);
    });
  });
});

describe("SchemaValidationError", () => {
  it("is a BetterClawsError subclass", () => {
    const error = new SchemaValidationError("test", []);
    assert(error instanceof Error);
    assert.equal(error.name, "SchemaValidationError");
  });

  it("stores errors array", () => {
    const errors = ["error1", "error2"];
    const error = new SchemaValidationError("message", errors);
    assert.deepEqual(error.errors, errors);
  });

  it("errors property returns the same array reference", () => {
    const errorsArray = ["error1"];
    const error = new SchemaValidationError("message", errorsArray);
    assert.deepEqual(error.errors, errorsArray);
    assert.equal(error.errors, errorsArray);
  });
});
