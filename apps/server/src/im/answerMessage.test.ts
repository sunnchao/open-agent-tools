import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerImMessage } from "./answerMessage.js";
import type { ImChatAuditInput } from "./audit.js";
import type { ChatAnswer } from "./chatClient.js";
import type { ImConfig, ImMessageEvent } from "./types.js";

const config: ImConfig = {
  name: "测试渠道",
  channelId: "channel",
  platform: "feishu",
  appId: "app",
  appSecret: "secret",
  ragSources: ["handbook"],
  ragTopK: 4,
  sqlSources: ["sql"],
  mcpTools: [{ serviceSlug: "docs", toolName: "search" }],
  requireMention: true,
  chatBaseUrl: "http://127.0.0.1:1",
  workspaceId: "workspace",
};
const event: ImMessageEvent = {
  platform: "feishu",
  messageId: "message",
  chatId: "chat",
  chatType: "p2p",
  senderOpenId: "actor",
  senderName: null,
  text: "问题",
  mentioned: false,
};
const answer: ChatAnswer = {
  content: "回答",
  toolCalls: ["rag", "sql"],
  toolResultCount: 2,
  citations: 3,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("shared IM answer flow", () => {
  for (const platform of ["feishu", "dingtalk"] as const) {
    it(`${platform}: preserves resource bindings, private sessions, reply order and audit counters`, async () => {
      const replies: string[] = [];
      const audits: ImChatAuditInput[] = [];
      const longAnswer = { ...answer, content: "A".repeat(3300) };
      let replying = false;
      await answerImMessage(
        config,
        { ...event, platform, senderName: "昵称" },
        {
          askChat: async (request) => {
            assert.deepEqual(request, {
              baseUrl: config.chatBaseUrl,
              question: "问题",
              sessionId: `${platform}:chat:u:actor`,
              sources: ["handbook"],
              topK: 4,
              sqlSources: ["sql"],
              mcpTools: config.mcpTools,
              workspaceId: "workspace",
              im: { channelId: "channel", actor: "actor", chatType: "p2p" },
            });
            return longAnswer;
          },
          reply: async (text) => {
            assert.equal(replying, false, "message chunks must be sent sequentially");
            replying = true;
            await Promise.resolve();
            replies.push(text);
            replying = false;
          },
          recordAudit: (input) => {
            audits.push(input);
            return null;
          },
        },
      );
      assert.equal(replies.join(""), longAnswer.content);
      assert.equal(replies.length, 3);
      assert.ok(replies.every((part) => part.length <= 1500));
      assert.equal(audits.length, 1);
      assert.deepEqual(
        { ...audits[0], durationMs: 0 },
        {
          channelId: "channel",
          channelName: config.name,
          platform,
          sessionId: `${platform}:chat:u:actor`,
          workspace: "workspace",
          actor: "actor",
          actorName: "昵称",
          chatType: "p2p",
          conversationId: "chat",
          question: "问题",
          answer: longAnswer.content,
          status: "ok",
          error: null,
          durationMs: 0,
          toolCalls: 2,
          citations: 3,
        },
      );
    });
  }

  it("starts name resolution and chat together and retains the directory name in the audit", async () => {
    const name = deferred<string | null>();
    const response = deferred<ChatAnswer>();
    let nameStarted = false;
    let chatStarted = false;
    const audits: ImChatAuditInput[] = [];
    const replies: string[] = [];
    const task = answerImMessage(config, event, {
      resolveSenderName: async (actor) => {
        assert.equal(actor, "actor");
        nameStarted = true;
        return name.promise;
      },
      askChat: async () => {
        chatStarted = true;
        return response.promise;
      },
      reply: async (text) => {
        replies.push(text);
      },
      recordAudit: (input) => {
        audits.push(input);
        return null;
      },
    });
    assert.equal(nameStarted, true);
    assert.equal(chatStarted, true);
    response.resolve(answer);
    name.resolve("通讯录姓名");
    await task;
    assert.deepEqual(replies, ["回答"]);
    assert.equal(audits[0]?.actorName, "通讯录姓名");
  });

  it("keeps group sessions shared and tolerates failed name lookups", async () => {
    const audits: ImChatAuditInput[] = [];
    await answerImMessage(
      { ...config, channelId: undefined, workspaceId: undefined },
      { ...event, chatType: "group" },
      {
        resolveSenderName: async () => {
          throw new Error("directory timeout");
        },
        askChat: async (request) => {
          assert.equal(request.sessionId, "feishu:chat");
          assert.deepEqual(request.im, { actor: "actor", chatType: "group" });
          assert.equal("workspaceId" in request, false);
          return answer;
        },
        reply: async () => {},
        recordAudit: (input) => {
          audits.push(input);
          return null;
        },
      },
    );
    assert.equal(audits[0]?.actor, "actor");
    assert.equal(audits[0]?.actorName, null);
    assert.equal(audits[0]?.workspace, null);
  });

  it("sends the empty-answer placeholder and audits an empty answer", async () => {
    const replies: string[] = [];
    const audits: ImChatAuditInput[] = [];
    await answerImMessage(
      config,
      { ...event, senderOpenId: null },
      {
        askChat: async (request) => {
          assert.equal(request.sessionId, "feishu:chat:u:anonymous");
          assert.equal(request.im?.actor, undefined);
          return { ...answer, content: " \n " };
        },
        reply: async (text) => {
          replies.push(text);
        },
        recordAudit: (input) => {
          audits.push(input);
          return null;
        },
      },
    );
    assert.deepEqual(replies, ["（没有生成回答内容）"]);
    assert.equal(audits[0]?.answer, "");
    assert.equal(audits[0]?.status, "ok");
  });

  it("awaits pending names on chat errors and keeps the complete error in the audit", async () => {
    const name = deferred<string | null>();
    const error = "provider unavailable ".repeat(30);
    const replies: string[] = [];
    const audits: ImChatAuditInput[] = [];
    const task = answerImMessage(config, event, {
      resolveSenderName: () => name.promise,
      askChat: async () => {
        throw new Error(error);
      },
      reply: async (text) => {
        replies.push(text);
      },
      recordAudit: (input) => {
        audits.push(input);
        return null;
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(replies.length, 0);
    assert.equal(audits.length, 0);
    name.resolve("错误请求用户");
    await task;
    assert.deepEqual(replies, [`抱歉，处理失败：${error.slice(0, 300)}`]);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.error, error);
    assert.equal(audits[0]?.actorName, "错误请求用户");
    assert.equal(audits[0]?.status, "error");
    assert.equal(audits[0]?.toolCalls, 0);
    assert.equal(audits[0]?.citations, 0);
  });

  it("does not fail the reply when audit persistence throws", async () => {
    const replies: string[] = [];
    await answerImMessage(config, event, {
      askChat: async () => answer,
      reply: async (text) => {
        replies.push(text);
      },
      recordAudit: () => {
        throw new Error("database unavailable");
      },
    });
    assert.deepEqual(replies, ["回答"]);
  });
});
