/**
 * NEW-API 业务字典增强 CLI（离线，不需要数据库连接）：
 *   读取 schema-catalog.json → 合并表/字段注释 + 枚举含义 → 写回。
 *
 *   pnpm --filter @open-agent-tools/schema-catalog enrich-newapi \
 *     --in schema-catalog.json --out schema-catalog.enriched.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { enrichNewApiCatalog } from "../src/dict/newapi.js";
import type { SchemaCatalog } from "../src/types.js";

function argValue(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const input = argValue(args, "--in") ?? "schema-catalog.json";
  const output = argValue(args, "--out") ?? input; // 默认原地增强

  const raw = await readFile(input, "utf8");
  const catalog = JSON.parse(raw) as SchemaCatalog;
  const enriched = enrichNewApiCatalog(catalog);

  const tableWithComment = enriched.tables.filter((t) => t.table.comment).length;
  const enumCols = enriched.tables.reduce((n, t) => n + t.enums.filter((e) => e.values.length > 0).length, 0);
  const sensitiveCols = enriched.tables.reduce((n, t) => n + t.columns.filter((c) => c.sensitivity === "sensitive").length, 0);

  await writeFile(output, JSON.stringify(enriched, null, 2), "utf8");
  console.log(`[enrich-newapi] 完成：${enriched.tables.length} 张表`);
  console.log(`  表注释: ${tableWithComment}/${enriched.tables.length}`);
  console.log(`  枚举列: ${enumCols} 个（含含义）`);
  console.log(`  敏感字段: ${sensitiveCols} 个（默认不注入）`);
  console.log(`  已写入: ${output}`);
}

main().catch((err) => {
  console.error("[enrich-newapi] 失败：", err);
  process.exit(1);
});
