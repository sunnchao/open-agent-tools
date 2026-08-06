import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { logTrace, logDuration, maskSecret, truncate } from "./trace.js";

describe("trace 工具", () => {
  const originalLog = console.log;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("truncate:短字符串原样返回", () => {
    assert.equal(truncate("hello", 200), "hello");
    assert.equal(truncate("hello", 5), "hello");
  });

  test("truncate:超长字符串截断并标注省略长度", () => {
    const result = truncate("a".repeat(500), 100) as string;
    assert.ok(result.startsWith("a".repeat(100)));
    assert.match(result, /\(\+400 chars\)/);
  });

  test("truncate:非字符串原样返回", () => {
    assert.equal(truncate(42), 42);
    assert.equal(truncate(null), null);
  });

  test("maskSecret:长凭据只保留首尾", () => {
    assert.equal(maskSecret("mcp.abc.def123"), "mcp.***23");
  });

  test("maskSecret:短值全部遮蔽", () => {
    assert.equal(maskSecret("short"), "***");
  });

  test("logTrace:输出统一前缀与事件名", () => {
    logTrace("test.event", { key: "value" });
    assert.equal(lines.length, 1);
    const line = lines[0] ?? "";
    assert.match(line, /^\[\d{4}-\d{2}-\d{2}T.*\] \[trace:info\] test\.event \{"key":"value"\}$/);
  });

  test("logTrace:error 级别前缀正确", () => {
    logTrace("test.fail", { reason: "boom" }, "error");
    const line = lines[0] ?? "";
    assert.match(line, /\[trace:error\] test\.fail/);
  });

  test("logDuration:附带 durationMs 字段", () => {
    logDuration("test.duration", Date.now() - 12);
    const line = lines[0] ?? "";
    assert.match(line, /test\.duration \{"durationMs":12\}/);
  });
});
