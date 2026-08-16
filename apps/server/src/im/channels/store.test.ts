import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb } from "../../db.js";
import { createChannel, deleteChannel, getChannel, listChannels, updateChannel } from "./store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "im-channels-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.PROVIDER_KEYS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.PROVIDER_KEYS_ENCRYPTION_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("IM channel store", () => {
  it("creates a channel and masks secrets", () => {
    const channel = createChannel({
      name: "研发群机器人",
      platform: "feishu",
      appId: "cli_abc",
      appSecret: "sk-feishu-secret-123",
      encryptKey: "enc-key-456",
      ragSources: ["handbook", "policy"],
      ragTopK: 6,
    });
    assert.ok(channel.id.length > 0);
    assert.equal(channel.name, "研发群机器人");
    assert.equal(channel.platform, "feishu");
    assert.equal(channel.appId, "cli_abc");
    assert.equal(channel.ragSources.join(","), "handbook,policy");
    assert.equal(channel.ragTopK, 6);
    assert.equal(channel.enabled, true);
    assert.equal(channel.appSecretMasked, "sk***123");
    assert.equal(channel.encryptKeyMasked, "en***456");

    const withSecret = getChannel(channel.id, { includeDisabled: true });
    assert.ok(withSecret);
    assert.equal(withSecret.appSecret, "sk-feishu-secret-123");
    assert.equal(withSecret.encryptKey, "enc-key-456");
  });

  it("rejects missing name / appId / unknown platform", () => {
    assert.throws(() => createChannel({ name: "", platform: "feishu", appId: "cli_1" }));
    assert.throws(() => createChannel({ name: "x", platform: "feishu", appId: "" }));
    assert.throws(() => createChannel({ name: "x", platform: "wechat" as never, appId: "cli_1" }));
  });

  it("encrypts secrets only when encryption key is configured", () => {
    delete process.env.PROVIDER_KEYS_ENCRYPTION_KEY;
    assert.throws(() =>
      createChannel({ name: "x", platform: "feishu", appId: "cli_1", appSecret: "secret" }),
    );
  });

  it("lists enabled only by default and all with flag", () => {
    const a = createChannel({ name: "A", platform: "feishu", appId: "cli_a", enabled: true });
    createChannel({ name: "B", platform: "feishu", appId: "cli_b", enabled: false });

    assert.deepEqual(
      listChannels().map((channel) => channel.id),
      [a.id],
    );
    assert.equal(listChannels({ includeDisabled: true }).length, 2);
  });

  it("updates fields and keeps secret when left blank", () => {
    const channel = createChannel({
      name: "旧名",
      platform: "feishu",
      appId: "cli_old",
      appSecret: "old-secret",
      ragSources: [],
    });
    const updated = updateChannel(channel.id, {
      name: "新名",
      appSecret: "",
      ragSources: ["policy"],
      enabled: false,
    });
    assert.ok(updated);
    assert.equal(updated.name, "新名");
    assert.equal(updated.enabled, false);
    assert.deepEqual(updated.ragSources, ["policy"]);
    assert.equal(updated.appSecretMasked, maskOf("old-secret"));

    const withSecret = getChannel(channel.id, { includeDisabled: true });
    assert.equal(withSecret?.appSecret, "old-secret");
  });

  it("deletes a channel", () => {
    const channel = createChannel({ name: "X", platform: "feishu", appId: "cli_x" });
    assert.equal(deleteChannel(channel.id), true);
    assert.equal(deleteChannel(channel.id), false);
    assert.equal(listChannels({ includeDisabled: true }).length, 0);
  });
});

function maskOf(value: string): string {
  return value.length < 8 ? "***" : `${value.slice(0, 2)}***${value.slice(-3)}`;
}
