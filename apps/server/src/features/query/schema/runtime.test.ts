import { test } from "node:test";
import assert from "node:assert/strict";
import { inferReferences, matchTableNames } from "./runtime.js";
import type { SchemaCatalog, TableCatalog } from "@open-agent-tools/schema-catalog";

function table(name: string, columns: string[]): TableCatalog {
  return {
    table: { name, schema: "oneapi", collectedAt: "", comment: name },
    columns: columns.map((col) => ({
      table: name,
      schema: "oneapi",
      name: col,
      columnType: "bigint",
      nullable: true,
      isPrimary: col === "id",
      isUnique: col === "id",
      hasIndex: col.endsWith("_id") || col === "id",
      sensitivity: "normal",
      tier: "required",
    })),
    relations: [],
    enums: [],
    samples: [],
  };
}

function catalog(tables: TableCatalog[]): SchemaCatalog {
  return {
    source: "mysql",
    database: "oneapi",
    collectedAt: "",
    tables,
  };
}

test("inferReferences：user_id / channel_id / token_id 指向对应表", () => {
  const refs = inferReferences(
    catalog([
      table("users", ["id"]),
      table("channels", ["id"]),
      table("tokens", ["id", "user_id"]),
      table("logs", ["id", "user_id", "channel_id", "token_id"]),
    ]),
  );
  const keys = refs.map((r) => `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`).sort();
  assert.deepEqual(keys, [
    "logs.channel_id->channels.id",
    "logs.token_id->tokens.id",
    "logs.user_id->users.id",
    "tokens.user_id->users.id",
  ]);
});

test("inferReferences：不把表连到自己", () => {
  const refs = inferReferences(catalog([table("users", ["id", "user_id"])]));
  assert.equal(refs.length, 0);
});

test("matchTableNames：中文别名命中表", () => {
  assert.deepEqual(
    matchTableNames("最近消费日志最多的模型", ["logs", "users", "channels"], "oneapi"),
    ["logs"],
  );
  assert.deepEqual(matchTableNames("启用状态的用户有多少", ["logs", "users"], "oneapi"), ["users"]);
});
