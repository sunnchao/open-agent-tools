import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHttpError, requestJson } from "./http.js";

test("HTTP 错误保留字符串和对象消息，非 JSON 响应使用状态码", async () => {
  for (const [body, expected] of [
    ['{"error":"denied"}', "denied"],
    ['{"error":{"message":"denied"}}', "denied"],
    ["null", "HTTP 502"],
    ["<html>bad gateway</html>", "HTTP 502"],
  ]) {
    assert.equal(await parseHttpError(new Response(body, { status: 502 })), expected);
  }
});

test("JSON 请求保留 transport、headers、body、signal，兼容 204 和请求失败", async () => {
  const init = {
    method: "POST",
    headers: { authorization: "token" },
    body: "{}",
    signal: new AbortController().signal,
  };
  const transport = async (path: string, forwarded?: RequestInit) => {
    assert.equal(path, "/api/example");
    assert.equal(forwarded, init);
    return Response.json({ ok: true });
  };
  assert.deepEqual(await requestJson(transport, "/api/example", init), { ok: true });
  assert.equal(
    await requestJson(async () => new Response(null, { status: 204 }), "/api/example"),
    undefined,
  );
  await assert.rejects(
    requestJson(
      async () => Response.json({ error: { message: "forbidden" } }, { status: 403 }),
      "/api/example",
    ),
    /forbidden/,
  );
});
