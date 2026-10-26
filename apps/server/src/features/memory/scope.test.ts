import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseImSessionScope } from "./scope.js";

describe("parseImSessionScope", () => {
  it("maps a private chat to a person scope", () => {
    const scope = parseImSessionScope("feishu:oc_1:u:ou_9", "ou_9");
    assert.equal(scope?.chatType, "p2p");
    assert.equal(scope?.personKey, "person:feishu:oc_1:ou_9");
    assert.equal(scope?.groupKey, null);
    assert.equal(scope?.anonymous, false);
  });

  it("maps a group chat to a group scope without a person key", () => {
    const scope = parseImSessionScope("dingtalk:cid_2", "staff_1");
    assert.equal(scope?.chatType, "group");
    assert.equal(scope?.groupKey, "dingtalk:cid_2");
    assert.equal(scope?.personKey, null);
  });

  it("marks private chats without an actor as anonymous", () => {
    const scope = parseImSessionScope("feishu:oc_1:u:anonymous", null);
    assert.equal(scope?.anonymous, true);
    assert.equal(scope?.personKey, null);
  });

  it("honors an explicit chat type header over key shape", () => {
    const scope = parseImSessionScope("feishu:oc_1:u:ou_9", "ou_9", "group");
    assert.equal(scope?.chatType, "group");
  });

  it("rejects non-IM session ids", () => {
    assert.equal(parseImSessionScope("web-session-1", "u1"), null);
  });
});
