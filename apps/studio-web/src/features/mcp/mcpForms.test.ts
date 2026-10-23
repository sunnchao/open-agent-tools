import { describe, expect, it } from "vitest";
import { coerceValue, collectRemoteInput, parseHeadersJson } from "./mcpForms.js";

describe("MCP form conversion", () => {
  it("coerces supported tool argument schema types", () => {
    expect(coerceValue("12.5", "number")).toBe(12.5);
    expect(coerceValue("false", "boolean")).toBe(false);
    expect(coerceValue('{"a":1}', "object")).toEqual({ a: 1 });
    expect(coerceValue("[1,2]", "array")).toEqual([1, 2]);
    expect(coerceValue("anything", "null")).toBeNull();
    expect(coerceValue("text", "string")).toBe("text");
    expect(() => coerceValue("NaN", "integer")).toThrow("无法");
    expect(() => coerceValue("yes", "boolean")).toThrow("true");
    expect(() => coerceValue("{", "object")).toThrow("对象");
  });

  it("parses headers strictly and omits optional empty fields", () => {
    expect(parseHeadersJson('{"x-tenant":"acme"}')).toEqual({ "x-tenant": "acme" });
    expect(() => parseHeadersJson("[]")).toThrow("JSON 对象");
    expect(() => parseHeadersJson('{"x":1}')).toThrow("须为字符串");
    expect(
      collectRemoteInput({
        transport: "sse",
        url: " https://example.com/mcp ",
        headersText: "",
        token: "",
      }),
    ).toEqual({
      transport: "sse",
      url: "https://example.com/mcp",
      timeoutMs: 30_000,
    });
    expect(
      collectRemoteInput({
        transport: "streamable-http",
        url: "https://example.com/mcp",
        timeoutMs: "5000",
        headersText: '{"authorization":"secret"}',
        token: "token",
      }),
    ).toEqual({
      transport: "streamable-http",
      url: "https://example.com/mcp",
      timeoutMs: 5000,
      headers: { authorization: "secret" },
      token: "token",
    });
  });
});
