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
