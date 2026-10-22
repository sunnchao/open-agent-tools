import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { askChat, parseChatSseEvent } from "./chatClient.js";
import { chunkText } from "./text.js";

describe("parseChatSseEvent", () => {
  it("parses delta frames", () => {
    assert.deepEqual(parseChatSseEvent('data: {"delta":"你好"}'), { delta: "你好" });
  });

  it("parses error frames", () => {
    assert.deepEqual(parseChatSseEvent('data: {"error":"provider unavailable"}'), {
      error: "provider unavailable",
    });
  });

  it("ignores non-data and malformed frames", () => {
    assert.equal(parseChatSseEvent(": keep-alive"), null);
    assert.equal(parseChatSseEvent(""), null);
    assert.equal(parseChatSseEvent("data: not-json"), null);
    assert.equal(parseChatSseEvent('data: {"foo":1}'), null);
  });
});

describe("askChat", () => {
  let server: Server;
  let baseUrl = "";
  let received: unknown;

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received = JSON.parse(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ delta: "回答" })}\n\n`);
        res.write(`data: ${JSON.stringify({ delta: "来自" })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            tool_call: { name: "rag", arguments: "{}" },
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ delta: "知识库" })}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server.close();
  });

  it("collects deltas across frames and posts bound RAG resources", async () => {
    const answer = await askChat({
      baseUrl,
      question: "知识库里有吗",
      sessionId: "feishu:oc_test",
      sources: ["company-handbook"],
      topK: 3,
    });
    assert.equal(answer.content, "回答来自知识库");
    assert.deepEqual(received, {
      messages: [{ role: "user", content: "知识库里有吗" }],
      sessionId: "feishu:oc_test",
      resources: { rag: { sources: ["company-handbook"], topK: 3 } },
    });
  });

  it("passes bound SQL sources through resources.sqlSources", async () => {
    await askChat({
      baseUrl,
      question: "上个月订单量",
      sessionId: "dingtalk:cid_1",
      sources: ["company-handbook"],
      topK: 3,
      sqlSources: ["source_a", "source_b"],
    });
    assert.deepEqual(received, {
      messages: [{ role: "user", content: "上个月订单量" }],
      sessionId: "dingtalk:cid_1",
      resources: {
        rag: { sources: ["company-handbook"], topK: 3 },
        sqlSources: ["source_a", "source_b"],
      },
    });
  });

  it("omits resources.sqlSources when the list is empty", async () => {
    await askChat({
      baseUrl,
      question: "hi",
      sessionId: "feishu:oc_test",
      sources: [],
      topK: 5,
      sqlSources: [],
    });
    assert.deepEqual(received, {
      messages: [{ role: "user", content: "hi" }],
      sessionId: "feishu:oc_test",
      resources: { rag: { sources: [], topK: 5 } },
    });
  });

  it("passes bound MCP tools through resources.mcpTools", async () => {
    await askChat({
      baseUrl,
      question: "查一下文档",
      sessionId: "dingtalk:cid_2",
      sources: [],
      topK: 5,
      mcpTools: [
        { serviceSlug: "docs", toolName: "search" },
        { serviceSlug: "docs", toolName: "search" },
      ],
    });
    assert.deepEqual(received, {
      messages: [{ role: "user", content: "查一下文档" }],
      sessionId: "dingtalk:cid_2",
      resources: {
        rag: { sources: [], topK: 5 },
        mcpTools: [{ serviceSlug: "docs", toolName: "search" }],
      },
    });
  });

  it("degrades by dropping an unavailable MCP tool and retrying", async () => {
    const bodies: unknown[] = [];
    let call = 0;
    const flaky = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        bodies.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (call === 0) {
          call += 1;
          res.write(
            `data: ${JSON.stringify({ error: "MCP Tool is unavailable: docs/search" })}\n\n`,
          );
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ delta: "降级回答" })}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
    const addr = flaky.address();
    assert.ok(addr && typeof addr === "object");
    try {
      const answer = await askChat({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        question: "查一下文档",
        sessionId: "dingtalk:cid_3",
        sources: [],
        topK: 5,
        mcpTools: [
          { serviceSlug: "docs", toolName: "search" },
          { serviceSlug: "other", toolName: "ping" },
        ],
      });
      assert.equal(answer.content, "降级回答");
      assert.equal(bodies.length, 2);
      // 第二次请求已摘掉失效工具，只保留仍可用的绑定。
      assert.deepEqual((bodies[0] as { resources: { mcpTools: unknown } }).resources.mcpTools, [
        { serviceSlug: "docs", toolName: "search" },
        { serviceSlug: "other", toolName: "ping" },
      ]);
      assert.deepEqual((bodies[1] as { resources: { mcpTools: unknown } }).resources.mcpTools, [
        { serviceSlug: "other", toolName: "ping" },
      ]);
    } finally {
      flaky.close();
    }
  });

  it("throws when the server returns an error frame", async () => {
    const failing = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ error: "default provider is unavailable" })}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const addr = failing.address();
    assert.ok(addr && typeof addr === "object");
    try {
      await askChat({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        question: "hi",
        sessionId: "feishu:oc_test",
        sources: [],
        topK: 5,
      });
      assert.fail("expected askChat to throw");
    } catch (error) {
      assert.match(String(error), /provider is unavailable/);
    } finally {
      failing.close();
    }
  });

  it("sends the workspace and IM source headers", async () => {
    const headers: Record<string, string | undefined> = {};
    const headerServer = createServer((req, res) => {
      headers["x-workspace-id"] = req.headers["x-workspace-id"] as string | undefined;
      headers["x-im-channel"] = req.headers["x-im-channel"] as string | undefined;
      headers["x-im-actor"] = req.headers["x-im-actor"] as string | undefined;
      headers["x-im-chat-type"] = req.headers["x-im-chat-type"] as string | undefined;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ delta: "好" })}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) => headerServer.listen(0, "127.0.0.1", resolve));
    const addr = headerServer.address();
    assert.ok(addr && typeof addr === "object");
    try {
      await askChat({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        question: "hi",
        sessionId: "dingtalk:cid:u:staff_1",
        sources: [],
        topK: 5,
        workspaceId: "ws_a",
        im: { channelId: "chan_1", actor: "staff_1", chatType: "p2p" },
      });
      assert.equal(headers["x-workspace-id"], "ws_a");
      assert.equal(headers["x-im-channel"], "chan_1");
      assert.equal(headers["x-im-actor"], "staff_1");
      assert.equal(headers["x-im-chat-type"], "p2p");
    } finally {
      headerServer.close();
    }
  });

  it("omits the IM headers when the request is not an IM request", async () => {
    const headers: Record<string, string | undefined> = {};
    const headerServer = createServer((req, res) => {
      headers["x-workspace-id"] = req.headers["x-workspace-id"] as string | undefined;
      headers["x-im-channel"] = req.headers["x-im-channel"] as string | undefined;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end();
    });
    await new Promise<void>((resolve) => headerServer.listen(0, "127.0.0.1", resolve));
    const addr = headerServer.address();
    assert.ok(addr && typeof addr === "object");
    try {
      await askChat({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        question: "hi",
        sessionId: "s1",
        sources: [],
        topK: 5,
      });
      assert.equal(headers["x-workspace-id"], undefined);
      assert.equal(headers["x-im-channel"], undefined);
    } finally {
      headerServer.close();
    }
  });
});

describe("askChat tool and citation accounting", () => {
  it("collects tool calls, tool results and citations from the SSE stream", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ tool_call: { id: "c1", name: "rag" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ tool_result: { id: "c1", name: "rag" } })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ rag_citations: [{ source: "a" }, { source: "b" }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ delta: "答案" })}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    try {
      const answer = await askChat({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        question: "hi",
        sessionId: "s1",
        sources: [],
        topK: 5,
      });
      assert.equal(answer.content, "答案");
      assert.deepEqual(answer.toolCalls, ["rag"]);
      assert.equal(answer.toolResultCount, 1);
      assert.equal(answer.citations, 2);
    } finally {
      server.close();
    }
  });
});

describe("chunkText", () => {
  it("keeps short text as a single chunk", () => {
    assert.deepEqual(chunkText("你好"), ["你好"]);
  });

  it("splits long text at line breaks first", () => {
    const long = "第一段很长很长的内容" + "字".repeat(2000) + "\n第二段";
    const chunks = chunkText(long, 100);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 100));
  });

  it("splits at sentence boundaries when no newline", () => {
    const text = "句一内容。句二内容。句三内容。".repeat(50);
    const chunks = chunkText(text, 40);
    assert.ok(chunks.every((chunk) => chunk.length <= 40));
  });

  it("returns empty for blank input", () => {
    assert.deepEqual(chunkText("   "), []);
  });
});
