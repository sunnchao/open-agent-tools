import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SchemaCatalog } from "@open-agent-tools/schema-catalog";
import {
  detectIntent,
  detectRowLimitIntent,
  loadCatalog,
  buildSchemaInjection,
  rowLimitClarifying,
} from "./schema-inject.js";

const originalCatalogPath = process.env.SCHEMA_CATALOG_PATH;
let fixtureDirectory: string;
before(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "schema-injection-"));
  const collectedAt = "2026-01-01T00:00:00.000Z";
  const fixture: SchemaCatalog = {
    source: "mysql",
    database: "fixture",
    collectedAt,
    tables: ["users", "tokens", "logs"].map((name) => ({
      table: { name, schema: "fixture", collectedAt, comment: name === "users" ? "用户" : name },
      columns: (name === "users" ? ["id", "username", "display_name"] : ["id"]).map((column) => ({
        table: name,
        schema: "fixture",
        name: column,
        columnType: "varchar(64)",
        nullable: false,
        isPrimary: column === "id",
        isUnique: false,
        hasIndex: false,
        sensitivity: "normal",
        tier: "common",
        comment: column === "username" ? "登录名" : column,
      })),
      relations: [],
      enums: [],
      samples: [],
    })),
  };
  process.env.SCHEMA_CATALOG_PATH = join(fixtureDirectory, "catalog.json");
  writeFileSync(process.env.SCHEMA_CATALOG_PATH, JSON.stringify(fixture));
});
after(() => {
  if (originalCatalogPath === undefined) delete process.env.SCHEMA_CATALOG_PATH;
  else process.env.SCHEMA_CATALOG_PATH = originalCatalogPath;
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

test("loadCatalog 能从配置路径加载 enriched catalog", () => {
  const catalog = loadCatalog();
  assert.ok(catalog, "catalog 应可加载");
  assert.deepEqual(
    catalog.tables.map((entry) => entry.table.name),
    ["users", "tokens", "logs"],
  );
  // 验证字典增强生效：users 表有注释
  const users = catalog.tables.find((t) => t.table.name === "users");
  assert.ok(users?.table.comment?.includes("用户"));
});

test("detectRowLimitIntent 区分指定条数、查询全部和未指定", () => {
  assert.deepEqual(detectRowLimitIntent("查询最近10个使用兑换码的用户"), {
    kind: "limited",
    limit: 10,
  });
  assert.deepEqual(detectRowLimitIntent("看前二十条订单"), { kind: "limited", limit: 20 });
  assert.deepEqual(detectRowLimitIntent("查询所有使用兑换码的用户"), { kind: "all" });
  assert.deepEqual(detectRowLimitIntent("查询使用兑换码的用户"), { kind: "unspecified" });
  assert.deepEqual(detectRowLimitIntent("100"), { kind: "limited", limit: 100 });
  assert.deepEqual(detectRowLimitIntent("全部"), { kind: "all" });
  assert.deepEqual(detectRowLimitIntent("查询最近五百个用户"), { kind: "unspecified" });
  assert.deepEqual(detectRowLimitIntent("查询使用兑换码的用户\n100"), {
    kind: "limited",
    limit: 100,
  });
  assert.deepEqual(detectRowLimitIntent("查询使用兑换码的用户\n全部"), { kind: "all" });
  assert.match(rowLimitClarifying(), /默认返回最近 100 条/);
});

test("detectIntent 识别日志/用户/渠道/订单意图", () => {
  assert.equal(detectIntent("查询上个星期的消费日志"), "log_query");
  assert.equal(detectIntent("看看有哪些用户"), "user_query");
  assert.equal(detectIntent("DeepSeek 渠道的调用量"), "channel_query");
  assert.equal(detectIntent("最近订单充值情况"), "order_query");
  assert.equal(detectIntent("帮我查下额度消耗"), "quota_query");
  assert.equal(detectIntent("今天天气怎么样"), undefined);
});

test("用户查询场景注入的 schema 包含 username（防止 LLM 误用 display_name）", () => {
  const inj = buildSchemaInjection("查询用户 root 的消费次数");
  assert.ok(inj.tableNames.includes("users"));
  assert.ok(inj.selected.includes("username"), "users 表渲染必须包含 username");
  assert.ok(inj.selected.includes("登录名"), "username 应有登录名注释");
  assert.ok(inj.selected.includes("display_name"), "display_name 也在注入列中（对照）");
});
