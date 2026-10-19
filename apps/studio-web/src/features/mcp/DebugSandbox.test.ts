import { describe, expect, it, vi } from "vitest";
import {
  buildToolCallRequest,
  parseArgumentsJson,
  resolveGatewayEndpoint,
  sendGatewayRequest,
  serializeRequest,
  validateToolArguments,
} from "./DebugSandbox.js";

const TOOL_SCHEMA = {
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    query: { type: "string" },
    limit: { type: "integer" },
    mode: { type: "string", enum: ["fast", "exact"] },
  },
};

describe("sandbox argument parsing", () => {
  it("treats blank input as empty arguments", () => {
    expect(parseArgumentsJson("")).toEqual({ ok: true, value: {} });
    expect(parseArgumentsJson("   ")).toEqual({ ok: true, value: {} });
  });

  it("rejects invalid JSON and non-object payloads", () => {
    expect(parseArgumentsJson("{")).toMatchObject({ ok: false });
    expect(parseArgumentsJson("[1, 2]")).toEqual({ ok: false, error: "参数必须是 JSON 对象" });
    expect(parseArgumentsJson('"text"')).toEqual({ ok: false, error: "参数必须是 JSON 对象" });
  });

  it("parses a JSON object payload", () => {
    expect(parseArgumentsJson('{"query":"MCP","limit":3}')).toEqual({
      ok: true,
      value: { query: "MCP", limit: 3 },
    });
  });
});

describe("tool argument validation", () => {
  it("accepts arguments matching the declared input schema", () => {
    expect(validateToolArguments(TOOL_SCHEMA, { query: "MCP", limit: 5, mode: "fast" })).toEqual(
      [],
    );
  });

  it("flags missing required arguments and type or enum mismatches", () => {
    expect(validateToolArguments(TOOL_SCHEMA, {})).toEqual(["缺少必填参数:query"]);
    expect(validateToolArguments(TOOL_SCHEMA, { query: "MCP", limit: 1.5 })).toEqual([
      "limit 必须是整数",
    ]);
    expect(validateToolArguments(TOOL_SCHEMA, { query: 7 })).toEqual(["query 必须是字符串"]);
    expect(validateToolArguments(TOOL_SCHEMA, { query: "MCP", mode: "slow" })).toEqual([
      'mode 必须是以下之一:"fast", "exact"',
    ]);
  });

  it("rejects undeclared arguments when additionalProperties is false", () => {
    expect(validateToolArguments(TOOL_SCHEMA, { query: "MCP", token: "x" })).toEqual([
      "未声明的参数:token",
    ]);
  });

  it("tolerates missing or open schemas", () => {
    expect(validateToolArguments(undefined, { anything: true })).toEqual([]);
    expect(validateToolArguments({ type: "object" }, { anything: true })).toEqual([]);
    expect(validateToolArguments(TOOL_SCHEMA, "not-an-object")).toEqual(["参数必须是 JSON 对象"]);
  });
});

describe("JSON-RPC request construction", () => {
  it("builds and serializes a tools/call body", () => {
    const request = buildToolCallRequest({
      id: 7,
      toolName: "query",
      arguments: { query: "MCP" },
    });
    expect(request).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "query", arguments: { query: "MCP" } },
    });
    expect(JSON.parse(serializeRequest(request))).toEqual(request);
  });
});

describe("gateway endpoint resolution", () => {
  it("appends the service path and normalizes trailing slashes", () => {
    expect(resolveGatewayEndpoint("http://localhost:4100", "report tools")).toBe(
      "http://localhost:4100/mcp/services/report%20tools",
    );
    expect(resolveGatewayEndpoint("https://gateway.example.com/", "search")).toBe(
      "https://gateway.example.com/mcp/services/search",
    );
    expect(resolveGatewayEndpoint("https://gateway.example.com/prefix/", "search")).toBe(
      "https://gateway.example.com/prefix/mcp/services/search",
    );
  });

  it("rejects blank, malformed and non-http addresses", () => {
    expect(() => resolveGatewayEndpoint("   ", "search")).toThrow("请输入 Gateway 地址");
    expect(() => resolveGatewayEndpoint("not a url", "search")).toThrow("不是合法的 URL");
    expect(() => resolveGatewayEndpoint("ftp://gateway.example.com", "search")).toThrow(
      "必须以 http:// 或 https:// 开头",
    );
  });
});

describe("gateway request sending", () => {
  function clock(values: number[]): () => number {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)]!;
  }

  it("POSTs the JSON-RPC body with a Bearer key and reports timing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], isError: false } }),
    });

    const outcome = await sendGatewayRequest({
      endpoint: "http://localhost:4100/mcp/services/search",
      apiKey: "  mcp.secret  ",
      payload: '{"jsonrpc":"2.0"}',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock([1_000, 1_042]),
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:4100/mcp/services/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer mcp.secret",
      },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(outcome).toMatchObject({ ok: true, status: 200, durationMs: 42, error: null });
    expect(outcome.json).toMatchObject({ result: { isError: false } });
  });

  it("keeps the raw body for JSON-RPC and HTTP errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }),
    });

    const outcome = await sendGatewayRequest({
      endpoint: "http://localhost:4100/mcp/services/search",
      apiKey: "mcp.secret",
      payload: "{}",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 0,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(401);
    expect(outcome.bodyText).toContain("UNAUTHORIZED");
  });

  it("reports network failures without throwing and requires a key", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const outcome = await sendGatewayRequest({
      endpoint: "http://localhost:4100/mcp/services/search",
      apiKey: "mcp.secret",
      payload: "{}",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 0,
    });
    expect(outcome).toMatchObject({ ok: false, status: 0, bodyText: "", error: "fetch failed" });

    await expect(
      sendGatewayRequest({ endpoint: "http://x", apiKey: "   ", payload: "{}" }),
    ).rejects.toThrow("请输入客户端 API Key");
  });
});
