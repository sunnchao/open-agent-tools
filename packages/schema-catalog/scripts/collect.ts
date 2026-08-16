/**
 * MySQL Schema 采集 CLI：
 *   MYSQL_URL=mysql://user:pass@host:3306/mydb pnpm --filter @open-agent-tools/schema-catalog collect [--out catalog.json] [--filter report_%] [--skip-samples]
 */
import { writeFile } from "node:fs/promises";
import { collectMysqlCatalog } from "../src/collector/mysqlCollector.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  const out = argValue(args, "--out") ?? "schema-catalog.json";
  const filter = argValue(args, "--filter")?.split(",").filter(Boolean);
  const skipSamples = args.includes("--skip-samples");

  const connectionString = process.env.MYSQL_URL ?? env("MYSQL_DATABASE_URL");
  console.log(`[collect] 开始采集 ${connectionString.replace(/:[^:@/]+@/, ":***@")}`);
  const started = Date.now();
  const catalog = await collectMysqlCatalog({
    connectionString,
    ...(filter ? { tableFilter: filter } : {}),
    skipSamples,
  });
  await writeFile(out, JSON.stringify(catalog, null, 2), "utf8");
  console.log(
    `[collect] 完成：${catalog.tables.length} 张表，耗时 ${Date.now() - started}ms，已写入 ${out}`,
  );
  const tables = catalog.tables.map((t) => t.table.name).join(", ");
  console.log(`[collect] 表清单：${tables || "(空)"}`);
}

function argValue(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}

main().catch((err) => {
  console.error("[collect] 失败：", err);
  process.exit(1);
});
