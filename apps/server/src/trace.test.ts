import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { logTrace, logDuration, logDebug, logDebugDuration, maskSecret, truncate } from "./trace.js";

describe("trace 工具", () => {
  const originalLog = console.log;
  const originalDebugEnv = process.env.DEBUG;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    if (originalDebugEnv === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebugEnv;
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

  test("logDebug:未设置 DEBUG 时静默", () => {
    delete process.env.DEBUG;
    logDebug("test.debug.event", { key: "value" });
    assert.equal(lines.length, 0);
  });

  test("logDebug:DEBUG=true 时输出 debug 级别日志", () => {
    process.env.DEBUG = "true";
    logDebug("test.debug.event", { key: "value" });
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /\[trace:debug\] test\.debug\.event \{"key":"value"\}/);
  });

  test("logDebug:DEBUG=1 同样视为开启", () => {
    process.env.DEBUG = "1";
    logDebug("test.debug.event");
    assert.equal(lines.length, 1);
  });

  test("logDebugDuration:DEBUG=true 时附带 durationMs", () => {
    process.env.DEBUG = "true";
    logDebugDuration("test.debug.duration", Date.now() - 12, { stage: "sql" });
    const line = lines[0] ?? "";
    assert.match(line, /\[trace:debug\] test\.debug\.duration \{"stage":"sql","durationMs":12\}/);
  });

  test("logDebugDuration:未设置 DEBUG 时静默", () => {
    delete process.env.DEBUG;
    logDebugDuration("test.debug.duration", Date.now() - 12);
    assert.equal(lines.length, 0);
  });

  test("truncate:DEBUG=true 时不截断,原样返回完整字符串", () => {
    process.env.DEBUG = "true";
    const result = truncate("a".repeat(500), 100);
    assert.equal(result, "a".repeat(500));
  });

  test("maskSecret:DEBUG=true 时不脱敏,原样返回", () => {
    process.env.DEBUG = "true";
    assert.equal(maskSecret("mcp.abc.def123"), "mcp.abc.def123");
  });
});
