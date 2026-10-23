import assert from "node:assert/strict";
import { test } from "node:test";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { PostgresMcpManagementRepository } from "./postgres-repository.js";
import { PostgresAuditRepository } from "./postgres-audit-repository.js";
import * as schema from "./schema.js";

type Row = Record<string, unknown>;
function mockDatabase(data: Record<string, { table: PgTable; rows: Row[] }>) {
  const queries: string[] = [];
  const client = {
    async query(config: { text: string }, params: unknown[]) {
      queries.push(config.text);
      const name = Object.keys(data).find((key) => config.text.includes(`from "${key}"`));
      assert.ok(name, config.text);
      const { table, rows } = data[name]!;
      const columns = Object.keys(getTableColumns(table));
      const key =
        name === "mcp_service_versions" && !config.text.includes('"mcp_service_versions"."id" =')
          ? "serviceId"
          : name === "mcp_tools" || name === "mcp_prompts"
            ? "versionId"
            : "id";
      const selected = rows.filter((row) => params.includes(row[key]));
      if (config.text.includes("order by")) {
        if (key === "serviceId")
          selected.sort((a, b) => Number(b.versionNumber) - Number(a.versionNumber));
        else selected.sort((a, b) => Number(a.position) - Number(b.position));
      }
      return { rows: selected.map((row) => columns.map((column) => row[column] ?? null)) };
    },
  };
  return { database: drizzle(client as unknown as Pool, { schema }), queries };
}

test("版本列表固定三次查询，保持版本/配置顺序及空版本", async () => {
  const versions = [1, 2, 3].map((number) => ({
    id: `v${number}`,
    serviceId: "service",
    versionNumber: number,
    status: "DRAFT",
    runtimeName: "nodejs",
    runtimeVersion: "20",
    limits: {},
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }));
  const { database, queries } = mockDatabase({
    mcp_service_versions: { table: schema.mcpServiceVersions, rows: versions },
    mcp_tools: {
      table: schema.mcpTools,
      rows: [
        {
          id: "tool-2",
          versionId: "v3",
          name: "second",
          position: 1,
          handler: "run",
          inputSchema: {},
        },
        {
          id: "tool-1",
          versionId: "v3",
          name: "first",
          position: 0,
          handler: "run",
          inputSchema: {},
        },
        { id: "other", versionId: "unrelated", name: "private", position: 0 },
      ],
    },
    mcp_prompts: {
      table: schema.mcpPrompts,
      rows: [
        {
          id: "prompt-1",
          versionId: "v1",
          name: "prompt",
          position: 0,
          arguments: [],
          messages: [],
        },
      ],
    },
  });
  const repository = new PostgresMcpManagementRepository(database);
  const result = await repository.listVersions("service");
  assert.equal(queries.length, 3);
  assert.deepEqual(
    result.map((version) => version.id),
    ["v3", "v2", "v1"],
  );
  assert.deepEqual(
    result[0]?.tools.map((tool) => tool.name),
    ["first", "second"],
  );
  assert.equal(result[1]?.tools.length, 0);
  assert.equal(result[1]?.prompts.length, 0);
  assert.equal(result[2]?.prompts[0]?.name, "prompt");
  assert.equal(Object.hasOwn(result[0]!.tools[0]!, "description"), false);
  const before = queries.length;
  assert.deepEqual(await repository.listVersions("missing"), []);
  assert.equal(queries.length - before, 1);
  const version = await repository.getVersion("v3");
  assert.deepEqual(version, result[0]);
});

test("审计详情批量只查一次，保留输入顺序并忽略缺失项", async () => {
  const { database, queries } = mockDatabase({
    mcp_audit_events: { table: schema.mcpAuditEvents, rows: [{ id: "a" }, { id: "b" }] },
  });
  const repository = new PostgresAuditRepository(database);
  assert.deepEqual(
    (await repository.getMany(["b", "gone", "a"])).map((event) => event.id),
    ["b", "a"],
  );
  assert.equal(queries.length, 1);
  assert.deepEqual(await repository.getMany([]), []);
  assert.equal(queries.length, 1);
});
