import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerImMessage } from "./answerMessage.js";
import type { ImChatAuditInput } from "./audit.js";
import { ChatRequestError, type ChatAnswer } from "./chatClient.js";
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
const model = {
  providerId: "provider-1",
  providerName: "主 Provider",
  providerFormat: "openai-chat",
  model: "model-1",
};
const usage = {
  requests: 2,
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  toolCalls: 2,
  toolErrors: 0,
};
const models = [
  {
    providerId: "provider-1",
    model: "model-1",
    requests: 2,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    durationMs: 40,
    failed: false,
  },
];
const answer: ChatAnswer = {
  content: "回答",
  toolCalls: ["rag", "sql"],
  toolResultCount: 2,
  citations: 3,
  usage,
  models,
  model,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type AnswerDeps = Parameters<typeof answerImMessage>[2];
type TestAnswerDeps = Omit<
  AnswerDeps,
  "recordAccountInteraction" | "updateAccountExternalName" | "resolveAccountModel"
> &
  Partial<
    Pick<
      AnswerDeps,
      "recordAccountInteraction" | "updateAccountExternalName" | "resolveAccountModel"
    >
  >;

function answerForTest(
  configValue: ImConfig,
  eventValue: ImMessageEvent,
  deps: TestAnswerDeps,
): Promise<void> {
  return answerImMessage(configValue, eventValue, {
    recordAccountInteraction: () => undefined,
    updateAccountExternalName: () => undefined,
    resolveAccountModel: () => null,
    ...deps,
  });
}

describe("shared IM answer flow", () => {
  for (const platform of ["feishu", "dingtalk"] as const) {
    it(`${platform}: preserves resource bindings, private sessions, reply order and audit counters`, async () => {
      const replies: string[] = [];
      const audits: ImChatAuditInput[] = [];
      const longAnswer = { ...answer, content: "A".repeat(3300) };
      let replying = false;
      await answerForTest(
        config,
        { ...event, platform, senderName: "昵称" },
        {
          askChat: async ({ onProgress: _onProgress, ...request }) => {
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
          providerId: "provider-1",
          providerName: "主 Provider",
          providerFormat: "openai-chat",
          model: "model-1",
          llmRequests: 2,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          models,
        },
      );
    });
  }

  it("records the account, syncs its directory name and applies its model binding", async () => {
    const interactions: Array<Record<string, unknown>> = [];
    const syncedNames: Array<[string, string, string | null]> = [];
    await answerForTest(
      config,
      {
        ...event,
        senderIdType: "feishu_open_id",
        senderName: "Event nickname",
      },
      {
        recordAccountInteraction: (input) => {
          interactions.push(input as unknown as Record<string, unknown>);
        },
        updateAccountExternalName: (channelId, externalUserId, name) => {
          syncedNames.push([channelId, externalUserId, name]);
        },
        resolveAccountModel: (channelId, externalUserId) => {
          assert.equal(channelId, "channel");
          assert.equal(externalUserId, "actor");
          return { providerId: "provider-bound", model: "model-bound" };
        },
        resolveSenderName: async () => "Directory name",
        askChat: async (request) => {
          assert.equal(request.providerId, "provider-bound");
          assert.equal(request.model, "model-bound");
          return answer;
        },
        reply: async () => {},
        recordAudit: () => null,
      },
    );

    assert.equal(interactions.length, 1);
    assert.deepEqual(
      {
        channelId: interactions[0]?.channelId,
        channelName: interactions[0]?.channelName,
        platform: interactions[0]?.platform,
        workspaceId: interactions[0]?.workspaceId,
        externalUserId: interactions[0]?.externalUserId,
        externalUserIdType: interactions[0]?.externalUserIdType,
        externalName: interactions[0]?.externalName,
        conversationId: interactions[0]?.conversationId,
        chatType: interactions[0]?.chatType,
      },
      {
        channelId: "channel",
        channelName: "测试渠道",
        platform: "feishu",
        workspaceId: "workspace",
        externalUserId: "actor",
        externalUserIdType: "feishu_open_id",
        externalName: "Event nickname",
        conversationId: "chat",
        chatType: "p2p",
      },
    );
    assert.deepEqual(syncedNames, [["channel", "actor", "Directory name"]]);
  });

  it("still replies when account storage or model resolution fails", async () => {
    const replies: string[] = [];
    await answerForTest(config, event, {
      recordAccountInteraction: () => {
        throw new Error("account table unavailable");
      },
      updateAccountExternalName: () => {
        throw new Error("name update failed");
      },
      resolveAccountModel: () => {
        throw new Error("provider lookup failed");
      },
      resolveSenderName: async () => "Directory name",
      askChat: async (request) => {
        assert.equal("providerId" in request, false);
        assert.equal("model" in request, false);
        return answer;
      },
      reply: async (text) => {
        replies.push(text);
      },
      recordAudit: () => null,
    });
    assert.deepEqual(replies, ["回答"]);
  });

  it("starts name resolution and chat together and retains the directory name in the audit", async () => {
    const name = deferred<string | null>();
    const response = deferred<ChatAnswer>();
    let nameStarted = false;
    let chatStarted = false;
    const audits: ImChatAuditInput[] = [];
    const replies: string[] = [];
    const task = answerForTest(config, event, {
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
    await answerForTest(
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
    await answerForTest(
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

  it("sends no status for fast answers and keeps the reply a single message", async () => {
    const replies: string[] = [];
    await answerForTest(config, event, {
      askChat: async () => answer,
      reply: async (text) => {
        replies.push(text);
      },
      recordAudit: () => null,
    });
    assert.deepEqual(replies, ["回答"]);
  });

  it("announces slow progress in stages and caps status messages", async () => {
    const replies: string[] = [];
    const task = answerForTest(config, event, {
      askChat: async ({ onProgress }) => {
        onProgress?.({ type: "tool_call", toolName: "SQL 问数 · mcp_management" });
        // 跨过 4s 宽限期，让第一条状态先落盘；同槽位的突发事件只保留最后一条。
        await new Promise<void>((resolve) => setTimeout(resolve, 4400));
        onProgress?.({ type: "tool_result", toolName: "SQL 问数 · mcp_management" });
        onProgress?.({ type: "delta" });
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
        return answer;
      },
      reply: async (text) => {
        replies.push(text);
      },
      recordAudit: () => null,
    });
    await task;
    assert.deepEqual(replies, [
      "正在调用 SQL 问数 · mcp_management…",
      "已完成 SQL 问数 · mcp_management 调用，正在整理回答…",
      "回答",
    ]);
  });

  it("sends a placeholder when no progress arrives for a slow answer", async () => {
    const replies: string[] = [];
    const task = answerForTest(config, event, {
      askChat: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 4400));
        return answer;
      },
      reply: async (text) => {
        replies.push(text);
      },
      recordAudit: () => null,
    });
    await task;
    assert.deepEqual(replies, ["收到，正在处理，请稍候…", "回答"]);
  });

  it("includes completed steps in the failure reply", async () => {
    const replies: string[] = [];
    const error = "fetch failed";
    await answerForTest(config, event, {
      askChat: async ({ onProgress }) => {
        onProgress?.({ type: "retrieval" });
        onProgress?.({ type: "tool_result", toolName: "SQL 问数 · mcp_management" });
        throw new Error(error);
      },
      reply: async (text) => {
        replies.push(text);
      },
      recordAudit: () => null,
    });
    assert.deepEqual(replies, [
      "抱歉，处理失败：fetch failed（失败前已完成：检索知识库、调用 SQL 问数 · mcp_management）",
    ]);
  });

  it("awaits pending names on chat errors and keeps the complete error in the audit", async () => {
    const name = deferred<string | null>();
    const error = "provider unavailable ".repeat(30);
    const replies: string[] = [];
    const audits: ImChatAuditInput[] = [];
    const task = answerForTest(config, event, {
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

  it("records partial token usage and model data when the stream fails", async () => {
    const audits: ImChatAuditInput[] = [];
    await answerForTest(config, event, {
      askChat: async () => {
        throw new ChatRequestError("provider failed", { usage, models, model });
      },
      reply: async () => {},
      recordAudit: (input) => {
        audits.push(input);
        return null;
      },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.status, "error");
    assert.equal(audits[0]?.providerId, "provider-1");
    assert.equal(audits[0]?.model, "model-1");
    assert.equal(audits[0]?.llmRequests, 2);
    assert.equal(audits[0]?.inputTokens, 100);
    assert.equal(audits[0]?.outputTokens, 20);
    assert.equal(audits[0]?.totalTokens, 120);
    assert.deepEqual(audits[0]?.models, models);
  });

  it("does not fail the reply when audit persistence throws", async () => {
    const replies: string[] = [];
    await answerForTest(config, event, {
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
