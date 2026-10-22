import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb, openDb } from "../db.js";
import {
  countImChatAudits,
  getImChatAudit,
  listImChatAudits,
  recordImChatAudit,
  truncateAuditText,
} from "./audit.js";
import { buildImSessionId } from "./types.js";

describe("im chat audit", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-agent-tools-im-audit-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
    openDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("records an audit row and reads it back", () => {
    const created = recordImChatAudit({
      channelId: "chan_1",
      channelName: "钉钉群",
      platform: "dingtalk",
      sessionId: "dingtalk:cid:u:staff_1",
      workspace: "ws_a",
      actor: "staff_1",
      actorName: null,
      chatType: "p2p",
      conversationId: "cid",
      question: "上季度营收多少",
      answer: "1234 万",
      status: "ok",
      durationMs: 1200,
      toolCalls: 2,
      citations: 3,
    });
    assert.ok(created);
    const loaded = getImChatAudit(created.id);
    assert.ok(loaded);
    assert.equal(loaded.platform, "dingtalk");
    assert.equal(loaded.workspace, "ws_a");
    assert.equal(loaded.actor, "staff_1");
    assert.equal(loaded.chatType, "p2p");
    assert.equal(loaded.toolCalls, 2);
    assert.equal(loaded.citations, 3);
    assert.equal(loaded.status, "ok");
  });

  it("records failed questions as error audits", () => {
    const created = recordImChatAudit({
      platform: "feishu",
      question: "坏问题",
      answer: "",
      status: "error",
      error: "provider unavailable",
    });
    assert.ok(created);
    assert.equal(created.status, "error");
    assert.equal(created.error, "provider unavailable");
    const list = listImChatAudits({ status: "error" });
    assert.equal(list.total, 1);
    assert.equal(list.items[0]?.question, "坏问题");
  });

  it("truncates long question and answer text", () => {
    const long = "x".repeat(5000);
    const created = recordImChatAudit({ platform: "feishu", question: long, answer: long });
    assert.ok(created);
    assert.equal(created.question.length, 2001);
    assert.equal(created.answer.length, 2001);
    assert.ok(truncateAuditText(long).endsWith("…"));
    assert.equal(truncateAuditText("short"), "short");
  });

  it("filters by workspace, platform, actor, chatType and status", () => {
    recordImChatAudit({
      platform: "feishu",
      workspace: "ws_a",
      actor: "u1",
      chatType: "p2p",
      status: "ok",
      question: "alpha",
    });
    recordImChatAudit({
      platform: "feishu",
      workspace: "ws_b",
      actor: "u2",
      chatType: "group",
      status: "error",
      question: "beta",
    });
    recordImChatAudit({
      platform: "dingtalk",
      workspace: "ws_a",
      actor: "u1",
      chatType: "group",
      status: "ok",
      question: "gamma",
    });

    assert.equal(listImChatAudits({ workspace: "ws_a" }).total, 2);
    assert.equal(listImChatAudits({ platform: "feishu" }).total, 2);
    assert.equal(listImChatAudits({ actor: "u1" }).total, 2);
    assert.equal(listImChatAudits({ chatType: "group" }).total, 2);
    assert.equal(listImChatAudits({ status: "error" }).total, 1);
    assert.equal(listImChatAudits({ workspace: "ws_a", platform: "dingtalk" }).total, 1);
    assert.equal(countImChatAudits({ workspace: "ws_b" }), 1);
  });

  it("filters by keyword across question and answer", () => {
    recordImChatAudit({ platform: "feishu", question: "报销流程", answer: "见制度第 3 条" });
    recordImChatAudit({ platform: "feishu", question: "请假", answer: "OA 提交" });
    assert.equal(listImChatAudits({ keyword: "报销" }).total, 1);
    assert.equal(listImChatAudits({ keyword: "oa" }).total, 1);
    assert.equal(listImChatAudits({ keyword: "不存在" }).total, 0);
  });

  it("traces conversations by dialogue partner name or id", () => {
    recordImChatAudit({
      platform: "dingtalk",
      actor: "staff_1",
      actorName: "张三",
      question: "报销标准是多少",
    });
    recordImChatAudit({
      platform: "feishu",
      actor: "ou_x",
      actorName: "李四",
      question: "请假流程",
    });
    recordImChatAudit({ platform: "dingtalk", actor: "staff_9", question: "匿名问题" });
    // 用户筛选：客户姓名与平台 ID 都能命中同一条记录。
    assert.equal(listImChatAudits({ actor: "张三" }).total, 1);
    assert.equal(listImChatAudits({ actor: "staff_1" }).total, 1);
    assert.equal(listImChatAudits({ actor: "张三" }).items[0]?.question, "报销标准是多少");
    // 关键词：输入客户名可直接追溯其全部对话。
    assert.equal(listImChatAudits({ keyword: "李四" }).total, 1);
    assert.equal(listImChatAudits({ keyword: "ou_x" }).total, 1);
    assert.equal(listImChatAudits({ keyword: "不存在的人" }).total, 0);
  });

  it("truncates overlong actor names to 200 chars", () => {
    const created = recordImChatAudit({
      platform: "dingtalk",
      actor: "staff_1",
      actorName: "张".repeat(500),
      question: "hi",
    });
    assert.ok(created);
    assert.equal(created.actorName?.length, 201);
    assert.ok(created.actorName?.endsWith("…"));
  });

  it("applies the time window and pagination with a stable total", () => {
    const base = Date.now();
    for (let i = 0; i < 5; i += 1) {
      recordImChatAudit({
        platform: "feishu",
        workspace: "ws_a",
        question: `问题 ${i}`,
        createdAt: base + i * 1000,
      });
    }
    const inWindow = listImChatAudits({ from: base + 2000, to: base + 4000 });
    assert.equal(inWindow.total, 3);

    const page1 = listImChatAudits({ limit: 2, offset: 0 });
    const page2 = listImChatAudits({ limit: 2, offset: 2 });
    assert.equal(page1.total, 5);
    assert.equal(page2.total, 5);
    assert.equal(page1.items.length, 2);
    assert.equal(page2.items.length, 2);
    const ids = new Set([...page1.items, ...page2.items].map((item) => item.id));
    assert.equal(ids.size, 4);
  });

  it("returns null for a missing audit id", () => {
    assert.equal(getImChatAudit("nope"), null);
  });
});

describe("buildImSessionId", () => {
  it("isolates p2p conversations per platform user", () => {
    const a = buildImSessionId("dingtalk", "cid", "p2p", "staff_1");
    const b = buildImSessionId("dingtalk", "cid", "p2p", "staff_2");
    assert.notEqual(a, b);
    assert.equal(a, "dingtalk:cid:u:staff_1");
    assert.equal(b, "dingtalk:cid:u:staff_2");
  });

  it("shares one session for a group chat regardless of actor", () => {
    const a = buildImSessionId("feishu", "oc_1", "group", "u1");
    const b = buildImSessionId("feishu", "oc_1", "group", "u2");
    assert.equal(a, b);
    assert.equal(a, "feishu:oc_1");
  });

  it("keeps platforms separated", () => {
    assert.notEqual(
      buildImSessionId("feishu", "x", "p2p", "u1"),
      buildImSessionId("dingtalk", "x", "p2p", "u1"),
    );
  });

  it("falls back to an anonymous actor for p2p without a user id", () => {
    assert.equal(buildImSessionId("feishu", "oc_1", "p2p", null), "feishu:oc_1:u:anonymous");
  });
});
