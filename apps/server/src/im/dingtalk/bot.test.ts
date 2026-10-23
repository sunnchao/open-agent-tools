import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { ImConfig } from "../types.js";
import { startDingTalkBot, type DingTalkStreamLike } from "./bot.js";
import type { DingTalkStreamClientOptions } from "./streamClient.js";
import { closeDb } from "../../db.js";
import { listImChatAudits } from "../audit.js";

interface ReplyRecord {
  path: string;
  contentType: string | undefined;
  body: { msgtype?: string; text?: { content?: string } };
}

let server: Server;
let webhookUrl = "";
let received: ReplyRecord[] = [];
let replyHandler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
};

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      received.push({
        path: req.url ?? "",
        contentType: req.headers["content-type"],
        body: JSON.parse(raw) as ReplyRecord["body"],
      });
      replyHandler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  webhookUrl = `http://127.0.0.1:${address.port}/robot/sendBySession?session=abc`;
});

after(() => {
  server.close();
});

function config(overrides: Partial<ImConfig> = {}): ImConfig {
  return {
    name: "钉钉测试",
    platform: "dingtalk",
    appId: "client_1",
    appSecret: "secret_1",
    ragSources: ["handbook"],
    ragTopK: 4,
    sqlSources: ["source_1"],
    mcpTools: [],
    requireMention: true,
    chatBaseUrl: "http://127.0.0.1:1",
    ...overrides,
  };
}

/** 可注入的假 Stream 客户端：connect 直接成功，并把 options 暴露给测试。 */
function makeFakeStream(): {
  create: (options: DingTalkStreamClientOptions) => DingTalkStreamLike;
  getOptions: () => DingTalkStreamClientOptions | undefined;
  disconnects: () => number;
} {
  let options: DingTalkStreamClientOptions | undefined;
  let disconnects = 0;
  let connected = false;
  return {
    create: (next) => {
      options = next;
      connected = true;
      return {
        connect: async () => {
          connected = true;
        },
        disconnect: () => {
          disconnects += 1;
          connected = false;
        },
        isConnected: () => connected,
        getLastError: () => undefined,
      };
    },
    getOptions: () => options,
    disconnects: () => disconnects,
  };
}

function textEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: "cid_1",
    conversationType: "2",
    msgId: "msg_1",
    senderStaffId: "staff_1",
    senderNick: "张三",
    msgtype: "text",
    text: { content: "@机器人 你好" },
    isInAtList: true,
    sessionWebhook: webhookUrl,
    sessionWebhookExpiredTime: Date.now() + 60_000,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dingtalk-audit-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  closeDb();
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SQLITE_PATH;
});

describe("startDingTalkBot", () => {
  it("asks chat with bound RAG + SQL sources and replies via sessionWebhook", async () => {
    received = [];
    const stream = makeFakeStream();
    const calls: unknown[] = [];
    const handle = await startDingTalkBot(config(), {
      createStreamClient: stream.create,
      askChat: async (params) => {
        const { onProgress: _onProgress, ...rest } = params;
        calls.push(rest);
        return { content: "回答内容", toolCalls: [], toolResultCount: 0, citations: 0 };
      },
    });

    assert.equal(handle.status().connected, true);
    const options = stream.getOptions();
    assert.equal(options?.clientId, "client_1");
    assert.equal(options?.clientSecret, "secret_1");
    assert.ok(options?.onMessage);

    await options.onMessage(textEvent());
    await flush();

    assert.deepEqual(calls, [
      {
        baseUrl: "http://127.0.0.1:1",
        question: "你好",
        sessionId: "dingtalk:cid_1",
        sources: ["handbook"],
        topK: 4,
        sqlSources: ["source_1"],
        mcpTools: [],
        im: { actor: "staff_1", chatType: "group" },
      },
    ]);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.contentType, "application/json");
    assert.deepEqual(received[0]!.body, { msgtype: "text", text: { content: "回答内容" } });
    handle.stop();
    assert.equal(stream.disconnects(), 1);
  });

  it("passes bound MCP tools to chat", async () => {
    received = [];
    const stream = makeFakeStream();
    const calls: unknown[] = [];
    const handle = await startDingTalkBot(
      config({ mcpTools: [{ serviceSlug: "docs", toolName: "search" }] }),
      {
        createStreamClient: stream.create,
        askChat: async (params) => {
          calls.push(params);
          return { content: "工具回答", toolCalls: [], toolResultCount: 0, citations: 0 };
        },
      },
    );

    await stream.getOptions()!.onMessage!(textEvent());
    await flush();

    assert.equal((calls[0] as { mcpTools: unknown[] }).mcpTools.length, 1);
    assert.deepEqual((calls[0] as { mcpTools: unknown }).mcpTools, [
      { serviceSlug: "docs", toolName: "search" },
    ]);
    handle.stop();
  });

  it("splits long answers into multiple webhook messages", async () => {
    received = [];
    const stream = makeFakeStream();
    const long = `${"A".repeat(1600)}\n${"B".repeat(1600)}`;
    const handle = await startDingTalkBot(config(), {
      createStreamClient: stream.create,
      askChat: async () => ({ content: long, toolCalls: [], toolResultCount: 0, citations: 0 }),
    });
    await stream.getOptions()!.onMessage!(textEvent());
    await flush();

    assert.ok(received.length >= 2);
    assert.ok(received.every((item) => (item.body.text?.content ?? "").length <= 1500));
    assert.ok(received.map((item) => item.body.text?.content).join("") === long.replace("\n", ""));
    handle.stop();
  });

  it("ignores non-text messages", async () => {
    received = [];
    let asked = 0;
    const stream = makeFakeStream();
    const handle = await startDingTalkBot(config(), {
      createStreamClient: stream.create,
      askChat: async () => {
        asked += 1;
        return { content: "x", toolCalls: [], toolResultCount: 0, citations: 0 };
      },
    });
    await stream.getOptions()!.onMessage!(textEvent({ msgtype: "picture" }));
    await flush();
    assert.equal(asked, 0);
    assert.equal(received.length, 0);
    handle.stop();
  });

  it("requires a mention in group chats when configured", async () => {
    received = [];
    let asked = 0;
    const stream = makeFakeStream();
    const handle = await startDingTalkBot(config({ requireMention: true }), {
      createStreamClient: stream.create,
      askChat: async () => {
        asked += 1;
        return { content: "x", toolCalls: [], toolResultCount: 0, citations: 0 };
      },
    });
    await stream.getOptions()!.onMessage!(textEvent({ isInAtList: false, atUsers: [] }));
    await flush();
    assert.equal(asked, 0, "unmentioned group message must be ignored");
    handle.stop();
  });

  it("replies to p2p messages without a mention", async () => {
    received = [];
    let asked = 0;
    const stream = makeFakeStream();
    const handle = await startDingTalkBot(config({ requireMention: true }), {
      createStreamClient: stream.create,
      askChat: async () => {
        asked += 1;
        return { content: "私聊回答", toolCalls: [], toolResultCount: 0, citations: 0 };
      },
    });
    await stream.getOptions()!.onMessage!(
      textEvent({
        conversationType: "1",
        isInAtList: false,
        atUsers: [],
        text: { content: "你好" },
      }),
    );
    await flush();
    assert.equal(asked, 1);
    assert.equal(received[0]!.body.text?.content, "私聊回答");
    handle.stop();
  });

  it("reports chat failures back to the user", async () => {
    received = [];
    const stream = makeFakeStream();
    const handle = await startDingTalkBot(config(), {
      createStreamClient: stream.create,
      askChat: async () => {
        throw new Error("provider unavailable");
      },
    });
    await stream.getOptions()!.onMessage!(textEvent());
    await flush();
    assert.equal(received.length, 1);
    assert.match(received[0]!.body.text?.content ?? "", /抱歉，处理失败：provider unavailable/);
    handle.stop();
  });

  it("logs and skips replies when sessionWebhook is missing or expired", async () => {
    received = [];
    const stream = makeFakeStream();
    const handle = await startDingTalkBot(config(), {
      createStreamClient: stream.create,
      askChat: async () => ({ content: "回答", toolCalls: [], toolResultCount: 0, citations: 0 }),
    });
    await stream.getOptions()!.onMessage!(textEvent({ sessionWebhook: undefined }));
    await stream.getOptions()!.onMessage!(
      textEvent({ sessionWebhookExpiredTime: Date.now() - 1000 }),
    );
    await flush();
    assert.equal(received.length, 0);
    handle.stop();
  });

  it("treats a non-zero webhook errcode as a failed reply without throwing", async () => {
    received = [];
    replyHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errcode: 310000, errmsg: "invalid webhook" }));
    };
    try {
      const stream = makeFakeStream();
      const handle = await startDingTalkBot(config(), {
        createStreamClient: stream.create,
        askChat: async () => ({ content: "回答", toolCalls: [], toolResultCount: 0, citations: 0 }),
      });
      await stream.getOptions()!.onMessage!(textEvent());
      await flush();
      assert.equal(received.length, 1);
      handle.stop();
    } finally {
      replyHandler = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
      };
    }
  });

  it("surfaces the initial connect error in status()", async () => {
    const failing = {
      connect: async () => {
        throw new Error("gateway down");
      },
      disconnect: () => undefined,
      isConnected: () => false,
      getLastError: () => "gateway down",
    };
    const handle = await startDingTalkBot(config(), {
      createStreamClient: () => failing,
      askChat: async () => ({ content: "", toolCalls: [], toolResultCount: 0, citations: 0 }),
    });
    assert.equal(handle.status().connected, false);
    assert.match(handle.status().error ?? "", /gateway down/);
    handle.stop();
  });
});

describe("startDingTalkBot audit", () => {
  it("records an audit row for a successful answer", async () => {
    received = [];
    const stream = makeFakeStream();
    const handle = await startDingTalkBot(config({ channelId: "chan_1", workspaceId: "ws_a" }), {
      createStreamClient: stream.create,
      askChat: async () => ({
        content: "回答内容",
        toolCalls: ["rag"],
        toolResultCount: 1,
        citations: 2,
      }),
    });
    await stream.getOptions()!.onMessage!(textEvent());
    await flush();
    handle.stop();

    const audits = listImChatAudits({ workspace: "ws_a" });
    assert.equal(audits.total, 1);
    const audit = audits.items[0]!;
    assert.equal(audit.platform, "dingtalk");
    assert.equal(audit.channelId, "chan_1");
    assert.equal(audit.actor, "staff_1");
    assert.equal(audit.actorName, "张三");
    assert.equal(audit.chatType, "group");
    assert.equal(audit.status, "ok");
    assert.equal(audit.answer, "回答内容");
    assert.equal(audit.toolCalls, 1);
    assert.equal(audit.citations, 2);
  });

  it("records an error audit when the chat request fails", async () => {
    received = [];
    const stream = makeFakeStream();
    const handle = await startDingTalkBot(config({ channelId: "chan_2" }), {
      createStreamClient: stream.create,
      askChat: async () => {
        throw new Error("provider unavailable");
      },
    });
    await stream.getOptions()!.onMessage!(textEvent());
    await flush();
    handle.stop();

    const audits = listImChatAudits({ channelId: "chan_2" });
    assert.equal(audits.total, 1);
    assert.equal(audits.items[0]?.status, "error");
    assert.match(audits.items[0]?.error ?? "", /provider unavailable/);
  });
});
