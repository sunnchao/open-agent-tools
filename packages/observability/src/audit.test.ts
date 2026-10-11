import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { captureAuditResponse, redactAuditPayload } from "./audit.js";

test("keeps complete business input and output while redacting credentials", () => {
  const text = "完整的搜索结果\n".repeat(10_000);
  const payload = redactAuditPayload({
    query: "MCP",
    result: { content: [{ type: "text", text }] },
    environment: { TAVILY_API_KEY: "private", CUSTOM_VALUE: "also-private", RETAIN: null },
    rawKey: "mcp.private.secret",
    nested: { password: "password", api_key: "key", authorization: "Bearer token" },
    url: "https://objects.example/package?X-Amz-Signature=signed-secret&part=1",
  });
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("private"));
  assert.ok(!serialized.includes("signed-secret"));
  assert.ok(!serialized.includes('"password":"password"'));
  assert.deepEqual((payload as { result: unknown }).result, { content: [{ type: "text", text }] });
  assert.ok(serialized.includes("part=1"));
});

test("redacts MCP credentials embedded in text and preserves non-secret fields", () => {
  const key = `mcp.89999961-3505-4d12-8be4-4a3386bc7669.${"x".repeat(43)}`;
  assert.equal(redactAuditPayload(`key=${key}`), "key=[REDACTED]");
  assert.deepEqual(redactAuditPayload({ key: { id: "key-id", status: "ACTIVE" }, count: 3 }), {
    key: { id: "key-id", status: "ACTIVE" },
    count: 3,
  });
  assert.deepEqual(
    redactAuditPayload({ content: [{ text: "provider returned service-private-value" }] }, [
      "service-private-value",
    ]),
    {
      content: [{ text: "provider returned [REDACTED]" }],
    },
  );
});

test("captures streamed UTF-8 JSON without changing the HTTP response", async () => {
  let captured: unknown;
  const data = { result: { content: [{ type: "text", text: "你好，完整输出" }] } };
  const bytes = Buffer.from(JSON.stringify(data));
  const split = bytes.indexOf(Buffer.from("你好")) + 1;
  const server = createServer((_request, response) => {
    const body = captureAuditResponse(response);
    response.once("finish", () => {
      captured = body();
    });
    response.setHeader("content-type", "application/json");
    response.write(bytes.subarray(0, split));
    response.end(bytes.subarray(split));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${address.port}`)).json(), data);
    assert.deepEqual(captured, data);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
