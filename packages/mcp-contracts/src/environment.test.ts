import assert from "node:assert/strict";
import test from "node:test";
import { ToolEnvironmentSchema, ToolEnvironmentUpdateSchema } from "./environment.js";

test("accepts Tool environment values and masked updates without trimming values", () => {
  const environment = {
    TAVILY_API_KEY: " secret=token ",
    EMPTY: "",
    _lower: "line\nvalue",
    NODE_ENV: "production",
  };
  assert.deepEqual(ToolEnvironmentSchema.parse(environment), environment);
  assert.deepEqual(ToolEnvironmentUpdateSchema.parse({ TAVILY_API_KEY: null }), {
    TAVILY_API_KEY: null,
  });
  assert.equal(ToolEnvironmentSchema.safeParse({ TAVILY_API_KEY: null }).success, false);
});

test("rejects invalid names, runtime overrides and null bytes", () => {
  for (const name of [
    "1KEY",
    "BAD-NAME",
    "A=B",
    "PATH",
    "HOME",
    "MCP_TOOL_INPUT",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_LIBRARY_PATH",
  ]) {
    assert.equal(ToolEnvironmentSchema.safeParse({ [name]: "secret" }).success, false, name);
  }
  assert.equal(ToolEnvironmentSchema.safeParse({ KEY: "secret\0suffix" }).success, false);
  assert.equal(ToolEnvironmentSchema.safeParse({ KEY: 123 }).success, false);
});

test("bounds environment count, individual values and total UTF-8 size", () => {
  assert.equal(
    ToolEnvironmentSchema.safeParse(
      Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`KEY_${index}`, ""])),
    ).success,
    false,
  );
  assert.equal(ToolEnvironmentSchema.safeParse({ KEY: "x".repeat(8193) }).success, false);
  assert.equal(
    ToolEnvironmentSchema.safeParse(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [`KEY_${index}`, "\u4e2d".repeat(3000)]),
      ),
    ).success,
    false,
  );
});
