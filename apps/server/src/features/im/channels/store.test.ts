import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb, openDb } from "../../../platform/db.js";
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

  it("round-trips sqlSources and normalizes duplicates", () => {
    const channel = createChannel({
      name: "问数机器人",
      platform: "dingtalk",
      appId: "ding_client",
      sqlSources: [" source_a ", "source_b", "source_a", ""],
    });
    assert.deepEqual(channel.sqlSources, ["source_a", "source_b"]);
    assert.deepEqual(getChannel(channel.id, { includeDisabled: true })?.sqlSources, [
      "source_a",
      "source_b",
    ]);

    const updated = updateChannel(channel.id, { sqlSources: ["source_c"] });
    assert.deepEqual(updated?.sqlSources, ["source_c"]);

    // 未提供 sqlSources 时保留已存值。
    const kept = updateChannel(channel.id, { name: "改名" });
    assert.deepEqual(kept?.sqlSources, ["source_c"]);
  });

  it("defaults sqlSources to an empty array", () => {
    const channel = createChannel({ name: "空", platform: "feishu", appId: "cli_empty" });
    assert.deepEqual(channel.sqlSources, []);
    assert.deepEqual(listChannels()[0]?.sqlSources, []);
  });

  it("migrates a legacy im_channels table without sql_sources_json", () => {
    closeDb();
    const legacyPath = join(dir, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE im_channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        app_id TEXT NOT NULL,
        app_secret_enc TEXT,
        encrypt_key_enc TEXT,
        rag_sources_json TEXT NOT NULL DEFAULT '[]',
        rag_top_k INTEGER NOT NULL DEFAULT 5,
        require_mention INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO im_channels (id, name, platform, app_id, rag_sources_json, rag_top_k, require_mention, enabled, created_at, updated_at)
      VALUES ('legacy-1', '旧渠道', 'feishu', 'cli_legacy', '["handbook"]', 5, 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    process.env.SQLITE_PATH = legacyPath;
    const columns = openDb().prepare("PRAGMA table_info(im_channels)").all() as Array<{
      name: string;
    }>;
    assert.ok(columns.some((column) => column.name === "sql_sources_json"));
    assert.ok(columns.some((column) => column.name === "mcp_tools_json"));
    const migrated = getChannel("legacy-1", { includeDisabled: true });
    assert.deepEqual(migrated?.ragSources, ["handbook"]);
    assert.deepEqual(migrated?.sqlSources, []);
    assert.deepEqual(migrated?.mcpTools, []);
  });

  it("round-trips mcpTools and normalizes duplicates", () => {
    const channel = createChannel({
      name: "工具机器人",
      platform: "dingtalk",
      appId: "ding_client",
      mcpTools: [
        { serviceSlug: " docs ", toolName: " search " },
        { serviceSlug: "docs", toolName: "search" },
      ],
    });
    assert.deepEqual(channel.mcpTools, [{ serviceSlug: "docs", toolName: "search" }]);
    assert.deepEqual(getChannel(channel.id, { includeDisabled: true })?.mcpTools, [
      { serviceSlug: "docs", toolName: "search" },
    ]);

    const updated = updateChannel(channel.id, {
      mcpTools: [{ serviceSlug: "crm", toolName: "lead" }],
    });
    assert.deepEqual(updated?.mcpTools, [{ serviceSlug: "crm", toolName: "lead" }]);

    // 未提供 mcpTools 时保留已存值。
    const kept = updateChannel(channel.id, { name: "改名" });
    assert.deepEqual(kept?.mcpTools, [{ serviceSlug: "crm", toolName: "lead" }]);
  });

  it("rejects invalid mcpTools entries", () => {
    assert.throws(() =>
      createChannel({
        name: "坏工具",
        platform: "dingtalk",
        appId: "ding_client",
        mcpTools: [{ serviceSlug: "", toolName: "search" }],
      }),
    );
    assert.throws(() =>
      createChannel({
        name: "坏工具",
        platform: "dingtalk",
        appId: "ding_client",
        mcpTools: [{ serviceSlug: "docs" } as never],
      }),
    );
  });

  it("defaults mcpTools to an empty array", () => {
    const channel = createChannel({ name: "空", platform: "feishu", appId: "cli_empty" });
    assert.deepEqual(channel.mcpTools, []);
    assert.deepEqual(listChannels()[0]?.mcpTools, []);
  });
});

function maskOf(value: string): string {
  return value.length < 8 ? "***" : `${value.slice(0, 2)}***${value.slice(-3)}`;
}
