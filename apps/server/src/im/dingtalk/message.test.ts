import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseDingTalkMessageEvent,
  parseDingTalkMessagePayload,
  stripDingTalkMentionPrefix,
} from "./message.js";

describe("stripDingTalkMentionPrefix", () => {
  it("strips a leading @bot token", () => {
    assert.equal(stripDingTalkMentionPrefix("@机器人 你好"), "你好");
  });

  it("strips only the first @ token and keeps the rest", () => {
    assert.equal(stripDingTalkMentionPrefix("@机器人 查一下 @张三 的数据"), "查一下 @张三 的数据");
  });

  it("keeps text without a mention prefix", () => {
    assert.equal(stripDingTalkMentionPrefix("  你好  "), "你好");
  });

  it("tolerates a bare @ mention", () => {
    assert.equal(stripDingTalkMentionPrefix("@机器人"), "");
  });
});

describe("parseDingTalkMessageEvent", () => {
  it("normalizes a p2p text message", () => {
    const event = parseDingTalkMessageEvent({
      conversationId: "cid_1",
      conversationType: "1",
      msgId: "msg_1",
      senderStaffId: "staff_1",
      senderId: "$:LWCP_v1:abc",
      msgtype: "text",
      text: { content: " 今天的日报生成了吗 " },
      isInAtList: false,
    });
    assert.equal(event.platform, "dingtalk");
    assert.equal(event.chatId, "cid_1");
    assert.equal(event.messageId, "msg_1");
    assert.equal(event.chatType, "p2p");
    assert.equal(event.senderOpenId, "staff_1");
    assert.equal(event.text, "今天的日报生成了吗");
    assert.equal(event.mentioned, false);
  });

  it("normalizes a group text message and strips the @ prefix", () => {
    const event = parseDingTalkMessageEvent({
      conversationId: "cid_2",
      conversationType: "2",
      msgId: "msg_2",
      senderId: "$:LWCP_v1:abc",
      msgtype: "text",
      text: { content: "@机器人 查一下知识库" },
      isInAtList: true,
      atUsers: [{ dingtalkId: "$:LWCP_v1:bot" }],
    });
    assert.equal(event.chatType, "group");
    assert.equal(event.senderOpenId, "$:LWCP_v1:abc");
    assert.equal(event.text, "查一下知识库");
    assert.equal(event.mentioned, true);
  });

  it("prefers senderStaffId over senderId", () => {
    const event = parseDingTalkMessageEvent({
      senderStaffId: "staff_9",
      senderId: "$:LWCP_v1:encrypted",
      msgtype: "text",
      text: { content: "hi" },
    });
    assert.equal(event.senderOpenId, "staff_9");
  });

  it("extracts senderNick as senderName and tolerates missing nick", () => {
    const withNick = parseDingTalkMessageEvent({
      senderStaffId: "staff_1",
      senderNick: "  张三  ",
      msgtype: "text",
      text: { content: "hi" },
    });
    assert.equal(withNick.senderName, "张三");
    const withoutNick = parseDingTalkMessageEvent({
      senderStaffId: "staff_2",
      msgtype: "text",
      text: { content: "hi" },
    });
    assert.equal(withoutNick.senderName, null);
    const blankNick = parseDingTalkMessageEvent({
      senderNick: "   ",
      msgtype: "text",
      text: { content: "hi" },
    });
    assert.equal(blankNick.senderName, null);
  });

  it("marks mention from atUsers even without isInAtList", () => {
    const event = parseDingTalkMessageEvent({
      msgtype: "text",
      text: { content: "hi" },
      atUsers: [{ dingtalkId: "x" }],
    });
    assert.equal(event.mentioned, true);
  });

  it("returns null text for non-text messages", () => {
    for (const msgtype of ["picture", "richText", "audio", "file", undefined]) {
      const event = parseDingTalkMessageEvent({ msgtype, text: { content: "ignored" } });
      assert.equal(event.text, null, `msgtype=${String(msgtype)}`);
    }
  });

  it("returns null text when the text body is blank", () => {
    assert.equal(
      parseDingTalkMessageEvent({ msgtype: "text", text: { content: "   " } }).text,
      null,
    );
  });

  it("tolerates empty events", () => {
    const event = parseDingTalkMessageEvent({});
    assert.equal(event.platform, "dingtalk");
    assert.equal(event.messageId, "");
    assert.equal(event.chatId, "");
    assert.equal(event.chatType, "group");
    assert.equal(event.senderOpenId, null);
    assert.equal(event.text, null);
    assert.equal(event.mentioned, false);
    assert.equal(parseDingTalkMessageEvent(undefined).text, null);
    assert.equal(parseDingTalkMessageEvent(null).messageId, "");
  });
});

describe("parseDingTalkMessagePayload", () => {
  it("keeps sessionWebhook metadata alongside the normalized event", () => {
    const payload = parseDingTalkMessagePayload({
      conversationId: "cid_3",
      msgId: "msg_3",
      msgtype: "text",
      text: { content: "你好" },
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
      sessionWebhookExpiredTime: 1690367502152,
      robotCode: "ding_robot",
    });
    assert.equal(payload.event.chatId, "cid_3");
    assert.equal(
      payload.sessionWebhook,
      "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
    );
    assert.equal(payload.sessionWebhookExpiredTime, 1690367502152);
    assert.equal(payload.robotCode, "ding_robot");
  });

  it("normalizes missing/invalid webhook fields to null", () => {
    const payload = parseDingTalkMessagePayload({
      sessionWebhook: "",
      sessionWebhookExpiredTime: "not-a-number",
    });
    assert.equal(payload.sessionWebhook, null);
    assert.equal(payload.sessionWebhookExpiredTime, null);
    assert.equal(payload.robotCode, null);
  });
});
