import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFeishuTextContent, parseFeishuMessageEvent } from "./message.js";

describe("parseFeishuTextContent", () => {
  it("extracts trimmed text from JSON content", () => {
    assert.equal(parseFeishuTextContent('{"text":"  你好世界  "}'), "你好世界");
  });

  it("returns null for non-text payloads", () => {
    assert.equal(parseFeishuTextContent('{"image_key":"img_v2"}'), null);
  });

  it("returns null for malformed JSON", () => {
    assert.equal(parseFeishuTextContent("not-json"), null);
  });

  it("returns null for empty text", () => {
    assert.equal(parseFeishuTextContent('{"text":"   "}'), null);
  });
});

describe("parseFeishuMessageEvent", () => {
  it("normalizes a p2p text message", () => {
    const event = parseFeishuMessageEvent({
      sender: { sender_id: { open_id: "ou_123" } },
      message: {
        message_id: "om_1",
        chat_id: "oc_2",
        chat_type: "p2p",
        message_type: "text",
        content: '{"text":"今天的日报生成了吗"}',
      },
    });
    assert.equal(event.platform, "feishu");
    assert.equal(event.messageId, "om_1");
    assert.equal(event.chatId, "oc_2");
    assert.equal(event.chatType, "p2p");
    assert.equal(event.senderOpenId, "ou_123");
    assert.equal(event.text, "今天的日报生成了吗");
    assert.equal(event.mentioned, false);
  });

  it("marks group messages with mentions", () => {
    const event = parseFeishuMessageEvent({
      sender: { sender_id: { open_id: "ou_x" } },
      message: {
        message_id: "om_2",
        chat_id: "oc_3",
        chat_type: "group",
        message_type: "text",
        content: '{"text":"@机器人 查一下知识库"}',
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
      },
    });
    assert.equal(event.chatType, "group");
    assert.equal(event.mentioned, true);
  });

  it("keeps non-text messages with null text", () => {
    const event = parseFeishuMessageEvent({
      message: {
        message_id: "om_3",
        chat_id: "oc_4",
        chat_type: "p2p",
        message_type: "image",
        content: '{"image_key":"img_1"}',
      },
    });
    assert.equal(event.text, null);
  });

  it("tolerates empty events", () => {
    const event = parseFeishuMessageEvent({});
    assert.equal(event.messageId, "");
    assert.equal(event.text, null);
  });
});
